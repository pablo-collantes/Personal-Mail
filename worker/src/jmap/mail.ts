import { htmlKey, rawKey } from "../ids";
import type { Sorting } from "../sorting";
import type { AddressEntry, Folder } from "../types";
import { asMessageIds, headerPropertyValue, parseHeaderProperty, readHeaderFields } from "./headers";
import { blobIdFor } from "./blobs";
import { highlight, snippet } from "../snippet";
import { compileFilter, compileSort, snippetWords } from "./query";
import {
  CORE,
  LIMITS,
  MAIL,
  MethodError,
  optionalBool,
  optionalInt,
  optionalString,
  optionalStringList,
  runCalls,
  type Args,
  type JmapRequest,
  type JmapResponse,
  type Method,
} from "./protocol";

/**
 * JMAP Mail (RFC 8621) over the Mailbox's SQLite tables. Runs inside the
 * Mailbox Durable Object, so one request sees one consistent state.
 *
 * Mapping:
 * - mailboxes are the rows of the mailboxes table: the built-in VIP, Inbox,
 *   Sent, Archive, Spam and Trash, plus the user's own flat folders; a
 *   message is in exactly one;
 * - every message is its own thread (threadId = "T" + id);
 * - keywords are $seen and $flagged; others are not stored;
 * - Email has one property of our own, `category`: its Inbox category ("primary",
 *   "transactions", "updates", "promotions" or one of the user's own, see
 *   categories.ts), null for Sent mail. Email/query filters on it with `category`;
 * - receive-only: Email/set can change keywords and mailbox and destroy,
 *   but never create.
 */

export interface MailStore {
  sql: SqlStorage;
  bucket: R2Bucket;
  transaction<T>(fn: () => T): T;
  /** Bumps and returns the change counter. */
  nextModseq(): number;
  /** Permanently deletes these messages; returns the ids that existed. */
  destroy(ids: string[]): Promise<string[]>;
  /** Rules and re-sorting; the user's moves in and out of Spam teach it. */
  sorting: Sorting;
}

export const SESSION_STATE = "1";

type MailboxRow = {
  id: string;
  name: string;
  role: string | null;
  sort_order: number;
  builtin: number;
  created_modseq: number;
  updated_modseq: number;
  destroyed_modseq: number | null;
};

/** Where a new folder goes when the client doesn't say: after the built-in ones. */
const DEFAULT_FOLDER_SORT_ORDER = 10;

const MAILBOX_PROPERTIES = [
  "id",
  "name",
  "parentId",
  "role",
  "sortOrder",
  "totalEmails",
  "unreadEmails",
  "totalThreads",
  "unreadThreads",
  "myRights",
  "isSubscribed",
];
const MAILBOX_COUNT_PROPERTIES = ["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"];

const DEFAULT_EMAIL_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
  "bodyValues",
  "textBody",
  "htmlBody",
  "attachments",
  "category",
];
const DEFAULT_BODY_PROPERTIES = ["partId", "blobId", "size", "name", "type", "charset", "disposition", "cid", "language", "location"];
const BODY_PART_PROPERTIES = new Set([...DEFAULT_BODY_PROPERTIES, "headers", "subParts"]);
const EMAIL_PROPERTIES = new Set([...DEFAULT_EMAIL_PROPERTIES, "headers", "bodyStructure"]);

const MAX_QUERY_LIMIT = 1000;
const DEFAULT_MAX_CHANGES = 5000;
/** How much of a body SearchSnippet/get looks through for a passage. */
const SNIPPET_TEXT_CHARS = 50_000;

type Row = {
  seq: number;
  id: string;
  received_at: number;
  folder: string;
  seen: number;
  flagged: number;
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
  list_unsubscribe: string | null;
  category: string | null;
};

type AttachmentRow = {
  idx: number;
  filename: string | null;
  mime_type: string;
  size: number;
  disposition: string | null;
  content_id: string | null;
};

type Part = Record<string, unknown>;

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Inline images referenced from the HTML don't count as attachments for the paperclip. */
export function isRealAttachment(a: { disposition: string | null; content_id: string | null }): boolean {
  return !(a.disposition === "inline" && a.content_id);
}

function addresses(json: string): { name: string | null; email: string }[] {
  return (JSON.parse(json) as AddressEntry[]).map((a) => ({ name: a.name || null, email: a.address }));
}

function pick(obj: Record<string, unknown>, properties: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of properties) out[p] = obj[p] ?? null;
  return out;
}

function truncateUtf8(value: string, maxBytes: number): { value: string; isTruncated: boolean } {
  if (maxBytes <= 0) return { value, isTruncated: false };
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return { value, isTruncated: false };
  // Cut on a character boundary: drop continuation bytes at the cut.
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return { value: new TextDecoder().decode(bytes.subarray(0, end)), isTruncated: true };
}

export class MailApi {
  constructor(
    private readonly store: MailStore,
    private readonly accountId: string,
  ) {}

