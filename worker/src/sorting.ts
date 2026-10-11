import { domainOf, normalizeAddress } from "./address";
import { classify, findSortRule, findVipRule, type Classifiable, type Classification } from "./classify";
import type {
  AddressEntry,
  AuthVerdict,
  Folder,
  FolderInfo,
  RuleDraft,
  RuleFailure,
  Settings,
  SortRule,
  SortRuleKind,
  StayedPut,
  VipRule,
  VipRuleKind,
} from "./types";

// The rules that file mail (VIP senders and the user's sorting rules), and
// re-sorting: when a rule comes or goes, mail it filed earlier moves as if
// the new rules had always been there. Only mail classify placed is touched
// ("auto-filed"); anything the user moved by hand stays where they put it.
//
// Methods that write expect to be called inside a storage transaction.

export interface SortingStore {
  sql: SqlStorage;
  nextModseq(): number;
  settings(): Settings;
}

type VipRuleRow = { id: number; kind: string; value: string; label: string | null; created_at: number };
type SortRuleRow = { id: number; kind: string; value: string; folder: string; created_at: number };
type FilingRow = {
  seq: number;
  folder: string;
  auto_filed: number;
  from_address: string | null;
  alias: string;
  to_json: string;
  cc_json: string;
  auth: string;
  spam_flag: number | null;
  vip_rule_id: number | null;
  sort_rule_id: number | null;
};

/** VIP has its own rules, Sent holds only the user's own mail, and filing into Trash would just be deleting. */
const NOT_A_RULE_TARGET = new Set(["vip", "sent", "trash"]);

const FILING_COLUMNS = "seq, folder, auto_filed, from_address, alias, to_json, cc_json, auth, spam_flag, vip_rule_id, sort_rule_id";

/** Values bound per statement when a list of them is: the Durable Object's SQLite takes at most 100. */
const SQL_PARAMS_PER_STATEMENT = 90;

export type VipDraft = RuleDraft<VipRuleKind> & { label?: string | null };

type FolderRow = { id: string; name: string; role: string | null; show_in_inbox: number };

export class Sorting {
  constructor(private readonly store: SortingStore) {}

  private get sql(): SqlStorage {
    return this.store.sql;
  }

  /** Where a new message goes; `notify` when that's somewhere the clients' Inbox shows (they decide what alerts). */
  classify(message: Classifiable): Classification & { notify: boolean } {
    const c = classify(message, this.vipRules(), this.sortRules(), this.store.settings());
    return { ...c, notify: c.folder === "inbox" || this.inboxShows().includes(c.folder) };
  }

  mailboxExists(id: string): boolean {
    return this.sql.exec("SELECT 1 FROM mailboxes WHERE id = ? AND destroyed_modseq IS NULL", id).toArray().length > 0;
  }

  // ---- Folders shown in the Inbox ----

  folders(): FolderInfo[] {
    return this.sql
      .exec<FolderRow>(
        "SELECT id, name, role, show_in_inbox FROM mailboxes WHERE destroyed_modseq IS NULL ORDER BY sort_order, lower(name)",
      )
      .toArray()
      .map(toFolderInfo);
  }

  /** The folders whose mail the clients list in their Inbox view too. */
  inboxShows(): Folder[] {
    return this.sql
      .exec<{ id: string }>("SELECT id FROM mailboxes WHERE show_in_inbox = 1 AND destroyed_modseq IS NULL")
      .toArray()
      .map((r) => r.id);
  }

  /**
   * Shows a folder's mail in the Inbox view, or stops. Only VIP and the user's
   * own folders: Spam, Archive and Trash are where mail goes to leave the Inbox.
   * The mailbox's state moves, so clients hear of it through Mailbox/changes.
   */
  setShowInInbox(id: Folder, show: boolean): FolderInfo {
    if (typeof show !== "boolean") throw new Error("showInInbox must be true or false.");
    const row = this.sql
      .exec<FolderRow>("SELECT id, name, role, show_in_inbox FROM mailboxes WHERE id = ? AND destroyed_modseq IS NULL", id)
      .toArray()[0];
    if (!row) throw new Error(`No folder ${id}.`);
    if (row.id !== "vip" && row.role !== null) throw new Error("Only VIP and your own folders can show in the Inbox.");
    if ((row.show_in_inbox === 1) !== show) {
      this.sql.exec("UPDATE mailboxes SET show_in_inbox = ?, updated_modseq = ? WHERE id = ?", Number(show), this.store.nextModseq(), id);
    }
    return toFolderInfo({ ...row, show_in_inbox: Number(show) });
  }

  // ---- VIP rules ----

  vipRules(): VipRule[] {
    return this.sql.exec<VipRuleRow>("SELECT * FROM vip_rules ORDER BY id").toArray().map(toVipRule);
  }

