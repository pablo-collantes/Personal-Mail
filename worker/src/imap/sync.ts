import { normalizeAddress } from "../address";
import { stableId } from "../ids";
import { type Dial, ImapClient, type MessageMeta } from "./client";
import type { ImapSourceConfig } from "./config";
import { ImapAuthError, ImapCommandError, type ListedMailbox } from "./protocol";

/** Where a fetched message goes: R2 plus the ingest queue (see saveFetched in ingest.ts). */
export interface FetchedMessage {
  id: string;
  source: string;
  receivedAt: number;
  raw: Uint8Array;
  envelopeFrom: string;
  alias: string;
  /** Imported from before we started watching: index it, never notify. */
  quiet: boolean;
  /** From the account's Sent folder: filed into Sent, already read. */
  sent?: boolean;
}

/** The subset of Durable Object storage the sync needs (so tests can use a Map). */
export interface StateStore {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface SyncDeps {
  dial: Dial;
  state: StateStore;
  save: (message: FetchedMessage) => Promise<void>;
  now: () => number;
  /** Stop starting new fetches after this time; the next run carries on. */
  deadline: number;
  /** Bigger messages are imported as their header plus a note. */
  maxMessageBytes: number;
  /** Backfill download cap per UTC day (Gmail allows 2500 MB/day of IMAP downloads). */
  dailyBackfillBytes: number;
}

export type SyncReport =
  | { status: "ok"; imported: number; backfilled: number; bytes: number; backfillDone: boolean }
  | { status: "auth-backoff"; retryAt: number }
  | { status: "auth-failed"; error: string; retryAt: number };

interface MailboxCursor {
  uidValidity: number;
  /** UIDs at or above this arrived after we started watching. */
  boundary: number;
  /** Highest new-mail UID handled. */
  lastUid: number;
  /** Backfill has handled every UID from here up to the boundary. */
  backfillBelow: number;
}

interface AuthFailure {
  at: number;
  count: number;
  fingerprint: string;
}

interface Usage {
  day: string;
  bytes: number;
}

/** Marks our header-only stand-in for a message over the size limit. */
export const TRUNCATED_HEADER = "X-Personal-Mail-Truncated";

const META_BATCH = 50;
const BACKFILL_WINDOW = 1000;
/** Retry a rejected password after 15 min, 1 h, then every 6 h, so a bad password can't get the account locked. */
const AUTH_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000];

/**
 * One polling pass over an IMAP account: new mail in every folder first
 * (oldest first), then, if enabled, older mail (newest first). Progress is
 * saved after every message, so a run cut short resumes where it stopped.
 */
export async function syncSource(source: ImapSourceConfig, password: string, deps: SyncDeps): Promise<SyncReport> {
  const fingerprint = await passwordFingerprint(password);
  const failure = await deps.state.get<AuthFailure>("authFailure");
  const sameFailure = failure?.fingerprint === fingerprint ? failure : undefined;
  if (sameFailure && deps.now() < retryAt(sameFailure)) return { status: "auth-backoff", retryAt: retryAt(sameFailure) };

  const client = await ImapClient.open(deps.dial, source.host, source.port, deps.maxMessageBytes + 64 * 1024);
  const report = { imported: 0, backfilled: 0, bytes: 0 };
  try {
    try {
      await client.login(source.user, password);
    } catch (err) {
      if (!(err instanceof ImapAuthError)) throw err;
      const next = { at: deps.now(), count: (sameFailure?.count ?? 0) + 1, fingerprint };
      await deps.state.put("authFailure", next);
      return { status: "auth-failed", error: err.message, retryAt: retryAt(next) };
    }
    if (failure) await deps.state.delete("authFailure");

    const watched: Watched[] = source.mailboxes.map((name) => ({ name, sent: false }));
    const sent = await sentMailbox(client, source, deps);
    if (sent !== null && !source.mailboxes.includes(sent)) watched.push({ name: sent, sent: true });

    // New mail everywhere before any history, so a long backfill never holds it up.
    for (const box of [...watched]) {
      let outcome: "done" | "out-of-time";
      try {
        outcome = await syncNew(client, source, box, deps, report);
      } catch (err) {
        if (!box.sent || !(err instanceof ImapCommandError)) throw err;
        // The Sent folder was renamed or deleted: look for it again next run.
        console.warn("imap: sent mail folder is gone", { source: source.name, mailbox: box.name, error: err.message });
        await deps.state.delete(SENT_KEY);
        watched.splice(watched.indexOf(box), 1);
        continue;
      }
      if (outcome === "out-of-time") return { status: "ok", ...report, backfillDone: false };
    }

    if (!source.backfill) return { status: "ok", ...report, backfillDone: true };
    let backfillDone = true;
    for (const box of watched) {
      const done = await syncBackfill(client, source, box, deps, report);
      if (done === "out-of-time") return { status: "ok", ...report, backfillDone: false };
      backfillDone &&= done === "complete";
    }
    return { status: "ok", ...report, backfillDone };
  } finally {
    await client.logout();
  }
}