  private get sql(): SqlStorage {
    return this.store.sql;
  }

  state(): string {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'modseq'").toArray()[0];
    return row ? row.value : "0";
  }

  run(request: JmapRequest): Promise<JmapResponse> {
    const m = (capability: string, run: Method["run"]): Method => ({ capability, run });
    return runCalls(
      request,
      {
        "Core/echo": m(CORE, (args) => args),
        "Mailbox/get": m(MAIL, (a) => this.mailboxGet(a)),
        "Mailbox/changes": m(MAIL, (a) => this.mailboxChanges(a)),
        "Mailbox/query": m(MAIL, (a) => this.mailboxQuery(a)),
        "Mailbox/queryChanges": m(MAIL, (a) => this.cannotCalculate(a)),
        "Mailbox/set": m(MAIL, (a) => this.mailboxSet(a)),
        "Thread/get": m(MAIL, (a) => this.threadGet(a)),
        "Thread/changes": m(MAIL, (a) => this.threadChanges(a)),
        "Email/get": m(MAIL, (a) => this.emailGet(a)),
        "Email/changes": m(MAIL, (a) => this.emailChanges(a)),
        "Email/query": m(MAIL, (a) => this.emailQuery(a)),
        "Email/queryChanges": m(MAIL, (a) => this.cannotCalculate(a)),
        "Email/set": m(MAIL, (a) => this.emailSet(a)),
        "SearchSnippet/get": m(MAIL, (a) => this.searchSnippetGet(a)),
      },
      SESSION_STATE,
    );
  }

  private checkAccount(args: Args): void {
    if (args.accountId !== this.accountId) throw new MethodError("accountNotFound", "No such account.");
  }

  // ---- Mailbox ----

  /** Live mailboxes, in display order. */
  private mailboxRows(): MailboxRow[] {
    return this.sql
      .exec<MailboxRow>("SELECT * FROM mailboxes WHERE destroyed_modseq IS NULL ORDER BY sort_order, lower(name)")
      .toArray();
  }

  private mailboxRow(id: string): MailboxRow | null {
    return (
      this.sql.exec<MailboxRow>("SELECT * FROM mailboxes WHERE id = ? AND destroyed_modseq IS NULL", id).toArray()[0] ??
      null
    );
  }

  private mailboxCounts(): Map<string, { total: number; unread: number }> {
    const counts = new Map<string, { total: number; unread: number }>();
    for (const r of this.sql
      .exec<{ folder: string; total: number; unread: number }>(
        "SELECT folder, count(*) AS total, sum(seen = 0) AS unread FROM messages GROUP BY folder",
      )
      .toArray()) {
      counts.set(r.folder, { total: r.total, unread: r.unread ?? 0 });
    }
    return counts;
  }

  private mailboxObject(row: MailboxRow, counts: Map<string, { total: number; unread: number }>): Args {
    const c = counts.get(row.id) ?? { total: 0, unread: 0 };
    return {
      id: row.id,
      name: row.name,
      parentId: null,
      role: row.role,
      sortOrder: row.sort_order,
      totalEmails: c.total,
      unreadEmails: c.unread,
      totalThreads: c.total,
      unreadThreads: c.unread,
      myRights: mailboxRights(row),
      isSubscribed: true,
    };
  }

  private mailboxGet(args: Args): Args {
    this.checkAccount(args);
    const ids = optionalStringList(args, "ids");
    const properties = this.properties(args, MAILBOX_PROPERTIES, new Set(MAILBOX_PROPERTIES));
    const counts = this.mailboxCounts();
    const rows = this.mailboxRows();
    const wanted = ids ?? rows.map((r) => r.id);
    const list: Args[] = [];
    const notFound: string[] = [];
    for (const id of wanted) {
      const row = rows.find((r) => r.id === id);
      if (row) list.push(pick(this.mailboxObject(row, counts), properties));
      else notFound.push(id);
    }
    return { accountId: this.accountId, state: this.state(), list, notFound };
  }

  /**
   * Created and destroyed come from the mailboxes table (destroyed folders
   * stay there as tombstones). Counts move with every change, so whenever
   * the state moved, every mailbox is "updated", and only its counts changed
   * unless one was renamed or reordered.
   */
  private mailboxChanges(args: Args): Args {
    this.checkAccount(args);
    const since = this.sinceState(args);
    const state = this.state();
    const all = this.sql.exec<MailboxRow>("SELECT * FROM mailboxes ORDER BY sort_order, lower(name)").toArray();
    const kept = all.filter((r) => r.destroyed_modseq === null && r.created_modseq <= since);
    const changed = since !== Number(state);
    const renamed = kept.some((r) => r.updated_modseq > since);
    return {
      accountId: this.accountId,
      oldState: String(since),
      newState: state,
      hasMoreChanges: false,
      created: all.filter((r) => r.destroyed_modseq === null && r.created_modseq > since).map((r) => r.id),
      updated: changed ? kept.map((r) => r.id) : [],
      destroyed: all
        .filter((r) => r.destroyed_modseq !== null && r.destroyed_modseq > since && r.created_modseq <= since)
        .map((r) => r.id),
      updatedProperties: changed && !renamed ? MAILBOX_COUNT_PROPERTIES : null,
    };
  }