  /** Adds (or relabels) a VIP rule; the sender's verified mail filed earlier moves to VIP. */
  addVip(kind: VipRuleKind, value: string, label: string | null): { vip: VipRule; moved: number; stayed: StayedPut } {
    const { vips, moved, failed, stayed } = this.addVips([{ kind, value, label }]);
    if (failed.length) throw new Error(failed[0]!.error);
    return { vip: vips[0]!, moved, stayed };
  }

  /**
   * Adds several VIP rules (one per sender picked): one re-sort and one change for push, however
   * many. Rules that can't be added are reported, and the others still are.
   */
  addVips(drafts: readonly VipDraft[]): { vips: VipRule[]; moved: number; failed: RuleFailure[]; stayed: StayedPut } {
    const vips: VipRule[] = [];
    const failed: RuleFailure[] = [];
    const seqs = new Set<number>();
    for (const d of drafts) {
      try {
        if (d.kind !== "address" && d.kind !== "domain") throw new Error("kind must be 'address' or 'domain'");
        const normalized = normalizeRuleValue(d.kind, d.value);
        vips.push(
          toVipRule(
            this.sql
              .exec<VipRuleRow>(
                `INSERT INTO vip_rules (kind, value, label, created_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (kind, value) DO UPDATE SET label = coalesce(excluded.label, label)
                 RETURNING *`,
                d.kind,
                normalized,
                d.label ?? null,
                Date.now(),
              )
              .one(),
          ),
        );
        this.collectMatching(d.kind, normalized, seqs);
      } catch (err) {
        failed.push(failure(d, err));
      }
    }
    if (!vips.length) return { vips, moved: 0, failed, stayed: nothingStayed() };
    const moved = this.changed(this.resortSeqs(seqs));
    const stayed = this.stayed(seqs, "vip", (m) => findVipRule(m.from_address, vips) !== null);
    return { vips: uniqueById(vips), moved, failed, stayed };
  }

  /** Removes a VIP rule; the mail it filed is sorted again (usually back to the Inbox). */
  removeVip(id: number): { removed: boolean; moved: number } {
    const removed = this.sql.exec("DELETE FROM vip_rules WHERE id = ?", id).rowsWritten > 0;
    return { removed, moved: removed ? this.changed(this.resort("vip_rule_id = ?", id)) : 0 };
  }

  // ---- Sorting rules ----

  sortRules(): SortRule[] {
    return this.sql.exec<SortRuleRow>("SELECT * FROM sort_rules ORDER BY id").toArray().map(toSortRule);
  }

  /** Adds a rule, or points an existing one for the same address, domain, recipient or tag at a new folder. */
  addSortRule(kind: SortRuleKind, value: string, folder: Folder): { rule: SortRule; moved: number; stayed: StayedPut } {
    const { rules, moved, failed, stayed } = this.addSortRules([{ kind, value }], folder);
    if (failed.length) throw new Error(failed[0]!.error);
    return { rule: rules[0]!, moved, stayed };
  }

  /**
   * Adds several rules into one folder ("these 13 senders", "their domains"): one re-sort and one
   * change for push, however many. Rules that can't be added are reported, and the others still are.
   */
  addSortRules(
    drafts: readonly RuleDraft[],
    folder: Folder,
  ): { rules: SortRule[]; moved: number; failed: RuleFailure[]; stayed: StayedPut } {
    if (!this.mailboxExists(folder)) throw new Error(`No folder ${folder}.`);
    if (NOT_A_RULE_TARGET.has(folder)) throw new Error("Rules can file mail into the Inbox, Spam, Archive or your own folders.");
    const rules: SortRule[] = [];
    const failed: RuleFailure[] = [];
    const seqs = new Set<number>();
    for (const d of drafts) {
      try {
        const normalized = normalizeRuleValue(d.kind, d.value);
        rules.push(this.upsertRule(d.kind, normalized, folder));
        this.collectMatching(d.kind, normalized, seqs);
      } catch (err) {
        failed.push(failure(d, err));
      }
    }
    if (!rules.length) return { rules, moved: 0, failed, stayed: nothingStayed() };
    const moved = this.changed(this.resortSeqs(seqs));
    const stayed = this.stayed(seqs, folder, (m) => {
      const recipients = [m.alias, ...addresses(m.to_json), ...addresses(m.cc_json)];
      return findSortRule(m.from_address, recipients, rules) !== null;
    });
    return { rules: uniqueById(rules), moved, failed, stayed };
  }

  removeSortRule(id: number): { removed: boolean; moved: number } {
    const removed = this.sql.exec("DELETE FROM sort_rules WHERE id = ?", id).rowsWritten > 0;
    return { removed, moved: removed ? this.changed(this.resort("sort_rule_id = ?", id)) : 0 };
  }