/** A folder a run reads, and whether it holds the account's own sent mail. */
interface Watched {
  name: string;
  sent: boolean;
}

type Report = { imported: number; backfilled: number; bytes: number };

/** Where the Sent folder found on the account is remembered: `{ name, at }`, name null when there was none. */
const SENT_KEY = "sentMailbox";
/** How long before looking again for a Sent folder that wasn't there. */
const SENT_RETRY_MS = 24 * 60 * 60_000;
/** Usual names of a Sent folder (the last part of its path), for servers that don't mark it \Sent. */
const SENT_NAMES = ["sent", "sent items", "sent messages", "sent mail", "enviados", "elementos enviados", "mensajes enviados"];

/** The account's Sent folder: as configured, or found once (LIST) and remembered. */
async function sentMailbox(client: ImapClient, source: ImapSourceConfig, deps: SyncDeps): Promise<string | null> {
  if (source.sent === false) return null;
  if (typeof source.sent === "string") return source.sent;
  const known = await deps.state.get<{ name: string | null; at: number }>(SENT_KEY);
  if (known && (known.name !== null || deps.now() - known.at < SENT_RETRY_MS)) return known.name;
  const name = findSentMailbox(await client.list());
  await deps.state.put(SENT_KEY, { name, at: deps.now() });
  console.log("imap: sent mail folder", { source: source.name, mailbox: name });
  return name;
}

/** The folder marked \Sent (RFC 6154), else one with a usual Sent name. */
export function findSentMailbox(boxes: ListedMailbox[]): string | null {
  const selectable = boxes.filter((b) => !b.attributes.includes("\\noselect") && !b.attributes.includes("\\nonexistent"));
  const marked = selectable.find((b) => b.attributes.includes("\\sent"));
  if (marked) return marked.name;
  const leaf = (b: ListedMailbox) => (b.delimiter ? b.name.split(b.delimiter).at(-1)! : b.name).toLowerCase();
  for (const wanted of SENT_NAMES) {
    const named = selectable.find((b) => leaf(b) === wanted);
    if (named) return named.name;
  }
  return null;
}

/** New mail in one folder, oldest first. The first time a folder is seen, what's in it becomes history. */
async function syncNew(
  client: ImapClient,
  source: ImapSourceConfig,
  box: Watched,
  deps: SyncDeps,
  report: Report,
): Promise<"done" | "out-of-time"> {
  const status = await client.examine(box.name);
  const key = `cursor:${box.name}`;
  let cursor = await deps.state.get<MailboxCursor>(key);
  if (!cursor || cursor.uidValidity !== status.uidValidity) {
    if (cursor) console.warn("imap: UIDVALIDITY changed, starting this mailbox over", { source: source.name, mailbox: box.name });
    cursor = {
      uidValidity: status.uidValidity,
      boundary: status.uidNext,
      lastUid: status.uidNext - 1,
      backfillBelow: status.uidNext,
    };
    await deps.state.put(key, cursor);
  }
  const c = cursor;
  if (status.uidNext > c.lastUid + 1) {
    const uids = (await client.search(c.lastUid + 1, "*")).filter((u) => u > c.lastUid);
    const finished = await importUids({ client, source, box, cursor: c, key, deps, report }, uids, false, (uid) => (c.lastUid = uid));
    if (!finished) return "out-of-time";
    c.lastUid = Math.max(c.lastUid, status.uidNext - 1);
    await deps.state.put(key, c);
  }
  return "done";
}