  private mailboxQuery(args: Args): Args {
    this.checkAccount(args);
    const filter = (args.filter ?? null) as Record<string, unknown> | null;
    let boxes = this.mailboxRows();
    if (filter) {
      for (const [key, value] of Object.entries(filter)) {
        if (key === "role") boxes = boxes.filter((b) => b.role === value);
        else if (key === "hasAnyRole") boxes = boxes.filter((b) => (b.role !== null) === value);
        else if (key === "parentId") boxes = value === null ? boxes : [];
        else if (key === "isSubscribed") boxes = value === true ? boxes : [];
        else if (key === "name" && typeof value === "string") {
          boxes = boxes.filter((b) => b.name.toLowerCase().includes(value.toLowerCase()));
        } else throw new MethodError("unsupportedFilter", `Mailbox filter ${key} is not supported.`);
      }
    }
    const ids = boxes.map((b) => b.id);
    return {
      accountId: this.accountId,
      queryState: this.state(),
      canCalculateChanges: false,
      position: 0,
      ids,
      total: ids.length,
    };
  }

  /**
   * The built-in mailboxes are fixed; the user's own folders can be created,
   * renamed, reordered and deleted. Folders are flat (no parentId). Deleting
   * a folder that still has mail needs onDestroyRemoveEmails, and then its
   * mail goes to the Trash rather than being destroyed outright (RFC 8621
   * would destroy it). A deleted folder's sorting rules go with it.
   */
  private mailboxSet(args: Args): Args {
    this.checkAccount(args);
    const oldState = this.state();
    const ifInState = optionalString(args, "ifInState");
    if (ifInState !== null && ifInState !== oldState) throw new MethodError("stateMismatch", "State has changed.");
    const create = (args.create ?? {}) as Record<string, unknown>;
    const update = (args.update ?? {}) as Record<string, unknown>;
    const destroy = optionalStringList(args, "destroy") ?? [];
    const removeEmails = optionalBool(args, "onDestroyRemoveEmails", false);

    const created: Record<string, Args> = {};
    const notCreated: Record<string, unknown> = {};
    const updated: Record<string, null> = {};
    const notUpdated: Record<string, unknown> = {};
    const destroyed: string[] = [];
    const notDestroyed: Record<string, unknown> = {};

    this.store.transaction(() => {
      let modseq: number | null = null;
      const bump = () => (modseq ??= this.store.nextModseq());

      for (const [creationId, value] of Object.entries(create)) {
        try {
          const props = mailboxProps(value);
          if (props.name === undefined) throw new SetError("invalidProperties", "A folder needs a name.", ["name"]);
          this.assertNameFree(props.name, null);
          const at = bump();
          const row = this.sql
            .exec<MailboxRow>(
              `INSERT INTO mailboxes (id, name, role, sort_order, builtin, created_modseq, updated_modseq)
               SELECT 'f' || (coalesce(max(rowid), 0) + 1), ?, NULL, ?, 0, ?, ? FROM mailboxes
               RETURNING *`,
              props.name,
              props.sortOrder ?? DEFAULT_FOLDER_SORT_ORDER,
              at,
              at,
            )
            .one();
          const { name: _name, ...serverSet } = this.mailboxObject(row, new Map());
          created[creationId] = serverSet;
        } catch (err) {
          notCreated[creationId] = setErrorObject(err);
        }
      }

      for (const [id, patch] of Object.entries(update)) {
        const row = this.mailboxRow(id);
        if (!row) {
          notUpdated[id] = { type: "notFound" };
          continue;
        }
        try {
          const props = mailboxProps(patch);
          if (props.name === undefined && props.sortOrder === undefined) {
            updated[id] = null;
            continue;
          }
          // The standard folders keep their names, but sit wherever the user puts them.
          if (row.builtin && props.name !== undefined && props.name !== row.name) {
            throw new SetError("forbidden", `${row.name} can't be renamed.`);
          }
          if (props.name !== undefined) this.assertNameFree(props.name, id);
          const at = bump();
          this.sql.exec(
            "UPDATE mailboxes SET name = coalesce(?, name), sort_order = coalesce(?, sort_order), updated_modseq = ? WHERE id = ?",
            props.name ?? null,
            props.sortOrder ?? null,
            at,
            id,
          );
          updated[id] = null;
        } catch (err) {
          notUpdated[id] = setErrorObject(err);
        }
      }

      for (const id of destroy) {
        const row = this.mailboxRow(id);
        if (!row) {
          notDestroyed[id] = { type: "notFound" };
          continue;
        }
        if (row.builtin) {
          notDestroyed[id] = { type: "forbidden", description: `${row.name} can't be deleted.` };
          continue;
        }
        const count = this.sql.exec<{ n: number }>("SELECT count(*) AS n FROM messages WHERE folder = ?", id).one().n;
        if (count && !removeEmails) {
          notDestroyed[id] = { type: "mailboxHasEmail", description: `${row.name} still has ${count} messages.` };
          continue;
        }
        const at = bump();
        this.sql.exec(
          "UPDATE messages SET folder = 'trash', auto_filed = 0, sort_rule_id = NULL, updated_modseq = ? WHERE folder = ?",
          at,
          id,
        );
        this.sql.exec("UPDATE mailboxes SET destroyed_modseq = ?, updated_modseq = ? WHERE id = ?", at, at, id);
        this.store.sorting.dropRulesFor(id);
        destroyed.push(id);
      }
    });

    const orNull = <T extends object>(o: T) => (Object.keys(o).length ? o : null);
    return {
      accountId: this.accountId,
      oldState,
      newState: this.state(),
      created: orNull(created),
      updated: orNull(updated),
      destroyed: destroyed.length ? destroyed : null,
      notCreated: orNull(notCreated),
      notUpdated: orNull(notUpdated),
      notDestroyed: orNull(notDestroyed),
    };
  }