  /** A folder is going away: its rules go too. */
  dropRulesFor(folder: Folder): void {
    const ids = this.sql
      .exec<{ id: number }>("DELETE FROM sort_rules WHERE folder = ? RETURNING id", folder)
      .toArray()
      .map((r) => r.id);
    for (const id of ids) this.resort("sort_rule_id = ?", id);
  }

  /**
   * The user moved mail by hand. Report spam (into Spam) means "always Spam
   * for this sender"; Not spam (from Spam to the Inbox) means "always Inbox",
   * which also overrides the receiving server's spam verdict. Moving out of
   * Spam anywhere else just forgets the sender's Spam rule.
   */
  learnFromMoves(moves: readonly { fromAddress: string | null; from: Folder; to: Folder }[]): void {
    const senders = new Set<string>();
    for (const m of moves) {
      // Mail moved out of Sent is the user's own: it says nothing about a sender.
      if (!m.fromAddress || m.from === m.to || m.from === "sent") continue;
      const address = normalizeAddress(m.fromAddress);
      if (m.to === "junk") this.upsertRule("address", address, "junk");
      else if (m.from === "junk" && m.to === "inbox") this.upsertRule("address", address, "inbox");
      else if (m.from === "junk" && m.to !== "trash") {
        this.sql.exec("DELETE FROM sort_rules WHERE kind = 'address' AND value = ? AND folder = 'junk'", address);
      } else continue;
      senders.add(address);
    }
    if (senders.size) {
      const seqs = new Set<number>();
      for (const address of senders) this.collectMatching("address", address, seqs);
      this.resortSeqs(seqs);
    }
  }

  // ---- Re-sorting ----

  /**
   * Classifies the auto-filed messages matching `where` again and moves the
   * ones that now belong elsewhere. Returns how many moved.
   */
  resort(where: string, ...params: SqlStorageValue[]): number {
    return this.resortRows(
      this.sql.exec<FilingRow>(`SELECT ${FILING_COLUMNS} FROM messages WHERE auto_filed = 1 AND (${where})`, ...params).toArray(),
    );
  }

  /** resort, for these messages. */
  private resortSeqs(seqs: ReadonlySet<number>): number {
    return this.resortRows(this.rowsOf(seqs, "auto_filed = 1"));
  }

  private resortRows(rows: readonly FilingRow[]): number {
    if (!rows.length) return 0;
    const vips = this.vipRules();
    const rules = this.sortRules();
    const settings = this.store.settings();
    let modseq: number | null = null;
    let moved = 0;
    for (const r of rows) {
      const c = classify(
        {
          fromAddress: r.from_address,
          alias: r.alias,
          recipients: [...addresses(r.to_json), ...addresses(r.cc_json)],
          auth: r.auth as AuthVerdict,
          upstreamSpam: r.spam_flag === 1,
        },
        vips,
        rules,
        settings,
      );
      if (c.folder !== r.folder) {
        modseq ??= this.store.nextModseq();
        this.sql.exec(
          "UPDATE messages SET folder = ?, vip_rule_id = ?, sort_rule_id = ?, updated_modseq = ? WHERE seq = ?",
          c.folder,
          c.vipRuleId,
          c.sortRuleId,
          modseq,
          r.seq,
        );
        moved++;
      } else if (c.vipRuleId !== r.vip_rule_id || c.sortRuleId !== r.sort_rule_id) {
        // Bookkeeping only: nothing a JMAP client can see changed.
        this.sql.exec("UPDATE messages SET vip_rule_id = ?, sort_rule_id = ? WHERE seq = ?", c.vipRuleId, c.sortRuleId, r.seq);
      }
    }
    return moved;
  }

  /** Adds the messages a rule's pattern may cover (every one, hand-filed too) to `into`. */
  private collectMatching(kind: SortRuleKind, value: string, into: Set<number>): void {
    const [where, ...params] = matching(kind, value);
    for (const r of this.sql.exec<{ seq: number }>(`SELECT seq FROM messages WHERE ${where}`, ...params)) into.add(r.seq);
  }

  /** The filing columns of these messages, that also meet `where`, a few statements' worth at a time. */
  private rowsOf(seqs: ReadonlySet<number>, where: string, ...params: SqlStorageValue[]): FilingRow[] {
    const all = [...seqs];
    const rows: FilingRow[] = [];
    const per = SQL_PARAMS_PER_STATEMENT - params.length;
    for (let i = 0; i < all.length; i += per) {
      const chunk = all.slice(i, i + per);
      rows.push(
        ...this.sql
          .exec<FilingRow>(
            `SELECT ${FILING_COLUMNS} FROM messages WHERE seq IN (${chunk.map(() => "?").join(", ")}) AND (${where})`,
            ...chunk,
            ...params,
          )
          .toArray(),
      );
    }
    return rows;
  }