/** Mail that was already in one folder, newest first, a window of UIDs at a time. */
async function syncBackfill(
  client: ImapClient,
  source: ImapSourceConfig,
  box: Watched,
  deps: SyncDeps,
  report: Report,
): Promise<MailboxOutcome> {
  const key = `cursor:${box.name}`;
  const c = await deps.state.get<MailboxCursor>(key);
  if (!c || c.backfillBelow <= 1) return "complete";
  const outOfTime = () => deps.now() >= deps.deadline;
  if (outOfTime()) return "out-of-time";
  if (!(await withinBudget(deps))) return "backfill-pending";
  // New mail left another folder open. Renumbered meanwhile: the next run's new-mail pass starts it over.
  if ((await client.examine(box.name)).uidValidity !== c.uidValidity) return "backfill-pending";
  const ctx = { client, source, box, cursor: c, key, deps, report };
  while (c.backfillBelow > 1) {
    if (outOfTime()) return "out-of-time";
    if (!(await withinBudget(deps))) return "backfill-pending";
    const low = Math.max(1, c.backfillBelow - BACKFILL_WINDOW);
    const uids = (await client.search(low, c.backfillBelow - 1)).filter((u) => u >= low && u < c.backfillBelow).reverse();
    const finished = await importUids(ctx, uids, true, (uid) => (c.backfillBelow = uid));
    if (!finished) return outOfTime() ? "out-of-time" : "backfill-pending";
    c.backfillBelow = low;
    await deps.state.put(key, c);
  }
  return "complete";
}

type MailboxOutcome = "complete" | "backfill-pending" | "out-of-time";

interface FolderRun {
  client: ImapClient;
  source: ImapSourceConfig;
  box: Watched;
  cursor: MailboxCursor;
  /** The cursor's storage key. */
  key: string;
  deps: SyncDeps;
  report: Report;
}

/** Imports these UIDs in order, saving the cursor after each. False when time or the budget ran out first. */
async function importUids(run: FolderRun, uids: number[], quiet: boolean, advance: (uid: number) => void): Promise<boolean> {
  const { client, deps } = run;
  for (let i = 0; i < uids.length; i += META_BATCH) {
    const batch = uids.slice(i, i + META_BATCH);
    const metas = new Map((await client.fetchMeta(batch)).map((m) => [m.uid, m]));
    for (const uid of batch) {
      if (deps.now() >= deps.deadline || (quiet && !(await withinBudget(deps)))) return false;
      const meta = metas.get(uid);
      // No metadata: expunged since the search. Nothing to import.
      if (meta) await importOne(run, meta, quiet);
      advance(uid);
      await deps.state.put(run.key, run.cursor);
    }
  }
  return true;
}