  private assertNameFree(name: string, exceptId: string | null): void {
    const clash = this.sql
      .exec<{ id: string }>(
        "SELECT id FROM mailboxes WHERE lower(name) = lower(?) AND destroyed_modseq IS NULL AND id IS NOT ?",
        name,
        exceptId,
      )
      .toArray()[0];
    if (clash) throw new SetError("invalidProperties", `There is already a folder called ${name}.`, ["name"]);
  }

  // ---- Thread ----

  private threadGet(args: Args): Args {
    this.checkAccount(args);
    const ids = optionalStringList(args, "ids");
    if (ids === null) throw new MethodError("requestTooLarge", "Ask for specific threads.");
    if (ids.length > LIMITS.maxObjectsInGet) throw new MethodError("requestTooLarge", "Too many ids.");
    const list: Args[] = [];
    const notFound: string[] = [];
    for (const id of ids) {
      const emailId = id.startsWith("T") ? id.slice(1) : "";
      if (emailId && this.sql.exec("SELECT 1 FROM messages WHERE id = ?", emailId).toArray().length) {
        list.push({ id, emailIds: [emailId] });
      } else notFound.push(id);
    }
    return { accountId: this.accountId, state: this.state(), list, notFound };
  }

  private threadChanges(args: Args): Args {
    const result = this.emailChanges(args);
    // A thread holds one email, so it changes only when the email appears or goes.
    const thread = (ids: unknown) => (ids as string[]).map((id) => `T${id}`);
    return { ...result, created: thread(result.created), updated: [], destroyed: thread(result.destroyed) };
  }

  // ---- Email ----

  private properties(args: Args, defaults: string[], known: Set<string>, key = "properties"): string[] {
    const requested = optionalStringList(args, key);
    if (requested === null) return defaults;
    for (const p of requested) {
      if (!known.has(p) && !p.startsWith("header:")) throw new MethodError("invalidArguments", `Unknown property ${p}.`);
    }
    return requested.includes("id") || key !== "properties" ? requested : ["id", ...requested];
  }

  private async emailGet(args: Args): Promise<Args> {
    this.checkAccount(args);
    const ids = optionalStringList(args, "ids");
    if (ids === null) throw new MethodError("requestTooLarge", "Ask for specific emails; use Email/query to list them.");
    if (ids.length > LIMITS.maxObjectsInGet) {
      throw new MethodError("requestTooLarge", `At most ${LIMITS.maxObjectsInGet} ids per call.`);
    }
    const properties = this.properties(args, DEFAULT_EMAIL_PROPERTIES, EMAIL_PROPERTIES);
    const bodyProperties = this.properties(args, DEFAULT_BODY_PROPERTIES, BODY_PART_PROPERTIES, "bodyProperties");
    const headerProps = properties.map(parseHeaderProperty).filter((p) => p !== null);
    for (const p of bodyProperties) parseHeaderProperty(p);
    const options = {
      text: optionalBool(args, "fetchTextBodyValues", false),
      html: optionalBool(args, "fetchHTMLBodyValues", false),
      all: optionalBool(args, "fetchAllBodyValues", false),
      maxBytes: optionalInt(args, "maxBodyValueBytes", 0),
    };
    const state = this.state();

    const list: Args[] = [];
    const notFound: string[] = [];
    for (const id of new Set(ids)) {
      const row = this.sql.exec<Row>("SELECT * FROM messages WHERE id = ?", id).toArray()[0];
      if (!row) {
        notFound.push(id);
        continue;
      }
      const email: Record<string, unknown> = await this.emailObject(row, properties, bodyProperties, options);
      if (headerProps.length || properties.includes("headers")) {
        const fields = row.blobs_expired ? null : await readHeaderFields(this.store.bucket, rawKey(row.id));
        if (properties.includes("headers")) email.headers = fields ?? [];
        for (const p of headerProps) email[p.property] = fields ? headerPropertyValue(fields, p) : null;
      }
      list.push(pick(email, properties));
    }
    return { accountId: this.accountId, state, list, notFound };
  }

