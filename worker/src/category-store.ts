import { normalizeAddress } from "./address";
import {
  BUILTIN_CATEGORIES,
  CATEGORY_COLORS,
  MAX_CATEGORY_DESCRIPTION,
  MAX_CATEGORY_NAME,
  MAX_CUSTOM_CATEGORIES,
  NEW_MAIL_MS,
  STATE_TEXT_CHARS,
  categoryRequest,
  estimateTokens,
  guessCategory,
  type CategoryAnswer,
  type CategoryOption,
  type CategoryState,
  type Guessable,
} from "./categories";
import type { CategoryInfo, CategorySender, CategorySource, ClassifierStatus, Folder } from "./types";

// The Mailbox's side of Inbox categories (categories.ts): the user's own categories, their
// "categorize sender" corrections, the quick guesses, and the queue of mail waiting for the
// classifier, which the Worker works through (classifier.ts).
//
// Methods that write expect to be called inside a storage transaction.

export interface CategoryStoreDeps {
  sql: SqlStorage;
  nextModseq(): number;
  /** The folders the clients' Inbox view lists: the Inbox and the ones shown in it. */
  inboxView(): Folder[];
}

/** How long one sweep holds the classifier queue before another may take it over. */
export const CLASSIFIER_LEASE_MS = 120_000;

/** Messages guessed per fillGuesses call. */
const GUESS_BATCH = 2000;
/** After a failed sweep the next waits 1, 2, 4... minutes, at most this many. */
const MAX_BACKOFF_MINUTES = 30;

/**
 * A classifier's daily allowance of input tokens (Clef on Workers AI: the free neurons at the
 * model's rate, classifier.ts). Like Workers AI's, it starts again at 00:00 UTC.
 */
export interface ClassifierBudget {
  dailyTokens: number;
}

/**
 * With an allowance, new mail is asked about as it arrives, all day, and the backlog only from this
 * hour (UTC) to the reset, on what the day left over. Must match the backlog cron in wrangler.jsonc.
 */
export const BACKLOG_FROM_UTC_HOUR = 23;
/** Of the day's allowance, what the backlog leaves for new mail arriving during its hour. */
const NEW_MAIL_RESERVE = 0.05;

type CategoryRow = { id: string; name: string; description: string; color: string; sort_order: number; created_at: number };
type GuessRow = {
  seq: number;
  folder: string;
  from_address: string | null;
  subject: string;
  preview: string;
  list_id: string | null;
  list_unsubscribe: string | null;
  vip_rule_id: number | null;
};
type WorkRow = GuessRow & { id: string; from_name: string | null; alias: string; received_at: number };

/** One sweep's hold on the classifier queue. */
interface ClassifierLease {
  owner: string;
  until: number;
  /** Tokens set aside for the batch it was handed, until its answers say what it cost (apply). */
  reserved?: number;
  /** The UTC day they were set aside from. */
  day?: string;
}

/** What the classifier was asked about on one UTC day. */
interface ClassifierUsage {
  day: string;
  tokens: number;
  asked: number;
}

/** What the Mailbox remembers about the classifier between sweeps. */
interface ClassifierMeta {
  model: string | null;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  /** Failed sweeps in a row; the Worker waits longer after each (classifier.ts). */
  failures: number;
}

/** A batch of the classifier queue: the categories to choose from and the messages, newest first. */
export interface CategoryWork {
  /** Changes whenever the categories do; answers to an older generation are thrown away. */
  generation: number;
  options: CategoryOption[];
  messages: { id: string; state: CategoryState }[];
  /** New mail is waiting but today's allowance is spent: when it starts again. */
  wakeAt: number | null;
}

const GUESS_COLUMNS = "seq, folder, from_address, subject, preview, list_id, list_unsubscribe, vip_rule_id";

export class CategoryStore {
  constructor(private readonly store: CategoryStoreDeps) {}

  private get sql(): SqlStorage {
    return this.store.sql;
  }

  // ---- Categories ----

  /** Every category, the built-in ones first, as the classifier is asked about them. */
  options(): CategoryOption[] {
    return [
      ...BUILTIN_CATEGORIES.map((c) => ({ id: c.id, name: c.name, description: c.description, builtin: true })),
      ...this.customRows().map((r) => ({ id: r.id, name: r.name, description: r.description, builtin: false })),
    ];
  }