async function importOne(run: FolderRun, meta: MessageMeta, quiet: boolean): Promise<void> {
  const { client, source, box, deps, report } = run;
  const mailbox = box.name;
  const tooLarge = meta.size > deps.maxMessageBytes;
  const fetched = await client.fetchBody(meta.uid, tooLarge ? "HEADER" : "");
  if (!fetched) return;
  await addUsage(deps, fetched.byteLength);
  report.bytes += fetched.byteLength;

  const raw = tooLarge ? headerOnly(fetched, meta.size, source, mailbox, deps.maxMessageBytes) : fetched;
  const headers = parseHeaders(raw);
  // Gmail's message id survives moves between labels; UIDs don't.
  const identity = meta.gmMsgId ? `gm:${meta.gmMsgId}` : `${mailbox}\0${run.cursor.uidValidity}\0${meta.uid}`;
  await deps.save({
    id: await stableId(meta.internalDate ?? deps.now(), `${source.name}\0${identity}`),
    source: source.name,
    receivedAt: meta.internalDate ?? deps.now(),
    raw,
    envelopeFrom: normalizeAddress(headers.get("return-path") ?? ""),
    alias: box.sent ? source.address : aliasFor(headers.get("delivered-to"), source.address),
    quiet,
    ...(box.sent ? { sent: true } : {}),
  });
  if (quiet) report.backfilled++;
  else report.imported++;
}

/**
 * The alias to file under: the account address, or the +tagged form of it
 * the mail was actually delivered to (the topmost Delivered-To), so tags keep
 * working for leak tracing.
 */
export function aliasFor(deliveredTo: string | undefined, address: string): string {
  const delivered = normalizeAddress(deliveredTo ?? "");
  const [local, domain] = address.split("@");
  const m = /^([^@+]+)\+[^@]+@(.+)$/.exec(delivered);
  return m && m[1] === local && m[2] === domain ? delivered : address;
}

/** Topmost value of each header field (lowercase names), from the message's header block. */
export function parseHeaders(raw: Uint8Array): Map<string, string> {
  const text = headerText(raw);
  const out = new Map<string, string>();
  for (const field of text.split(/\r?\n(?![ \t])/)) {
    const colon = field.indexOf(":");
    if (colon <= 0) continue;
    const name = field.slice(0, colon).trim().toLowerCase();
    if (!out.has(name)) out.set(name, field.slice(colon + 1).replace(/\r?\n[ \t]+/g, " ").trim());
  }
  return out;
}

function headerText(raw: Uint8Array): string {
  const text = new TextDecoder().decode(raw.subarray(0, Math.min(raw.length, 256 * 1024)));
  const end = text.search(/\r?\n\r?\n/);
  return end < 0 ? text : text.slice(0, end);
}

/** Stand-in for a message too big to import: its real header, and a plain-text note instead of the body. */
function headerOnly(header: Uint8Array, size: number, source: ImapSourceConfig, mailbox: string, limit: number): Uint8Array {
  const kept = headerText(header)
    .split(/\r?\n(?![ \t])/)
    .filter((field) => !/^(content-[a-z-]+|mime-version)\s*:/i.test(field));
  const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
  const note =
    `This message is ${mb(size)} MB, over the ${mb(limit)} MB import limit, so only its header was imported.\r\n` +
    `The full message is still in the ${mailbox} folder of ${source.user} on ${source.host}.\r\n`;
  return new TextEncoder().encode(
    `${kept.join("\r\n")}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n${TRUNCATED_HEADER}: ${size}\r\n\r\n${note}`,
  );
}

async function withinBudget(deps: SyncDeps): Promise<boolean> {
  const usage = await deps.state.get<Usage>("usage");
  return !usage || usage.day !== utcDay(deps.now()) || usage.bytes < deps.dailyBackfillBytes;
}

async function addUsage(deps: SyncDeps, bytes: number): Promise<void> {
  const day = utcDay(deps.now());
  const usage = await deps.state.get<Usage>("usage");
  await deps.state.put("usage", { day, bytes: (usage?.day === day ? usage.bytes : 0) + bytes });
}

function utcDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

function retryAt(failure: AuthFailure): number {
  return failure.at + AUTH_BACKOFF_MS[Math.min(failure.count, AUTH_BACKOFF_MS.length) - 1]!;
}

/** Tells "same rejected password" from "password was changed" without storing the password. */
async function passwordFingerprint(password: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`personal-mail imap\0${password}`));
  return [...new Uint8Array(digest).subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