  private async emailObject(
    row: Row,
    properties: string[],
    bodyProperties: string[],
    options: { text: boolean; html: boolean; all: boolean; maxBytes: number },
  ): Promise<Record<string, unknown>> {
    const wants = (p: string) => properties.includes(p);
    const email: Record<string, unknown> = {
      id: row.id,
      blobId: blobIdFor.raw(row.id),
      threadId: `T${row.id}`,
      mailboxIds: { [row.folder]: true },
      keywords: {
        ...(row.seen ? { $seen: true } : {}),
        ...(row.flagged ? { $flagged: true } : {}),
      },
      size: row.size,
      receivedAt: utcDate(row.received_at),
      messageId: asMessageIds(row.message_id),
      inReplyTo: asMessageIds(row.in_reply_to),
      references: asMessageIds(row.refs),
      sender: null,
      from: row.from_address ? [{ name: row.from_name || null, email: row.from_address }] : null,
      to: addresses(row.to_json),
      cc: addresses(row.cc_json),
      bcc: null,
      replyTo: addresses(row.reply_to_json),
      subject: row.subject,
      sentAt: row.sent_at === null ? null : utcDate(row.sent_at),
      preview: row.preview,
      category: row.category,
    };

    const bodyWanted = ["hasAttachment", "bodyStructure", "textBody", "htmlBody", "attachments", "bodyValues"].some(wants);
    if (!bodyWanted) return email;

    const attachments = this.sql
      .exec<AttachmentRow>("SELECT * FROM attachments WHERE message_seq = ? ORDER BY idx", row.seq)
      .toArray();
    email.hasAttachment = attachments.some(isRealAttachment);
    if (!["bodyStructure", "textBody", "htmlBody", "attachments", "bodyValues"].some(wants)) return email;

    const text = this.bodyText(row.seq);
    const html = row.has_html && (wants("bodyStructure") || wants("htmlBody") || wants("bodyValues"))
      ? await this.bodyHtml(row.id)
      : null;
    const textPart: Part = {
      partId: "t",
      blobId: blobIdFor.text(row.id),
      size: new TextEncoder().encode(text).byteLength,
      headers: [],
      name: null,
      type: "text/plain",
      charset: "utf-8",
      disposition: null,
      cid: null,
      language: null,
      location: null,
    };
    const htmlPart: Part | null = row.has_html
      ? {
          ...textPart,
          partId: "h",
          blobId: blobIdFor.html(row.id),
          size: html === null ? 0 : new TextEncoder().encode(html).byteLength,
          type: "text/html",
        }
      : null;
    const attachmentParts: Part[] = attachments.map((a) => ({
      partId: `a${a.idx}`,
      blobId: blobIdFor.attachment(row.id, a.idx),
      size: a.size,
      headers: [],
      name: a.filename,
      type: a.mime_type,
      charset: null,
      disposition: a.disposition ?? "attachment",
      cid: a.content_id ? a.content_id.replace(/^<|>$/g, "") : null,
      language: null,
      location: null,
    }));

    const shape = (p: Part): Part => pick(p, bodyProperties.filter((k) => k !== "subParts"));
    if (wants("bodyStructure")) {
      const body: Part = htmlPart
        ? { partId: null, blobId: null, type: "multipart/alternative", subParts: [shape(textPart), shape(htmlPart)] }
        : shape(textPart);
      email.bodyStructure = attachmentParts.length
        ? { partId: null, blobId: null, type: "multipart/mixed", subParts: [body, ...attachmentParts.map(shape)] }
        : body;
    }
    email.textBody = [shape(textPart)];
    email.htmlBody = [shape(htmlPart ?? textPart)];
    email.attachments = attachmentParts.map(shape);

    const values: Record<string, unknown> = {};
    const value = (s: string) => ({ ...truncateUtf8(s, options.maxBytes), isEncodingProblem: false });
    if (options.text || options.all || (options.html && !htmlPart)) values.t = value(text);
    if (htmlPart && (options.html || options.all)) values.h = value(html ?? "");
    email.bodyValues = values;
    return email;
  }

  bodyText(seq: number): string {
    return this.sql.exec<{ body: string }>("SELECT body FROM messages_fts WHERE rowid = ?", seq).toArray()[0]?.body ?? "";
  }

  private async bodyHtml(id: string): Promise<string | null> {
    const object = await this.store.bucket.get(htmlKey(id));
    return object ? object.text() : null;
  }

