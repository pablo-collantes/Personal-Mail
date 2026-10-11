import { DurableObject } from "cloudflare:workers";
import { normalizeAddress } from "./address";
import { CategoryStore, type CategoryWork, type ClassifierBudget } from "./category-store";
import { categorizeInbox, type SweepAnswer, type SweepOutcome } from "./classifier";
import { attachmentKeys, blobKeys, rawKey } from "./ids";
import { MailApi, type MailStore } from "./jmap/mail";
import type { JmapRequest, JmapResponse } from "./jmap/protocol";
import { migrate } from "./schema";
import { Sorting, type VipDraft } from "./sorting";
import { toFtsQuery } from "./text";
import {
  DEFAULT_SETTINGS,
  type AddressEntry,
  type AliasInfo,
  type AttachmentMeta,
  type AuthVerdict,
  type CategoryInfo,
  type CategorySender,
  type ClassifierStatus,
  type Folder,
  type FolderInfo,
  type IngestRecord,
  type IngestResult,
  type ListQuery,
  type MessageDetail,
  type MessageSummary,
  type RuleDraft,
  type RuleFailure,
  type Settings,
  type SortRule,
  type SortRuleKind,
  type StayedPut,
  type VipRule,
  type VipRuleKind,
} from "./types";

const DAY_MS = 86_400_000;

/** Where the Worker opens a push socket (Mailbox.fetch). */
export const PUSH_PATH = "/push";
/** Keep-alive on a push socket, answered by the runtime without waking the Mailbox. */
export const PUSH_PING = "ping";
export const PUSH_PONG = "pong";
/** At most one push per this long; the changes in between go out together (see announce). */
export const PUSH_INTERVAL_MS = 1000;
/** A sweep that stopped with mail still waiting for the classifier carries on this soon (alarm). */
const SWEEP_CONTINUE_MS = 2000;
const R2_DELETE_BATCH = 1000;
const SWEEP_BATCH = 500;

type MessageRow = {
  seq: number;
  id: string;
  received_at: number;
  envelope_from: string;
  alias: string;
  folder: string;
  seen: number;
  flagged: number;
  vip_rule_id: number | null;
  auth: string;
  message_id: string | null;
  in_reply_to: string | null;
  refs: string | null;
  subject: string;
  from_name: string | null;
  from_address: string | null;
  to_json: string;
  cc_json: string;
  reply_to_json: string;
  sent_at: number | null;
  preview: string;
  size: number;
  has_html: number;
  attachment_count: number;
  blobs_expired: number;
  auth_results: string | null;
  list_id: string | null;
  list_unsubscribe: string | null;
  parse_error: string | null;
};

type AttachmentRow = {
  idx: number;
  filename: string | null;
  mime_type: string;
  size: number;
  disposition: string | null;
  content_id: string | null;
};

type AliasRow = {
  address: string;
  label: string | null;
  status: string;
  created_at: number;
  first_seen_at: number | null;
  last_seen_at: number | null;
  message_count: number;
};

type Doomed = { seq: number; id: string; attachment_count: number };

/**
 * One mailbox: every message's metadata, text and search index, plus the
 * alias, VIP, sorting and settings tables. Raw messages, HTML bodies and
 * attachments live in R2 under keys derived from the message id (see ids.ts).
 */