  /**
   * After a re-sort: of these messages, the ones `matches` (the new rules) covers that aren't in
   * `target`, by why. Sent and Trash don't count: rules never take mail out of them.
   */
  private stayed(seqs: ReadonlySet<number>, target: Folder, matches: (row: FilingRow) => boolean): StayedPut {
    const out = nothingStayed();
    const byRule = new Map<number, number>();
    for (const r of this.rowsOf(seqs, "folder != ? AND folder NOT IN ('sent', 'trash')", target)) {
      if (!matches(r)) continue;
      if (r.auto_filed === 0) out.byHand++;
      else if (r.folder === "vip") out.vip++;
      else if (target === "vip") out.unverified++;
      else if (r.sort_rule_id !== null) byRule.set(r.sort_rule_id, (byRule.get(r.sort_rule_id) ?? 0) + 1);
    }
    const rules = new Map(this.sortRules().map((rule) => [rule.id, rule]));
    out.otherRules = [...byRule]
      .flatMap(([id, count]) => {
        const rule = rules.get(id);
        return rule ? [{ rule, count }] : [];
      })
      .sort((a, b) => b.count - a.count);
    return out;
  }

  /**
   * The VIPs or rules changed and `moved` messages moved. With none moved the state goes up
   * anyway: push carries it, and the other devices re-read their VIP and rule lists.
   */
  private changed(moved: number): number {
    if (!moved) this.store.nextModseq();
    return moved;
  }

  private upsertRule(kind: SortRuleKind, value: string, folder: Folder): SortRule {
    return toSortRule(
      this.sql
        .exec<SortRuleRow>(
          `INSERT INTO sort_rules (kind, value, folder, created_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (kind, value) DO UPDATE SET folder = excluded.folder
           RETURNING *`,
          kind,
          value,
          folder,
          Date.now(),
        )
        .one(),
    );
  }
}

/**
 * A SQL condition (and its parameters) for the messages a rule's pattern may
 * cover. The recipient kinds over-match (a LIKE over the To and Cc JSON, where
 * `_` is a wildcard too); resort classifies each one, so only real matches move.
 */
function matching(kind: SortRuleKind, value: string): [string, ...SqlStorageValue[]] {
  if (kind === "address") return ["from_address = ?", value];
  if (kind === "domain") return ["(from_address LIKE ? OR from_address LIKE ?)", `%@${value}`, `%.${value}`];
  const recipients = "(alias || ' ' || to_json || ' ' || cc_json) LIKE ?";
  if (kind === "alias") return [recipients, `%${value}%`];
  if (kind === "tag") return [recipients, `%+${value}@%`];
  return [recipients, `%${value}%`];
}

function nothingStayed(): StayedPut {
  return { byHand: 0, vip: 0, unverified: 0, otherRules: [] };
}

function failure(d: { kind: unknown; value: unknown }, err: unknown): RuleFailure {
  return { kind: String(d.kind), value: String(d.value ?? ""), error: err instanceof Error ? err.message : String(err) };
}

/** Each rule once: a batch may name one twice, and the second upsert returns the same row. */
function uniqueById<T extends { id: number }>(rules: readonly T[]): T[] {
  return [...new Map(rules.map((r) => [r.id, r])).values()];
}

/** The addresses in a stored To or Cc list. */
function addresses(json: string): string[] {
  try {
    return (JSON.parse(json) as AddressEntry[]).map((a) => a.address).filter((a): a is string => typeof a === "string");
  } catch {
    return [];
  }
}

export function normalizeRuleValue(kind: SortRuleKind, value: string): string {
  if (kind === "address" || kind === "alias") {
    const address = normalizeAddress(String(value ?? ""));
    if (!address.includes("@") || !domainOf(address)) throw new Error(`not an email address: ${value}`);
    return address;
  }
  if (kind === "domain" || kind === "to_domain") {
    const domain = domainOf(String(value ?? "").trim().replace(/^\*\./, "").replace(/^@/, ""));
    if (!domain) throw new Error(`not a domain: ${value}`);
    return domain;
  }
  if (kind === "tag") {
    const tag = String(value ?? "").trim().toLowerCase().replace(/^\+/, "");
    if (!tag || /[\s@]/.test(tag)) throw new Error(`not a +tag: ${value}`);
    return tag;
  }
  throw new Error("kind must be 'address', 'domain', 'alias', 'tag' or 'to_domain'");
}

function toVipRule(r: VipRuleRow): VipRule {
  return { id: r.id, kind: r.kind as VipRuleKind, value: r.value, label: r.label, createdAt: r.created_at };
}

function toFolderInfo(r: FolderRow): FolderInfo {
  return { id: r.id, name: r.name, role: r.role, showInInbox: r.show_in_inbox === 1 };
}

function toSortRule(r: SortRuleRow): SortRule {
  return { id: r.id, kind: r.kind as SortRuleKind, value: r.value, folder: r.folder, createdAt: r.created_at };
}