  private sinceState(args: Args): number {
    const since = optionalString(args, "sinceState");
    if (since === null) throw new MethodError("invalidArguments", "sinceState is required.");
    const n = Number(since);
    if (!/^\d+$/.test(since) || n > Number(this.state())) {
      throw new MethodError("cannotCalculateChanges", "Unknown state; resynchronise.");
    }
    return n;
  }

  private emailChanges(args: Args): Args {
    this.checkAccount(args);
    const since = this.sinceState(args);
    const maxChanges = optionalInt(args, "maxChanges", DEFAULT_MAX_CHANGES, 1);
    const changes = [
      ...this.sql
        .exec<{ id: string; created: number; modseq: number }>(
          "SELECT id, created_modseq AS created, updated_modseq AS modseq FROM messages WHERE updated_modseq > ?",
          since,
        )
        .toArray()
        .map((r) => ({ id: r.id, modseq: r.modseq, kind: r.created > since ? "created" : "updated" })),
      ...this.sql
        .exec<{ id: string; modseq: number }>("SELECT id, modseq FROM deleted WHERE modseq > ?", since)
        .toArray()
        .map((r) => ({ id: r.id, modseq: r.modseq, kind: "destroyed" })),
    ].sort((a, b) => a.modseq - b.modseq);

    let taken = changes;
    let newState = this.state();
    let hasMoreChanges = false;
    if (changes.length > maxChanges) {
      // Stop at a whole modseq so the next call starts cleanly after it.
      const cut = changes[maxChanges - 1]!.modseq;
      taken = changes.filter((c) => c.modseq <= cut);
      if (taken.length > maxChanges) taken = changes.filter((c) => c.modseq < cut);
      if (!taken.length) throw new MethodError("cannotCalculateChanges", "Too many changes at once; resynchronise.");
      newState = String(taken.at(-1)!.modseq);
      hasMoreChanges = true;
    }
    const of = (kind: string) => taken.filter((c) => c.kind === kind).map((c) => c.id);
    return {
      accountId: this.accountId,
      oldState: String(since),
      newState,
      hasMoreChanges,
      created: of("created"),
      updated: of("updated"),
      destroyed: of("destroyed"),
    };
  }