export class Mailbox extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.transactionSync(() => migrate(ctx.storage.sql));
      // Mail from before Inbox categories gets its quick guess, once: new mail gets one as it arrives.
      ctx.storage.transactionSync(() => {
        while (this.categories.fillGuesses() > 0);
      });
    });
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PUSH_PING, PUSH_PONG));
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  // ---- Intake ----

  /** Asked at SMTP time, before anything is stored: take mail for this address? */
  admit(address: string): "accept" | "reject" {
    const alias = this.sql
      .exec<{ status: string }>("SELECT status FROM aliases WHERE address = ?", normalizeAddress(address))
      .toArray()[0];
    if (alias) return alias.status === "blocked" ? "reject" : "accept";
    return this.getSettings().aliasMode === "locked" ? "reject" : "accept";
  }

  async ingest(record: IngestRecord): Promise<IngestResult> {
    if (this.sql.exec("SELECT 1 FROM messages WHERE id = ?", record.id).toArray().length) return { status: "duplicate" };
    if (this.sql.exec("SELECT 1 FROM deleted WHERE id = ?", record.id).toArray().length) {
      // Its blobs were written again (a late redelivery): delete them again.
      this.sql.exec("UPDATE deleted SET blobs_cleared = 0 WHERE id = ?", record.id);
      await this.sweepDeleted();
      return { status: "dropped", reason: "deleted" };
    }

    const alias = normalizeAddress(record.alias);
    const aliasStatus = this.sql
      .exec<{ status: string }>("SELECT status FROM aliases WHERE address = ?", alias)
      .toArray()[0]?.status;
    if (aliasStatus === "blocked") {
      // Blocked while this message was queued: discard it like a purge would.
      this.ctx.storage.transactionSync(() =>
        this.tombstone(record.id, blobKeys(record.id, record.attachments.length), Date.now()),
      );
      await this.sweepDeleted();
      return { status: "dropped", reason: "alias-blocked" };
    }

    // The account's own sent mail goes to Sent, read, and stays there: rules only move auto-filed mail.
    const { folder, vipRuleId, sortRuleId, notify } = record.sent
      ? { folder: "sent", vipRuleId: null, sortRuleId: null, notify: false }
      : this.sorting.classify({
          fromAddress: record.from?.address ?? null,
          alias,
          recipients: [...record.to, ...record.cc].map((a) => a.address),
          auth: record.auth,
          upstreamSpam: record.spam?.isSpam ?? false,
        });
    // Its Inbox category: the user's word for the sender, or a quick guess the classifier checks later.
    const category = record.sent
      ? { category: null, by: "none" }
      : this.categories.forNew(record.from?.address ?? null, {
          fromAddress: record.from?.address ?? null,
          subject: record.subject,
          preview: record.preview,
          listId: record.listId,
          listUnsubscribe: record.listUnsubscribe,
          vip: vipRuleId !== null,
        });

    this.ctx.storage.transactionSync(() => {
      const modseq = this.nextModseq();
      // An alias's first and last mail is mail it received.
      if (!record.sent) {
        this.sql.exec(
          `INSERT INTO aliases (address, created_at, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (address) DO UPDATE SET
             first_seen_at = coalesce(first_seen_at, excluded.first_seen_at),
             last_seen_at = max(coalesce(last_seen_at, 0), excluded.last_seen_at)`,
          alias,
          Date.now(),
          record.receivedAt,
          record.receivedAt,
        );
      }
      const { seq } = this.sql
        .exec<{ seq: number }>(
          `INSERT INTO messages (
             id, received_at, envelope_from, alias, folder, auto_filed, seen, vip_rule_id, sort_rule_id, auth,
             spam_flag, spam_score, message_id, in_reply_to, refs, subject, from_name, from_address,
             to_json, cc_json, reply_to_json, sent_at, preview, size, has_html,
             attachment_count, auth_results, list_id, list_unsubscribe, parse_error,
             category, category_by, created_modseq, updated_modseq
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           RETURNING seq`,
          record.id,
          record.receivedAt,
          record.envelopeFrom,
          alias,
          folder,
          record.sent ? 0 : 1,
          record.sent ? 1 : 0,
          vipRuleId,
          sortRuleId,
          record.auth,
          record.spam ? Number(record.spam.isSpam) : null,
          record.spam?.score ?? null,
          record.messageId,
          record.inReplyTo,
          record.references,
          record.subject,
          record.from?.name || null,
          record.from ? record.from.address.toLowerCase() : null,
          JSON.stringify(record.to),
          JSON.stringify(record.cc),
          JSON.stringify(record.replyTo),
          record.sentAt,
          record.preview,
          record.size,
          record.hasHtml ? 1 : 0,
          record.attachments.length,
          record.authResults,
          record.listId,
          record.listUnsubscribe,
          record.parseError,
          category.category,
          category.by,
          modseq,
          modseq,
        )
        .one();
      for (const a of record.attachments) {
        this.sql.exec(
          `INSERT INTO attachments (message_seq, idx, filename, mime_type, size, disposition, content_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          seq,
          a.idx,
          a.filename,
          a.mimeType,
          a.size,
          a.disposition,
          a.contentId,
        );
      }
      this.sql.exec(
        "INSERT INTO messages_fts (rowid, subject, sender, recipients, body, attachments) VALUES (?, ?, ?, ?, ?, ?)",
        seq,
        record.subject,
        record.from ? `${record.from.name} ${record.from.address}` : record.envelopeFrom,
        [alias, ...[...record.to, ...record.cc].map((a) => `${a.name} ${a.address}`)].join(" "),
        record.text,
        record.attachments.map((a) => a.filename ?? "").join(" "),
      );
    });

    return { status: "stored", folder, notify, auth: record.auth };
  }

  /** Of these ids, which are neither indexed nor deleted? (Used by reconcile.) */
  unindexed(ids: string[]): string[] {
    return ids.filter(
      (id) =>
        !this.sql.exec("SELECT 1 FROM messages WHERE id = ?", id).toArray().length &&
        !this.sql.exec("SELECT 1 FROM deleted WHERE id = ?", id).toArray().length,
    );
  }

  // ---- Reading ----

  listMessages(query: ListQuery = {}): MessageSummary[] {
    const where: string[] = [];
    const params: SqlStorageValue[] = [];
    if (query.folder !== undefined) {
      if (!this.sorting.mailboxExists(query.folder)) throw new Error(`unknown folder: ${query.folder}`);
      where.push("m.folder = ?");
      params.push(query.folder);
    }
    if (query.alias !== undefined) {
      where.push("m.alias = ?");
      params.push(normalizeAddress(query.alias));
    }
    if (query.before !== undefined) {
      const at = this.sql
        .exec<{ seq: number; received_at: number }>("SELECT seq, received_at FROM messages WHERE id = ?", query.before)
        .toArray()[0];
      if (!at) return [];
      where.push("(m.received_at < ? OR (m.received_at = ? AND m.seq < ?))");
      params.push(at.received_at, at.received_at, at.seq);
    }
    const fts = query.text ? toFtsQuery(query.text) : null;
    if (fts) {
      where.push("messages_fts MATCH ?");
      params.push(fts);
    }
    const source = fts ? "messages_fts JOIN messages m ON m.seq = messages_fts.rowid" : "messages m";
    const limit = Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 200);
    return this.sql
      .exec<MessageRow>(
        `SELECT m.* FROM ${source} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY m.received_at DESC, m.seq DESC LIMIT ?`,
        ...params,
        limit,
      )
      .toArray()
      .map(toSummary);
  }

  getMessage(id: string): MessageDetail | null {
    const row = this.sql.exec<MessageRow>("SELECT * FROM messages WHERE id = ?", id).toArray()[0];
    if (!row) return null;
    const attachments = this.sql
      .exec<AttachmentRow>("SELECT * FROM attachments WHERE message_seq = ? ORDER BY idx", row.seq)
      .toArray()
      .map(
        (a): AttachmentMeta => ({
          idx: a.idx,
          filename: a.filename,
          mimeType: a.mime_type,
          size: a.size,
          disposition: a.disposition,
          contentId: a.content_id,
        }),
      );
    const text =
      this.sql.exec<{ body: string }>("SELECT body FROM messages_fts WHERE rowid = ?", row.seq).toArray()[0]?.body ?? "";
    return {
      ...toSummary(row),
      envelopeFrom: row.envelope_from,
      to: JSON.parse(row.to_json) as AddressEntry[],
      cc: JSON.parse(row.cc_json) as AddressEntry[],
      replyTo: JSON.parse(row.reply_to_json) as AddressEntry[],
      messageId: row.message_id,
      inReplyTo: row.in_reply_to,
      references: row.refs,
      text,
      hasHtml: row.has_html === 1,
      attachments,
      blobsExpired: row.blobs_expired === 1,
      authResults: row.auth_results,
      listId: row.list_id,
      listUnsubscribe: row.list_unsubscribe,
      parseError: row.parse_error,
    };
  }

  // ---- Changing ----

  /** A change by the user. Moving a message files it by hand, so rules leave it alone from then on. */
  updateMessage(id: string, patch: { folder?: Folder; seen?: boolean; flagged?: boolean }): boolean {
    if (patch.folder !== undefined && !this.sorting.mailboxExists(patch.folder)) {
      throw new Error(`unknown folder: ${patch.folder}`);
    }
    return this.ctx.storage.transactionSync(() => {
      const row = this.sql
        .exec<{ folder: string; from_address: string | null }>("SELECT folder, from_address FROM messages WHERE id = ?", id)
        .toArray()[0];
      if (!row) return false;
      const moving = patch.folder !== undefined && patch.folder !== row.folder;
      const modseq = this.nextModseq();
      this.sql.exec(
        `UPDATE messages SET
           folder = coalesce(?, folder),
           auto_filed = CASE WHEN ? THEN 0 ELSE auto_filed END,
           seen = coalesce(?, seen),
           flagged = coalesce(?, flagged),
           updated_modseq = ?
         WHERE id = ?`,
        patch.folder ?? null,
        moving ? 1 : 0,
        patch.seen === undefined ? null : Number(patch.seen),
        patch.flagged === undefined ? null : Number(patch.flagged),
        modseq,
        id,
      );
      if (moving) this.sorting.learnFromMoves([{ fromAddress: row.from_address, from: row.folder, to: patch.folder! }]);
      return true;
    });
  }

  /** Permanently deletes messages: rows, search index and every R2 blob. */
  async deleteMessages(ids: string[]): Promise<number> {
    return (await this.destroy(ids)).length;
  }

  /** Deletes messages and returns the ids that existed. */
  private async destroy(ids: string[]): Promise<string[]> {
    const doomed = [...new Set(ids)].flatMap((id) =>
      this.sql.exec<Doomed>("SELECT seq, id, attachment_count FROM messages WHERE id = ?", id).toArray(),
    );
    this.ctx.storage.transactionSync(() => this.remove(doomed, Date.now()));
    await this.sweepAllDeleted();
    return doomed.map((d) => d.id);
  }

  /** Blocks an alias (future mail is rejected at SMTP) and permanently deletes everything it received. */
  async purgeAlias(address: string): Promise<number> {
    const alias = normalizeAddress(address);
    const doomed = this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO aliases (address, status, created_at) VALUES (?, 'blocked', ?)
         ON CONFLICT (address) DO UPDATE SET status = 'blocked'`,
        alias,
        Date.now(),
      );
      const rows = this.sql
        .exec<Doomed>("SELECT seq, id, attachment_count FROM messages WHERE alias = ?", alias)
        .toArray();
      this.remove(rows, Date.now());
      return rows;
    });
    await this.sweepAllDeleted();
    return doomed.length;
  }

  // ---- JMAP ----

  /** Runs a JMAP request (RFC 8620/8621) against this mailbox. */
  jmap(request: JmapRequest, accountId: string): Promise<JmapResponse> {
    return new MailApi(this.mailStore(), accountId).run(request);
  }

  /** Current state per JMAP type, for push. Threads change exactly when emails do. */
  jmapStates(): Record<string, string> {
    const state = new MailApi(this.mailStore(), "").state();
    return { Email: state, Mailbox: state, Thread: state };
  }

  // ---- Push ----

  /**
   * A push socket for one open EventSource stream (http/eventsource.ts). It
   * hears the current states at once and again after every change, and in
   * between this object hibernates: an open stream costs no requests and no
   * duration while no mail comes or goes. Its keep-alive pings are answered
   * by the runtime without waking us (setWebSocketAutoResponse above).
   */
  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname !== PUSH_PATH || request.headers.get("Upgrade") !== "websocket") {
      return new Response("Not found", { status: 404 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify(this.jmapStates()));
    return new Response(null, { status: 101, webSocket: client });
  }

  override webSocketMessage(): void {
    // Nothing is listened for: the only message, the ping, never gets here.
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // Already closed (the runtime may answer the close itself).
    }
  }

  private announcing = false;
  private lastPush = 0;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Once the change in progress has run its synchronous course, tells every push socket the new
   * states: at once if nothing went out in the last PUSH_INTERVAL_MS, otherwise when that has
   * passed. Every push makes every client read its lists again, so a burst of changes (an import,
   * a dozen rules) must reach them as one push carrying the latest state, not one per message.
   */
  private announce(): void {
    if (this.announcing || this.pushTimer) return;
    this.announcing = true;
    queueMicrotask(() => {
      this.announcing = false;
      const wait = this.lastPush + PUSH_INTERVAL_MS - Date.now();
      if (wait <= 0) return this.push();
      this.pushTimer = setTimeout(() => {
        this.pushTimer = null;
        this.push();
      }, wait);
    });
  }

  private push(): void {
    this.lastPush = Date.now();
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const message = JSON.stringify(this.jmapStates());
    for (const ws of sockets) {
      try {
        ws.send(message);
      } catch {
        // Closing; webSocketClose tidies up.
      }
    }
  }

  /** The plain-text body served as a blob, or null if there is no such message. */
  bodyText(id: string): string | null {
    const seq = this.seqOf(id);
    return seq === null ? null : new MailApi(this.mailStore(), "").bodyText(seq);
  }

  private mailStore(): MailStore {
    return {
      sql: this.sql,
      bucket: this.env.MAIL_BUCKET,
      transaction: (fn) => this.ctx.storage.transactionSync(fn),
      nextModseq: () => this.nextModseq(),
      destroy: (ids) => this.destroy(ids),
      sorting: this.sorting,
    };
  }

  private get sorting(): Sorting {
    return new Sorting({ sql: this.sql, nextModseq: () => this.nextModseq(), settings: () => this.getSettings() });
  }

  private get categories(): CategoryStore {
    return new CategoryStore({
      sql: this.sql,
      nextModseq: () => this.nextModseq(),
      inboxView: () => ["inbox", ...this.sorting.inboxShows()],
    });
  }

  // ---- Aliases ----

  listAliases(): AliasInfo[] {
    return this.sql
      .exec<AliasRow>(
        `SELECT a.*, (SELECT count(*) FROM messages m WHERE m.alias = a.address) AS message_count
         FROM aliases a ORDER BY coalesce(a.last_seen_at, a.created_at) DESC`,
      )
      .toArray()
      .map((a) => ({
        address: a.address,
        label: a.label,
        status: a.status === "blocked" ? "blocked" : "active",
        createdAt: a.created_at,
        firstSeenAt: a.first_seen_at,
        lastSeenAt: a.last_seen_at,
        messageCount: a.message_count,
      }));
  }

  /** Creates or edits an alias. Unblocking is `status: "active"`. */
  setAlias(address: string, patch: { label?: string | null; status?: "active" | "blocked" }): void {
    if (patch.status !== undefined && patch.status !== "active" && patch.status !== "blocked") {
      throw new Error("status must be 'active' or 'blocked'");
    }
    const alias = normalizeAddress(address);
    if (!alias.includes("@")) throw new Error(`not an address: ${address}`);
    this.sql.exec(
      `INSERT INTO aliases (address, label, status, created_at) VALUES (?, ?, coalesce(?, 'active'), ?)
       ON CONFLICT (address) DO UPDATE SET
         label = CASE WHEN ? THEN excluded.label ELSE label END,
         status = coalesce(?, status)`,
      alias,
      patch.label ?? null,
      patch.status ?? null,
      Date.now(),
      patch.label !== undefined ? 1 : 0,
      patch.status ?? null,
    );
  }

  // ---- VIP and sorting rules (see sorting.ts) ----

  listVipRules(): VipRule[] {
    return this.sorting.vipRules();
  }

  addVipRule(kind: VipRuleKind, value: string, label: string | null = null): VipRule {
    return this.addVip(kind, value, label).vip;
  }

  /** Adds a VIP rule; this sender's verified mail filed earlier moves to VIP (without notifying). */
  addVip(kind: VipRuleKind, value: string, label: string | null = null): { vip: VipRule; moved: number; stayed: StayedPut } {
    return this.ctx.storage.transactionSync(() => this.sorting.addVip(kind, value, label));
  }

  /** Adds several VIP rules in one go: one re-sort, one push. */
  addVips(drafts: VipDraft[]): { vips: VipRule[]; moved: number; failed: RuleFailure[]; stayed: StayedPut } {
    return this.ctx.storage.transactionSync(() => this.sorting.addVips(drafts));
  }

  /** Removes a VIP rule; the mail it filed is sorted again. */
  removeVip(id: number): { removed: boolean; moved: number } {
    return this.ctx.storage.transactionSync(() => this.sorting.removeVip(id));
  }

  listSortRules(): SortRule[] {
    return this.sorting.sortRules();
  }

  /** "Always file this sender, domain, recipient or +tag into that folder"; matching mail filed earlier moves now. */
  addSortRule(kind: SortRuleKind, value: string, folder: Folder): { rule: SortRule; moved: number; stayed: StayedPut } {
    return this.ctx.storage.transactionSync(() => this.sorting.addSortRule(kind, value, folder));
  }

  /** Several rules into one folder in one go ("these 13 senders"): one re-sort, one push. */
  addSortRules(drafts: RuleDraft[], folder: Folder): { rules: SortRule[]; moved: number; failed: RuleFailure[]; stayed: StayedPut } {
    return this.ctx.storage.transactionSync(() => this.sorting.addSortRules(drafts, folder));
  }

  removeSortRule(id: number): { removed: boolean; moved: number } {
    return this.ctx.storage.transactionSync(() => this.sorting.removeSortRule(id));
  }

  // ---- Folders shown in the Inbox ----

  listFolders(): FolderInfo[] {
    return this.sorting.folders();
  }

  /** Lists a folder's mail in the clients' Inbox view too, or stops (VIP and the user's own folders). */
  setShowInInbox(id: Folder, show: boolean): FolderInfo {
    return this.ctx.storage.transactionSync(() => this.sorting.setShowInInbox(id, show));
  }

  // ---- Inbox categories (categories.ts, category-store.ts) ----

  listCategories(): CategoryInfo[] {
    return this.categories.list();
  }

  /** One of the user's own categories, described in plain words for the classifier. */
  addCategory(draft: { name?: unknown; description?: unknown; color?: unknown }): CategoryInfo {
    return this.ctx.storage.transactionSync(() => this.categories.create(draft));
  }

  updateCategory(id: string, patch: { name?: unknown; description?: unknown; color?: unknown }): CategoryInfo {
    return this.ctx.storage.transactionSync(() => this.categories.update(id, patch));
  }

  /** Removes one of the user's own categories; its mail gets a quick guess again. */
  removeCategory(id: string): { removed: boolean; moved: number } {
    return this.ctx.storage.transactionSync(() => this.categories.remove(id));
  }

  listCategorySenders(): CategorySender[] {
    return this.categories.senders();
  }

  /** "Categorize sender": this address's mail, past and future, goes in that category. */
  setCategorySender(address: string, category: string): { sender: CategorySender; moved: number } {
    return this.ctx.storage.transactionSync(() => this.categories.setSender(address, category));
  }

  removeCategorySender(address: string): { removed: boolean; moved: number } {
    return this.ctx.storage.transactionSync(() => this.categories.removeSender(address));
  }

  /** Guesses a batch of the mail from before categories; 0 once there's none left. */
  fillCategoryGuesses(limit?: number): number {
    return this.ctx.storage.transactionSync(() => this.categories.fillGuesses(limit));
  }

  /** The classifier's next batch, within today's allowance if it has one (null while another sweep holds the queue). */
  categoryWork(owner: string, limit: number, budget: ClassifierBudget | null = null, now?: number): CategoryWork | null {
    return this.ctx.storage.transactionSync(() => this.categories.work(owner, limit, budget, now));
  }

  applyCategories(owner: string, generation: number, answers: SweepAnswer[], now?: number): number {
    return this.ctx.storage.transactionSync(() => this.categories.apply(owner, generation, answers, now));
  }

  /**
   * Ends a sweep: notes how it went, lets the next one have the queue, and sets the alarm for the
   * next if mail is still waiting: soon when this one ran out of time, after the backoff when the
   * classifier couldn't be reached, at `wakeAt` when new mail waits for the allowance to reset.
   * Besides the backlog cron (index.ts), nothing else wakes this object for categories (see alarm).
   */
  async endCategorySweep(owner: string, outcome: SweepOutcome | null, more = false, wakeAt: number | null = null): Promise<void> {
    const retryAt = this.ctx.storage.transactionSync(() => {
      if (outcome) this.categories.noteClassifier(outcome);
      this.categories.release(owner);
      return this.categories.retryAt();
    });
    const next = outcome?.ok === false ? retryAt : more ? Date.now() + SWEEP_CONTINUE_MS : wakeAt;
    if (next === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(next);
  }

  /** After failed sweeps, when the classifier is worth asking again; null when it is now. */
  classifierRetryAt(): number | null {
    return this.categories.retryAt();
  }

  /**
   * The categories' clock: set by endCategorySweep while mail waits for the classifier, so a
   * backlog keeps going, a classifier that was down gets asked again, and new mail that found the
   * day's allowance spent is asked about once it resets. With nothing waiting, nothing is set and
   * this object sleeps.
   */
  override async alarm(): Promise<void> {
    try {
      await categorizeInbox(this.env, { mailbox: this });
    } catch (err) {
      console.error("category sweep failed", { error: String(err) });
    }
  }

  classifierStatus(configured: boolean, budget: ClassifierBudget | null = null, now?: number): ClassifierStatus {
    return this.categories.status(configured, budget, now);
  }

  // ---- Settings ----

  getSettings(): Settings {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'settings'").toArray()[0];
    return { ...DEFAULT_SETTINGS, ...(row ? (JSON.parse(row.value) as Partial<Settings>) : {}) };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next: Settings = { ...this.getSettings() };
    if (patch.aliasMode !== undefined) {
      if (patch.aliasMode !== "open" && patch.aliasMode !== "locked") throw new Error("aliasMode must be 'open' or 'locked'");
      next.aliasMode = patch.aliasMode;
    }
    if (patch.vipRequireAuth !== undefined) {
      if (typeof patch.vipRequireAuth !== "boolean") throw new Error("vipRequireAuth must be a boolean");
      next.vipRequireAuth = patch.vipRequireAuth;
    }
    if (patch.attachmentRetentionDays !== undefined) {
      const days = patch.attachmentRetentionDays;
      if (days !== null && !(Number.isInteger(days) && days >= 1)) {
        throw new Error("attachmentRetentionDays must be a whole number of days, or null to keep forever");
      }
      next.attachmentRetentionDays = days;
    }
    const before = this.getSettings();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('settings', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        JSON.stringify(next),
      );
      // Unverified VIP mail moves in or out of VIP.
      if (next.vipRequireAuth !== before.vipRequireAuth) this.sorting.resort("vip_rule_id IS NOT NULL");
    });
    return next;
  }

  // ---- Maintenance ----

  /** Hourly: finish pending blob deletes and apply attachment retention. */
  async maintain(now = Date.now()): Promise<{ blobsCleared: number; expired: number }> {
    const blobsCleared = await this.sweepAllDeleted();
    const expired = await this.expireBlobs(now);
    return { blobsCleared, expired };
  }

  private async expireBlobs(now: number): Promise<number> {
    const days = this.getSettings().attachmentRetentionDays;
    if (days === null) return 0;
    let total = 0;
    for (;;) {
      const rows = this.sql
        .exec<Doomed>(
          "SELECT seq, id, attachment_count FROM messages WHERE blobs_expired = 0 AND received_at < ? ORDER BY seq LIMIT ?",
          now - days * DAY_MS,
          SWEEP_BATCH,
        )
        .toArray();
      if (!rows.length) return total;
      // The HTML body stays so old mail still renders; the raw message goes
      // because it contains the attachments too.
      await this.deleteBlobs(rows.flatMap((r) => [rawKey(r.id), ...attachmentKeys(r.id, r.attachment_count)]));
      this.ctx.storage.transactionSync(() => {
        const modseq = this.nextModseq();
        for (const r of rows) {
          this.sql.exec("UPDATE messages SET blobs_expired = 1, updated_modseq = ? WHERE seq = ?", modseq, r.seq);
        }
      });
      total += rows.length;
    }
  }

  // ---- Internals ----

  private remove(rows: Doomed[], now: number): void {
    if (!rows.length) return;
    const modseq = this.nextModseq();
    for (const r of rows) {
      this.sql.exec("DELETE FROM messages_fts WHERE rowid = ?", r.seq);
      this.sql.exec("DELETE FROM attachments WHERE message_seq = ?", r.seq);
      this.sql.exec("DELETE FROM messages WHERE seq = ?", r.seq);
      this.tombstone(r.id, blobKeys(r.id, r.attachment_count), now, modseq);
    }
  }

  private tombstone(id: string, keys: string[], now: number, modseq = this.nextModseq()): void {
    this.sql.exec(
      `INSERT INTO deleted (id, deleted_at, modseq, blob_keys) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET blob_keys = excluded.blob_keys, blobs_cleared = 0`,
      id,
      now,
      modseq,
      JSON.stringify(keys),
    );
  }

  private async sweepDeleted(): Promise<number> {
    const rows = this.sql
      .exec<{ id: string; blob_keys: string }>(
        "SELECT id, blob_keys FROM deleted WHERE blobs_cleared = 0 LIMIT ?",
        SWEEP_BATCH,
      )
      .toArray();
    if (!rows.length) return 0;
    await this.deleteBlobs(rows.flatMap((r) => JSON.parse(r.blob_keys) as string[]));
    for (const r of rows) this.sql.exec("UPDATE deleted SET blobs_cleared = 1 WHERE id = ?", r.id);
    return rows.length;
  }

  private async sweepAllDeleted(): Promise<number> {
    let total = 0;
    for (let n = await this.sweepDeleted(); n > 0; n = await this.sweepDeleted()) total += n;
    return total;
  }

  private async deleteBlobs(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
      await this.env.MAIL_BUCKET.delete(keys.slice(i, i + R2_DELETE_BATCH));
    }
  }

  private nextModseq(): number {
    const { value } = this.sql
      .exec<{ value: string }>(
        `INSERT INTO meta (key, value) VALUES ('modseq', '1')
         ON CONFLICT (key) DO UPDATE SET value = CAST(value AS INTEGER) + 1
         RETURNING value`,
      )
      .one();
    this.announce();
    return Number(value);
  }

  private seqOf(id: string): number | null {
    return this.sql.exec<{ seq: number }>("SELECT seq FROM messages WHERE id = ?", id).toArray()[0]?.seq ?? null;
  }
}

function toSummary(r: MessageRow): MessageSummary {
  return {
    id: r.id,
    receivedAt: r.received_at,
    sentAt: r.sent_at,
    folder: r.folder,
    seen: r.seen === 1,
    flagged: r.flagged === 1,
    alias: r.alias,
    from: r.from_address ? { name: r.from_name ?? "", address: r.from_address } : null,
    subject: r.subject,
    preview: r.preview,
    size: r.size,
    attachmentCount: r.attachment_count,
    vip: r.vip_rule_id !== null,
    auth: r.auth as AuthVerdict,
  };
}