  /** Every category with its Inbox-view counts, in the order the clients show them. */
  list(): CategoryInfo[] {
    const view = this.store.inboxView();
    const counts = new Map<string | null, { total: number; unread: number }>();
    for (const r of this.sql
      .exec<{ category: string | null; total: number; unread: number | null }>(
        `SELECT category, count(*) AS total, sum(seen = 0) AS unread FROM messages
         WHERE folder IN (${view.map(() => "?").join(", ")}) GROUP BY category`,
        ...view,
      )
      .toArray()) {
      counts.set(r.category, { total: r.total, unread: r.unread ?? 0 });
    }
    const count = (id: string) => counts.get(id) ?? { total: 0, unread: 0 };
    return [
      ...BUILTIN_CATEGORIES.map((c) => ({ id: c.id, name: c.name, description: c.description, color: c.color, builtin: true, ...count(c.id) })),
      ...this.customRows().map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        color: r.color,
        builtin: false,
        ...count(r.id),
      })),
    ];
  }

  exists(id: string): boolean {
    return BUILTIN_CATEGORIES.some((c) => c.id === id) || this.customRow(id) !== null;
  }

  /**
   * Adds one of the user's own categories. The classifier looks at the Inbox again, newest first,
   * with it among the choices; until it has, mail stays where it is.
   */
  create(draft: { name?: unknown; description?: unknown; color?: unknown }): CategoryInfo {
    const rows = this.customRows();
    if (rows.length >= MAX_CUSTOM_CATEGORIES) throw new Error(`You can have at most ${MAX_CUSTOM_CATEGORIES} categories of your own.`);
    const name = this.validName(draft.name, null);
    const description = validDescription(draft.description);
    const used = new Set<string>([...BUILTIN_CATEGORIES.map((c) => c.color), ...rows.map((r) => r.color)]);
    const color =
      draft.color === undefined || draft.color === null
        ? (CATEGORY_COLORS.find((c) => !used.has(c)) ?? CATEGORY_COLORS[rows.length % CATEGORY_COLORS.length]!)
        : validColor(draft.color);
    // Ids are never reused, so a client still showing a removed category can't land in a new one.
    const n = Number(this.meta<number>("category_seq") ?? 0) + 1;
    this.setMeta("category_seq", n);
    const row: CategoryRow = {
      id: `c${n}`,
      name,
      description,
      color,
      sort_order: Math.max(0, ...rows.map((r) => r.sort_order)) + 1,
      created_at: Date.now(),
    };
    this.sql.exec(
      "INSERT INTO categories (id, name, description, color, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      row.id,
      row.name,
      row.description,
      row.color,
      row.sort_order,
      row.created_at,
    );
    this.categoriesChanged(true);
    return this.list().find((c) => c.id === row.id)!;
  }

  /** Renames, re-describes or recolors one of the user's own categories. A new description is asked about again. */
  update(id: string, patch: { name?: unknown; description?: unknown; color?: unknown }): CategoryInfo {
    if (BUILTIN_CATEGORIES.some((c) => c.id === id)) throw new Error("The built-in categories can't be changed.");
    const row = this.customRow(id);
    if (!row) throw new Error(`No category ${id}.`);
    const name = patch.name === undefined ? row.name : this.validName(patch.name, id);
    const description = patch.description === undefined ? row.description : validDescription(patch.description);
    const color = patch.color === undefined ? row.color : validColor(patch.color);
    this.sql.exec("UPDATE categories SET name = ?, description = ?, color = ? WHERE id = ?", name, description, color, id);
    this.categoriesChanged(name !== row.name || description !== row.description);
    return this.list().find((c) => c.id === id)!;
  }

  /** Removes one of the user's own categories: its mail gets a quick guess again, and the classifier looks at it anew. */
  remove(id: string): { removed: boolean; moved: number } {
    if (BUILTIN_CATEGORIES.some((c) => c.id === id)) throw new Error("The built-in categories can't be removed.");
    if (!this.sql.exec("DELETE FROM categories WHERE id = ?", id).rowsWritten) return { removed: false, moved: 0 };
    this.sql.exec("DELETE FROM category_senders WHERE category = ?", id);
    const modseq = this.store.nextModseq();
    const moved = this.reguess("category = ?", [id], modseq);
    this.categoriesChanged(true, modseq);
    return { removed: true, moved };
  }

  // ---- "Categorize sender" ----

  senders(): CategorySender[] {
    return this.sql
      .exec<{ address: string; category: string; created_at: number }>("SELECT * FROM category_senders ORDER BY address")
      .toArray()
      .map((r) => ({ address: r.address, category: r.category, createdAt: r.created_at }));
  }

  /** Mail from this address always goes in that category: what it sent already, and what it sends next. */
  setSender(address: string, category: string): { sender: CategorySender; moved: number } {
    const from = normalizeAddress(String(address ?? ""));
    if (!from.includes("@")) throw new Error(`not an email address: ${address}`);
    if (!this.exists(String(category))) throw new Error(`No category ${category}.`);
    const sender = { address: from, category, createdAt: Date.now() };
    this.sql.exec(
      `INSERT INTO category_senders (address, category, created_at) VALUES (?, ?, ?)
       ON CONFLICT (address) DO UPDATE SET category = excluded.category`,
      from,
      category,
      sender.createdAt,
    );
    // The list changed, so the state does too: the other devices read it again.
    const modseq = this.store.nextModseq();
    // (rowsWritten counts index entries too, so the rows are counted.)
    const moved = this.sql
      .exec(
        `UPDATE messages SET category = ?, category_by = 'sender', category_confidence = NULL, updated_modseq = ?
         WHERE from_address = ? AND category_by IS NOT 'none' AND category IS NOT ? RETURNING seq`,
        category,
        modseq,
        from,
        category,
      )
      .toArray().length;
    this.sql.exec(
      "UPDATE messages SET category_by = 'sender', category_confidence = NULL WHERE from_address = ? AND category_by IS NOT 'none' AND category_by IS NOT 'sender'",
      from,
    );
    return { sender, moved };
  }

  /** Forgets a sender's category: its mail gets a quick guess again, and the classifier looks at it anew. */
  removeSender(address: string): { removed: boolean; moved: number } {
    const from = normalizeAddress(String(address ?? ""));
    if (!this.sql.exec("DELETE FROM category_senders WHERE address = ?", from).rowsWritten) return { removed: false, moved: 0 };
    const modseq = this.store.nextModseq();
    return { removed: true, moved: this.reguess("from_address = ? AND category_by = 'sender'", [from], modseq) };
  }

  // ---- New mail and old ----

  /** A new message's category: the user's word for its sender, or else the quick guess. */
  forNew(fromAddress: string | null, guessable: Guessable): { category: string; by: CategorySource } {
    const sender = fromAddress ? this.senderCategory(normalizeAddress(fromAddress)) : null;
    return sender ? { category: sender, by: "sender" } : { category: guessCategory(guessable), by: "guess" };
  }

  /**
   * Guesses a batch of the mail that came before categories did. No message counts as changed
   * (there could be tens of thousands; Email/changes would carry them all), but the state moves
   * once, so lists on screen are read again. Returns how many were guessed; 0 once all are.
   */
  fillGuesses(limit = GUESS_BATCH): number {
    const rows = this.sql
      .exec<GuessRow>(`SELECT ${GUESS_COLUMNS} FROM messages WHERE category_by IS NULL LIMIT ?`, limit)
      .toArray();
    if (!rows.length) return 0;
    const senders = new Map(this.senders().map((s) => [s.address, s.category]));
    for (const r of rows) {
      if (r.folder === "sent") {
        this.sql.exec("UPDATE messages SET category_by = 'none' WHERE seq = ?", r.seq);
        continue;
      }
      const sender = r.from_address ? senders.get(r.from_address) : undefined;
      this.sql.exec(
        "UPDATE messages SET category = ?, category_by = ? WHERE seq = ?",
        sender ?? guessCategory(guessable(r)),
        sender ? "sender" : "guess",
        r.seq,
      );
    }
    this.store.nextModseq();
    return rows.length;
  }

  // ---- The classifier's queue ----

  /**
   * The next messages for the classifier, newest first: the Inbox-view mail it hasn't looked at
   * that arrived in the last NEW_MAIL_MS, and older mail too (the backlog) unless it has an
   * allowance and it is before BACKLOG_FROM_UTC_HOUR. With an allowance, only as many as today's
   * tokens cover, the backlog leaving NEW_MAIL_RESERVE of the day to new mail; what they're
   * estimated to cost is set aside until apply says what they did. One sweep at a time (`owner`
   * holds a lease); null while another holds it.
   */
  work(owner: string, limit: number, budget: ClassifierBudget | null = null, now = Date.now()): CategoryWork | null {
    const lease = this.meta<ClassifierLease>("classifier_lease");
    if (lease && lease.owner !== owner && lease.until > now) return null;
    const view = this.store.inboxView();
    const newSince = now - NEW_MAIL_MS;
    const backlog = !budget || new Date(now).getUTCHours() >= BACKLOG_FROM_UTC_HOUR;
    const rows = this.sql
      .exec<WorkRow>(
        `SELECT ${GUESS_COLUMNS}, id, from_name, alias, received_at FROM messages
         WHERE category_by = 'guess' AND folder IN (${view.map(() => "?").join(", ")})${backlog ? "" : " AND received_at >= ?"}
         ORDER BY received_at DESC, seq DESC LIMIT ?`,
        ...view,
        ...(backlog ? [] : [newSince]),
        Math.max(1, Math.min(limit, 100)),
      )
      .toArray();
    const options = this.options();
    const usage = this.usage(now);
    const left = budget ? budget.dailyTokens - usage.tokens : Infinity;
    const reserve = budget ? Math.ceil(budget.dailyTokens * NEW_MAIL_RESERVE) : 0;
    let reserved = 0;
    let wakeAt: number | null = null;
    const messages: CategoryWork["messages"] = [];
    for (const r of rows) {
      const state = this.stateOf(r);
      if (budget) {
        const isNew = r.received_at >= newSince;
        const cost = estimateTokens(categoryRequest("", state, options));
        if (reserved + cost > (isNew ? left : left - reserve)) {
          // New mail waits for the reset; the backlog for tomorrow's hour.
          if (isNew) wakeAt = nextUtcDay(now);
          break;
        }
        reserved += cost;
      }
      messages.push({ id: r.id, state });
    }
    if (messages.length) {
      this.setMeta("classifier_lease", { owner, until: now + CLASSIFIER_LEASE_MS, reserved, day: usage.day } satisfies ClassifierLease);
      if (reserved) this.setMeta("classifier_usage", { ...usage, tokens: usage.tokens + reserved } satisfies ClassifierUsage);
    } else {
      this.release(owner);
    }
    return { generation: this.generation(), options, messages, wakeAt };
  }

  /**
   * The classifier's answers (null: it gave none worth keeping, so the guess stays), with the input
   * tokens each request cost. Only mail still waiting for it changes, and nothing at all if the
   * categories changed since `generation`; the tokens count either way. Returns how many messages
   * changed category.
   */
  apply(
    owner: string,
    generation: number,
    answers: readonly { id: string; answer: CategoryAnswer | null; tokens?: number }[],
    now = Date.now(),
  ): number {
    const lease = this.meta<ClassifierLease>("classifier_lease");
    if (lease?.owner === owner) {
      // What the batch cost, in place of what work set aside for it.
      const usage = this.usage(now);
      const spent = answers.reduce((n, a) => n + (a.tokens ?? 0), 0);
      const reserved = lease.day === usage.day ? (lease.reserved ?? 0) : 0;
      this.setMeta("classifier_usage", {
        day: usage.day,
        tokens: Math.max(0, usage.tokens - reserved + spent),
        asked: usage.asked + answers.length,
      } satisfies ClassifierUsage);
      this.setMeta("classifier_lease", { owner, until: now + CLASSIFIER_LEASE_MS, reserved: 0, day: usage.day } satisfies ClassifierLease);
    }
    if (generation !== this.generation()) return 0;
    let modseq: number | null = null;
    let changed = 0;
    for (const { id, answer } of answers) {
      const row = this.sql
        .exec<{ seq: number; category: string | null; category_by: string | null }>(
          "SELECT seq, category, category_by FROM messages WHERE id = ?",
          id,
        )
        .toArray()[0];
      if (!row || row.category_by !== "guess") continue;
      if (!answer || !this.exists(answer.category)) {
        this.sql.exec("UPDATE messages SET category_by = 'model', category_confidence = NULL WHERE seq = ?", row.seq);
      } else if (answer.category !== row.category) {
        modseq ??= this.store.nextModseq();
        this.sql.exec(
          "UPDATE messages SET category = ?, category_by = 'model', category_confidence = ?, updated_modseq = ? WHERE seq = ?",
          answer.category,
          answer.confidence,
          modseq,
          row.seq,
        );
        changed++;
      } else {
        this.sql.exec("UPDATE messages SET category_by = 'model', category_confidence = ? WHERE seq = ?", answer.confidence, row.seq);
      }
    }
    return changed;
  }

  /** Lets the next sweep have the queue. Tokens still set aside stay counted: the batch may well have cost them. */
  release(owner: string): void {
    if (this.meta<ClassifierLease>("classifier_lease")?.owner === owner) this.sql.exec("DELETE FROM meta WHERE key = 'classifier_lease'");
  }

  /** How the last sweep went. */
  noteClassifier(outcome: { ok: true; model: string } | { ok: false; model: string; error: string }, now = Date.now()): void {
    const m = this.classifierMeta();
    this.setMeta(
      "classifier",
      outcome.ok
        ? { ...m, model: outcome.model, lastOkAt: now, failures: 0 }
        : { ...m, model: outcome.model, lastErrorAt: now, lastError: outcome.error.slice(0, 300), failures: m.failures + 1 },
    );
  }

  classifierMeta(): ClassifierMeta {
    return { model: null, lastOkAt: null, lastErrorAt: null, lastError: null, failures: 0, ...this.meta<Partial<ClassifierMeta>>("classifier") };
  }

  /** After failed sweeps, when the classifier is worth asking again; null when it is now. */
  retryAt(): number | null {
    const { failures, lastErrorAt } = this.classifierMeta();
    if (!failures || lastErrorAt === null) return null;
    return lastErrorAt + Math.min(2 ** (failures - 1), MAX_BACKOFF_MINUTES) * 60_000;
  }

  status(configured: boolean, budget: ClassifierBudget | null = null, now = Date.now()): ClassifierStatus {
    const { model, lastOkAt, lastErrorAt, lastError } = this.classifierMeta();
    const view = this.store.inboxView();
    const newSince = now - NEW_MAIL_MS;
    const { pending, backlog } = this.sql
      .exec<{ pending: number; backlog: number }>(
        `SELECT coalesce(sum(received_at >= ?), 0) AS pending, coalesce(sum(received_at < ?), 0) AS backlog FROM messages
         WHERE category_by = 'guess' AND folder IN (${view.map(() => "?").join(", ")})`,
        newSince,
        newSince,
        ...view,
      )
      .one();
    const day = new Date(now);
    return {
      configured,
      model,
      lastOkAt,
      lastErrorAt,
      lastError,
      pending,
      backlog,
      usedTokens: this.usage(now).tokens,
      budget: budget && {
        dailyTokens: budget.dailyTokens,
        resetsAt: nextUtcDay(now),
        backlogFrom: Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), BACKLOG_FROM_UTC_HOUR),
      },
    };
  }

  // ---- Internals ----

  /** One message as the classifier is shown it. */
  private stateOf(r: WorkRow): CategoryState {
    return {
      from: r.from_address ? (r.from_name ? `${r.from_name} <${r.from_address}>` : r.from_address) : null,
      to: r.alias,
      subject: r.subject,
      text:
        this.sql
          .exec<{ text: string }>("SELECT substr(body, 1, ?) AS text FROM messages_fts WHERE rowid = ?", STATE_TEXT_CHARS, r.seq)
          .toArray()[0]?.text ?? r.preview,
      mailingList: r.list_id !== null,
      unsubscribeLink: r.list_unsubscribe !== null,
      vipSender: r.vip_rule_id !== null,
    };
  }

  /** What the classifier has been asked about today (UTC). */
  private usage(now: number): ClassifierUsage {
    const day = new Date(now).toISOString().slice(0, 10);
    const usage = this.meta<ClassifierUsage>("classifier_usage");
    return usage?.day === day ? usage : { day, tokens: 0, asked: 0 };
  }

  /**
   * The categories changed: the state moves (clients read the list again), and when the choices
   * did, everything the classifier sorted goes back in its queue to be asked about again.
   */
  private categoriesChanged(choicesChanged: boolean, modseq?: number): void {
    if (modseq === undefined) this.store.nextModseq();
    if (!choicesChanged) return;
    this.setMeta("category_generation", this.generation() + 1);
    this.sql.exec("UPDATE messages SET category_by = 'guess' WHERE category_by = 'model'");
  }

  /** Gives the messages matching `where` a fresh quick guess, and the classifier another look. Returns how many changed category. */
  private reguess(where: string, params: SqlStorageValue[], modseq: number): number {
    let changed = 0;
    for (const r of this.sql
      .exec<GuessRow & { category: string | null }>(`SELECT ${GUESS_COLUMNS}, category FROM messages WHERE ${where}`, ...params)
      .toArray()) {
      const category = guessCategory(guessable(r));
      if (category !== r.category) {
        this.sql.exec(
          "UPDATE messages SET category = ?, category_by = 'guess', category_confidence = NULL, updated_modseq = ? WHERE seq = ?",
          category,
          modseq,
          r.seq,
        );
        changed++;
      } else {
        this.sql.exec("UPDATE messages SET category_by = 'guess', category_confidence = NULL WHERE seq = ?", r.seq);
      }
    }
    return changed;
  }

  private generation(): number {
    return Number(this.meta<number>("category_generation") ?? 0);
  }

  private senderCategory(address: string): string | null {
    return (
      this.sql.exec<{ category: string }>("SELECT category FROM category_senders WHERE address = ?", address).toArray()[0]?.category ??
      null
    );
  }

  private customRows(): CategoryRow[] {
    return this.sql.exec<CategoryRow>("SELECT * FROM categories ORDER BY sort_order, created_at").toArray();
  }

  private customRow(id: string): CategoryRow | null {
    return this.sql.exec<CategoryRow>("SELECT * FROM categories WHERE id = ?", id).toArray()[0] ?? null;
  }

  private validName(value: unknown, self: string | null): string {
    const name = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
    if (!name) throw new Error("Give the category a name.");
    if (name.length > MAX_CATEGORY_NAME) throw new Error(`A category's name can be at most ${MAX_CATEGORY_NAME} characters.`);
    const lower = name.toLowerCase();
    if (lower === "all" || BUILTIN_CATEGORIES.some((c) => c.name.toLowerCase() === lower)) {
      throw new Error(`There's already a category called ${name}.`);
    }
    const clash = this.customRows().find((r) => r.id !== self && r.name.toLowerCase() === lower);
    if (clash) throw new Error(`There's already a category called ${clash.name}.`);
    return name;
  }

  private meta<T>(key: string): T | null {
    const row = this.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? (JSON.parse(row.value) as T) : null;
  }

  private setMeta(key: string, value: unknown): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }
}

/** The next 00:00 UTC, when Workers AI's daily allowance starts again. */
function nextUtcDay(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

function guessable(r: GuessRow): Guessable {
  return {
    fromAddress: r.from_address,
    subject: r.subject,
    preview: r.preview,
    listId: r.list_id,
    listUnsubscribe: r.list_unsubscribe,
    vip: r.vip_rule_id !== null,
  };
}

function validDescription(value: unknown): string {
  const description = typeof value === "string" ? value.trim() : "";
  if (!description) throw new Error("Say in a few words what belongs in the category.");
  if (description.length > MAX_CATEGORY_DESCRIPTION) {
    throw new Error(`A category's description can be at most ${MAX_CATEGORY_DESCRIPTION} characters.`);
  }
  return description;
}

function validColor(value: unknown): string {
  if (typeof value !== "string" || !(CATEGORY_COLORS as readonly string[]).includes(value)) {
    throw new Error(`color must be one of ${CATEGORY_COLORS.join(", ")}.`);
  }
  return value;
}