  private emailQuery(args: Args): Args {
    this.checkAccount(args);
    const params: SqlStorageValue[] = [];
    const where = args.filter ? compileFilter(args.filter, params) : "1";
    const orderBy = compileSort(args.sort);
    const requestedLimit = args.limit === undefined || args.limit === null ? null : optionalInt(args, "limit", 0);
    const limit = Math.min(requestedLimit ?? MAX_QUERY_LIMIT, MAX_QUERY_LIMIT);
    const calculateTotal = optionalBool(args, "calculateTotal", false);
    const anchor = optionalString(args, "anchor");
    const from = `FROM messages m WHERE ${where}`;
    const count = () => this.sql.exec<{ n: number }>(`SELECT count(*) AS n ${from}`, ...params).one().n;

    let position: number;
    let total: number | null = null;
    if (anchor !== null) {
      const all = this.sql.exec<{ id: string }>(`SELECT m.id ${from} ORDER BY ${orderBy}`, ...params).toArray();
      const index = all.findIndex((r) => r.id === anchor);
      if (index === -1) throw new MethodError("anchorNotFound", "The anchor is not in the results.");
      total = all.length;
      const offset = typeof args.anchorOffset === "number" ? Math.trunc(args.anchorOffset) : 0;
      position = Math.max(0, index + offset);
    } else {
      position = typeof args.position === "number" ? Math.trunc(args.position) : 0;
      if (position < 0) {
        total = count();
        position = Math.max(0, total + position);
      }
    }
    const ids = this.sql
      .exec<{ id: string }>(`SELECT m.id ${from} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, ...params, limit, position)
      .toArray()
      .map((r) => r.id);
    if (calculateTotal && total === null) total = count();
    return {
      accountId: this.accountId,
      queryState: this.state(),
      canCalculateChanges: false,
      position,
      ids,
      ...(calculateTotal ? { total } : {}),
      ...(requestedLimit === null || requestedLimit > MAX_QUERY_LIMIT ? { limit } : {}),
    };
  }

  private cannotCalculate(args: Args): Args {
    this.checkAccount(args);
    throw new MethodError("cannotCalculateChanges", "Query changes aren't tracked; run the query again.");
  }

  private async emailSet(args: Args): Promise<Args> {
    this.checkAccount(args);
    const oldState = this.state();
    const ifInState = optionalString(args, "ifInState");
    if (ifInState !== null && ifInState !== oldState) throw new MethodError("stateMismatch", "State has changed.");
    const create = (args.create ?? {}) as Record<string, unknown>;
    const update = (args.update ?? {}) as Record<string, unknown>;
    const destroy = optionalStringList(args, "destroy") ?? [];
    if (Object.keys(create).length + Object.keys(update).length + destroy.length > LIMITS.maxObjectsInSet) {
      throw new MethodError("requestTooLarge", `At most ${LIMITS.maxObjectsInSet} changes per call.`);
    }

    const notCreated: Record<string, unknown> = {};
    for (const key of Object.keys(create)) {
      notCreated[key] = { type: "forbidden", description: "This mailbox is receive-only." };
    }

    const updated: Record<string, unknown> = {};
    const notUpdated: Record<string, unknown> = {};
    const plans: { id: string; from: Folder; fromAddress: string | null; folder: Folder; seen: boolean; flagged: boolean }[] = [];
    const exists = (mailboxId: string) => this.store.sorting.mailboxExists(mailboxId);
    for (const [id, patch] of Object.entries(update)) {
      const row = this.sql
        .exec<{ folder: string; seen: number; flagged: number; from_address: string | null }>(
          "SELECT folder, seen, flagged, from_address FROM messages WHERE id = ?",
          id,
        )
        .toArray()[0];
      if (!row) {
        notUpdated[id] = { type: "notFound" };
        continue;
      }
      try {
        const plan = applyPatch(row, patch, exists);
        plans.push({ id, from: row.folder, fromAddress: row.from_address, ...plan });
        updated[id] = plan.ignoredKeywords
          ? { keywords: { ...(plan.seen ? { $seen: true } : {}), ...(plan.flagged ? { $flagged: true } : {}) } }
          : null;
      } catch (err) {
        if (!(err instanceof SetError)) throw err;
        notUpdated[id] = setErrorObject(err);
      }
    }
    if (plans.length) {
      this.store.transaction(() => {
        const modseq = this.store.nextModseq();
        for (const p of plans) {
          // A move by the user files the message by hand: rules leave it alone from then on.
          const moved = p.folder !== p.from;
          this.sql.exec(
            `UPDATE messages SET folder = ?, seen = ?, flagged = ?, updated_modseq = ?,
               auto_filed = CASE WHEN ? THEN 0 ELSE auto_filed END,
               sort_rule_id = CASE WHEN ? THEN NULL ELSE sort_rule_id END
             WHERE id = ?`,
            p.folder,
            Number(p.seen),
            Number(p.flagged),
            modseq,
            Number(moved),
            Number(moved),
            p.id,
          );
        }
        this.store.sorting.learnFromMoves(plans.map((p) => ({ fromAddress: p.fromAddress, from: p.from, to: p.folder })));
      });
    }

    const destroyed = destroy.length ? await this.store.destroy(destroy) : [];
    const notDestroyed: Record<string, unknown> = {};
    for (const id of destroy) if (!destroyed.includes(id)) notDestroyed[id] = { type: "notFound" };

    const orNull = (o: Record<string, unknown>) => (Object.keys(o).length ? o : null);
    return {
      accountId: this.accountId,
      oldState,
      newState: this.state(),
      created: null,
      updated: orNull(updated),
      destroyed: destroyed.length ? destroyed : null,
      notCreated: orNull(notCreated),
      notUpdated: orNull(notUpdated),
      notDestroyed: orNull(notDestroyed),
    };
  }

  private searchSnippetGet(args: Args): Args {
    this.checkAccount(args);
    const emailIds = optionalStringList(args, "emailIds") ?? [];
    if (emailIds.length > LIMITS.maxObjectsInGet) throw new MethodError("requestTooLarge", "Too many ids.");
    const words = args.filter ? snippetWords(args.filter) : { subject: [], body: [] };
    const list: Args[] = [];
    const notFound: string[] = [];
    for (const emailId of emailIds) {
      const seq = this.sql.exec<{ seq: number }>("SELECT seq FROM messages WHERE id = ?", emailId).toArray()[0]?.seq;
      if (seq === undefined) {
        notFound.push(emailId);
        continue;
      }
      let found: { subject: string | null; preview: string | null } = { subject: null, preview: null };
      if (words.subject.length || words.body.length) {
        const row = this.sql
          .exec<{ subject: string | null; body: string | null; more: number }>(
            "SELECT subject, substr(body, 1, ?) AS body, length(body) > ? AS more FROM messages_fts WHERE rowid = ?",
            SNIPPET_TEXT_CHARS,
            SNIPPET_TEXT_CHARS,
            seq,
          )
          .toArray()[0];
        if (row) {
          const subject = highlight(row.subject ?? "", words.subject);
          const preview = snippet(row.body ?? "", words.body, 24, row.more === 1);
          found = { subject: subject && markup(subject), preview: preview && markup(preview) };
        }
      }
      list.push({ emailId, ...found });
    }
    return { accountId: this.accountId, list, notFound };
  }
}

/** Escapes text for HTML, turning the \x02…\x03 highlight markers into <mark>. */
function markup(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u0002/g, "<mark>")
    .replace(/\u0003/g, "</mark>");
}

class SetError extends Error {
  constructor(
    readonly type: string,
    message: string,
    readonly properties?: string[],
  ) {
    super(message);
  }
}

function decodePointerToken(s: string): string {
  return s.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Applies an Email/set patch to the stored flags and folder. */
function applyPatch(
  row: { folder: string; seen: number; flagged: number },
  patch: unknown,
  mailboxExists: (id: string) => boolean,
): { folder: Folder; seen: boolean; flagged: boolean; ignoredKeywords: boolean } {
  if (!patch || typeof patch !== "object") throw new SetError("invalidPatch", "The patch must be an object.");
  let seen = row.seen === 1;
  let flagged = row.flagged === 1;
  const boxes = new Set<string>([row.folder]);
  let ignoredKeywords = false;

  const setKeyword = (keyword: string, on: boolean) => {
    const k = keyword.toLowerCase();
    if (k === "$seen") seen = on;
    else if (k === "$flagged") flagged = on;
    else if (on) ignoredKeywords = true;
  };

  for (const [path, value] of Object.entries(patch as Record<string, unknown>)) {
    if (path === "keywords") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new SetError("invalidProperties", "keywords must be an object.", ["keywords"]);
      }
      seen = false;
      flagged = false;
      // jmap-webmail sends `false` for keywords it means to leave off.
      for (const [k, v] of Object.entries(value)) {
        if (v !== true && v !== false) throw new SetError("invalidProperties", "Keyword values must be true.", ["keywords"]);
        if (v) setKeyword(k, true);
      }
    } else if (path.startsWith("keywords/")) {
      // RFC 8621 removes with null; jmap-webmail sends false. Accept both.
      if (value !== true && value !== null && value !== false) {
        throw new SetError("invalidPatch", `${path} must be true or null.`);
      }
      setKeyword(decodePointerToken(path.slice("keywords/".length)), value === true);
    } else if (path === "mailboxIds") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new SetError("invalidProperties", "mailboxIds must be an object.", ["mailboxIds"]);
      }
      boxes.clear();
      for (const [id, v] of Object.entries(value)) {
        if (v !== true) throw new SetError("invalidProperties", "mailboxIds values must be true.", ["mailboxIds"]);
        boxes.add(id);
      }
    } else if (path.startsWith("mailboxIds/")) {
      const id = decodePointerToken(path.slice("mailboxIds/".length));
      if (value === true) boxes.add(id);
      else if (value === null) boxes.delete(id);
      else throw new SetError("invalidPatch", `${path} must be true or null.`);
    } else {
      throw new SetError("invalidProperties", `${path} can't be changed.`, [path.split("/")[0]!]);
    }
  }

  const folders = [...boxes];
  if (folders.length !== 1) {
    throw new SetError("invalidProperties", "An email must be in exactly one mailbox.", ["mailboxIds"]);
  }
  const folder = folders[0]!;
  if (folder !== row.folder && !mailboxExists(folder)) {
    throw new SetError("invalidProperties", `No mailbox ${folder}.`, ["mailboxIds"]);
  }
  return { folder, seen, flagged, ignoredKeywords };
}

function setErrorObject(err: unknown): Record<string, unknown> {
  if (!(err instanceof SetError)) throw err;
  return { type: err.type, description: err.message, ...(err.properties ? { properties: err.properties } : {}) };
}

function mailboxRights(row: MailboxRow): Record<string, boolean> {
  const own = row.builtin === 0;
  return {
    mayReadItems: true,
    mayAddItems: true,
    mayRemoveItems: true,
    maySetSeen: true,
    maySetKeywords: true,
    mayCreateChild: false,
    mayRename: own,
    mayDelete: own,
    maySubmit: false,
  };
}

/** The settable properties of a Mailbox/set create or update. */
function mailboxProps(value: unknown): { name?: string; sortOrder?: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SetError("invalidProperties", "A mailbox must be an object.");
  }
  const out: { name?: string; sortOrder?: number } = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === "name") {
      const name = typeof v === "string" ? v.trim() : "";
      if (!name || name.length > 255) throw new SetError("invalidProperties", "A folder needs a name.", ["name"]);
      out.name = name;
    } else if (key === "sortOrder") {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
        throw new SetError("invalidProperties", "sortOrder must be a whole number.", ["sortOrder"]);
      }
      out.sortOrder = v;
    } else if (key === "parentId") {
      if (v !== null) throw new SetError("invalidProperties", "Folders can't be nested.", ["parentId"]);
    } else if (key === "role") {
      if (v !== null) throw new SetError("invalidProperties", "Only the built-in mailboxes have roles.", ["role"]);
    } else if (key === "isSubscribed") {
      if (v !== true) throw new SetError("invalidProperties", "Every mailbox is subscribed.", ["isSubscribed"]);
    } else {
      throw new SetError("invalidProperties", `${key} can't be set.`, [key]);
    }
  }
  return out;
}

