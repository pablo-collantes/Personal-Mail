import PostalMime, { type Address, type Email } from "postal-mime";
import { domainOf, normalizeAddress } from "./address";
import { authVerdict, parseTrustedIds } from "./auth-results";
import { dkimVerdict, formatDkimResults, verifyDkim } from "./dkim";
import { attachmentKey, htmlKey, idFromRawKey, idTime, idTimePrefix, newId, rawKey } from "./ids";
import { imapSources } from "./imap/config";
import { spamVerdict } from "./spam";
import { TRUNCATED_HEADER, type FetchedMessage } from "./imap/sync";
import { TEXT_LIMIT, htmlToText, makePreview } from "./text";
import type { AddressEntry, AttachmentMeta, AuthVerdict, IngestJob, IngestRecord, IngestResult } from "./types";

const RECONCILE_WINDOW_MS = 3 * 86_400_000;
const RECONCILE_GRACE_MS = 15 * 60_000;
const QUEUE_BATCH = 100;
/** Past this age, a signature that no longer verifies may just mean the sender has rotated its key. */
const KEY_ROTATION_MS = 7 * 86_400_000;

export type Enqueue = (jobs: IngestJob[]) => Promise<void>;

export function queueSender(env: Env): Enqueue {
  return async (jobs) => {
    for (let i = 0; i < jobs.length; i += QUEUE_BATCH) {
      await env.INGEST_QUEUE.sendBatch(jobs.slice(i, i + QUEUE_BATCH).map((body) => ({ body })));
    }
  };
}

function mailbox(env: Env) {
  return env.MAILBOX.getByName(env.MAILBOX_NAME);
}

/**
 * Email Routing entry point. The raw message goes to R2 before anything that
 * can fail on our side, then it's queued for parsing and indexing.
 */
export async function receiveEmail(
  message: ForwardableEmailMessage,
  env: Env,
  enqueue: Enqueue = queueSender(env),
): Promise<IngestJob | null> {
  const receivedAt = Date.now();
  const recipient = normalizeAddress(message.to);
  if (logAuthHeaders(env)) logRoutingHeaders(message);

  let admission: "accept" | "reject" = "accept";
  try {
    admission = await mailbox(env).admit(recipient);
  } catch (err) {
    // Storing unwanted mail beats losing wanted mail.
    console.error("admit failed, accepting", { recipient, error: String(err) });
  }
  if (admission === "reject") {
    message.setReject("Address does not exist");
    console.log("rejected", { recipient });
    return null;
  }

  const id = newId(receivedAt);
  const raw = await new Response(message.raw).arrayBuffer();
  await env.MAIL_BUCKET.put(rawKey(id), raw, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: { envelopeFrom: message.from, envelopeTo: recipient, receivedAt: String(receivedAt) },
  });

  const job: IngestJob = { id, receivedAt, envelopeFrom: message.from, envelopeTo: recipient, size: raw.byteLength };
  try {
    await enqueue([job]);
  } catch (err) {
    // The raw message is safe in R2; reconcile() will find and queue it.
    console.error("enqueue failed, reconcile will retry", { id, error: String(err) });
  }
  return job;
}

/**
 * IMAP entry point: store a fetched message and queue it. Unlike Email Routing
 * mail, a failed enqueue throws, so the poller retries instead of relying on
 * reconcile (which only looks at recent ids; backfilled ids are old).
 */
export async function saveFetched(env: Env, m: FetchedMessage, enqueue: Enqueue = queueSender(env)): Promise<IngestJob> {
  await env.MAIL_BUCKET.put(rawKey(m.id), m.raw, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: {
      envelopeFrom: m.envelopeFrom,
      envelopeTo: m.alias,
      receivedAt: String(m.receivedAt),
      source: m.source,
      ...(m.quiet ? { quiet: "1" } : {}),
      ...(m.sent ? { sent: "1" } : {}),
    },
  });
  const job: IngestJob = {
    id: m.id,
    receivedAt: m.receivedAt,
    envelopeFrom: m.envelopeFrom,
    envelopeTo: m.alias,
    size: m.raw.byteLength,
    source: m.source,
    ...(m.quiet ? { quiet: true } : {}),
    ...(m.sent ? { sent: true } : {}),
  };
  await enqueue([job]);
  return job;
}

/** Queue consumer: parse a stored raw message, store its parts, index it. */
export async function indexMessage(env: Env, job: IngestJob): Promise<IngestResult | { status: "missing" }> {
  const object = await env.MAIL_BUCKET.get(rawKey(job.id));
  if (!object) return { status: "missing" };

  const raw = await object.arrayBuffer();
  let email: Email | null = null;
  let parseError: string | null = null;
  try {
    email = await PostalMime.parse(raw, { attachmentEncoding: "arraybuffer" });
  } catch (err) {
    parseError = String(err);
    console.error("parse failed, indexing envelope only", { id: job.id, error: parseError });
  }

  const record = email
    ? await storeParts(env, job, email, raw, trustedAuthservIds(env, job.source))
    : unparsedRecord(job, parseError ?? "unknown error");
  return mailbox(env).ingest(job.sent ? { ...record, sent: true } : record);
}

/**
 * Re-queues raw messages from the last few days that never got indexed (a
 * failed enqueue, or a job that exhausted its retries).
 */
export async function reconcile(env: Env, now = Date.now(), enqueue: Enqueue = queueSender(env)): Promise<number> {
  const candidates: IngestJob[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.MAIL_BUCKET.list({
      prefix: "raw/",
      startAfter: `raw/${idTimePrefix(now - RECONCILE_WINDOW_MS)}`,
      include: ["customMetadata"],
      cursor,
    });
    for (const object of page.objects) {
      const id = idFromRawKey(object.key);
      const meta = object.customMetadata;
      if (!id || !meta?.envelopeTo || idTime(id) > now - RECONCILE_GRACE_MS) continue;
      candidates.push({
        id,
        receivedAt: Number(meta.receivedAt) || idTime(id),
        envelopeFrom: meta.envelopeFrom ?? "",
        envelopeTo: meta.envelopeTo,
        size: object.size,
        ...(meta.source ? { source: meta.source } : {}),
        ...(meta.quiet ? { quiet: true } : {}),
        ...(meta.sent ? { sent: true } : {}),
      });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  if (!candidates.length) return 0;
  const unindexed = new Set(await mailbox(env).unindexed(candidates.map((j) => j.id)));
  const jobs = candidates.filter((j) => unindexed.has(j.id));
  if (jobs.length) await enqueue(jobs);
  return jobs.length;
}

export async function runMaintenance(env: Env): Promise<void> {
  const requeued = await reconcile(env);
  const { blobsCleared, expired } = await mailbox(env).maintain();
  console.log("maintenance", { requeued, blobsCleared, expired });
}

/** Mail from Email Routing trusts Cloudflare's header; IMAP mail trusts its own provider's. */
function trustedAuthservIds(env: Env, source: string | undefined): Set<string> {
  if (!source) return parseTrustedIds(env.TRUSTED_AUTHSERV_IDS);
  return new Set(imapSources(env).find((s) => s.name === source)?.trustedAuthservIds ?? []);
}

async function storeParts(
  env: Env,
  job: IngestJob,
  email: Email,
  raw: ArrayBuffer,
  trusted: ReadonlySet<string>,
): Promise<IngestRecord> {
  const attachments: AttachmentMeta[] = [];
  for (const [idx, a] of email.attachments.entries()) {
    const content = typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content;
    const mimeType = a.mimeType || "application/octet-stream";
    await env.MAIL_BUCKET.put(attachmentKey(job.id, idx), content, { httpMetadata: { contentType: mimeType } });
    attachments.push({
      idx,
      filename: a.filename,
      mimeType,
      size: content.byteLength,
      disposition: a.disposition,
      contentId: a.contentId ?? null,
    });
  }
  if (email.html) {
    await env.MAIL_BUCKET.put(htmlKey(job.id), email.html, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
    });
  }

  const text = (email.text ?? (email.html ? htmlToText(email.html) : "")).trim().slice(0, TEXT_LIMIT);
  const from = firstMailbox(email.from);
  const { auth, authResults } = await authenticate(job, email, raw, trusted, domainOf(from?.address));
  if (logAuthHeaders(env)) {
    console.log("auth headers (raw message view)", {
      id: job.id,
      authenticationResults: email.headers.filter((h) => h.key === "authentication-results").map((h) => h.value),
    });
  }

  return {
    id: job.id,
    receivedAt: job.receivedAt,
    envelopeFrom: job.envelopeFrom,
    alias: job.envelopeTo,
    size: job.size,
    messageId: email.messageId ?? null,
    inReplyTo: email.inReplyTo ?? null,
    references: email.references ?? null,
    subject: email.subject ?? "",
    from,
    to: flatten(email.to),
    cc: flatten(email.cc),
    replyTo: flatten(email.replyTo),
    sentAt: parseDate(email.date),
    text,
    preview: makePreview(text),
    hasHtml: Boolean(email.html),
    attachments,
    auth,
    authResults,
    spam: spamVerdict(header(email, "x-spam-status"), header(email, "x-spam-flag")),
    listId: header(email, "list-id"),
    listUnsubscribe: header(email, "list-unsubscribe"),
    parseError: null,
  };
}

/**
 * The receiving server's verdict when its Authentication-Results header is one
 * we trust. Otherwise (some providers add none) we check the DKIM signatures
 * ourselves and record the result in the same format.
 */
async function authenticate(
  job: IngestJob,
  email: Email,
  raw: ArrayBuffer,
  trusted: ReadonlySet<string>,
  fromDomain: string | null,
): Promise<{ auth: AuthVerdict; authResults: string | null }> {
  const topmost = header(email, "authentication-results");
  const receiverVerdict = authVerdict(topmost, trusted, fromDomain);
  // "none" here means there was no trusted header to read.
  if (receiverVerdict !== "none") return { auth: receiverVerdict, authResults: topmost };
  // Our stand-in for an oversized message keeps the header but not the signed body.
  if (header(email, TRUNCATED_HEADER.toLowerCase())) return { auth: "none", authResults: topmost };
  try {
    const check = await verifyDkim(new Uint8Array(raw), { now: job.receivedAt });
    const keyMayHaveChanged = Date.now() - job.receivedAt > KEY_ROTATION_MS;
    return { auth: dkimVerdict(check, fromDomain, keyMayHaveChanged), authResults: formatDkimResults(check) };
  } catch (err) {
    // A bug here must not stop the message from being indexed.
    console.error("dkim check failed", { id: job.id, error: String(err) });
    return { auth: "none", authResults: topmost };
  }
}

/** Debugging switch; `wrangler types` types it as whichever literal is committed, hence the cast. */
function logAuthHeaders(env: Env): boolean {
  return (env.LOG_AUTH_HEADERS as string) === "true";
}

function unparsedRecord(job: IngestJob, parseError: string): IngestRecord {
  return {
    id: job.id,
    receivedAt: job.receivedAt,
    envelopeFrom: job.envelopeFrom,
    alias: job.envelopeTo,
    size: job.size,
    messageId: null,
    inReplyTo: null,
    references: null,
    subject: "(message could not be parsed)",
    from: null,
    to: [],
    cc: [],
    replyTo: [],
    sentAt: null,
    text: "",
    preview: "",
    hasHtml: false,
    attachments: [],
    auth: "none",
    authResults: null,
    spam: null,
    listId: null,
    listUnsubscribe: null,
    parseError,
  };
}

/** First header with this (lowercase) name, i.e. the topmost one. */
function header(email: Email, key: string): string | null {
  return email.headers.find((h) => h.key === key)?.value ?? null;
}

function flatten(addresses: Address[] | undefined): AddressEntry[] {
  return (addresses ?? []).flatMap((a) =>
    a.group ? a.group.map((m) => ({ name: m.name, address: m.address })) : [{ name: a.name, address: a.address }],
  );
}

function firstMailbox(address: Address | undefined): AddressEntry | null {
  const first = address ? flatten([address])[0] : undefined;
  return first?.address ? first : null;
}

function parseDate(date: string | undefined): number | null {
  const t = date ? Date.parse(date) : NaN;
  return Number.isNaN(t) ? null : t;
}

const ROUTING_HEADERS = new Set([
  "authentication-results",
  "arc-authentication-results",
  "received-spf",
  "delivered-to",
  "x-forwarded-to",
  "x-forwarded-for",
]);

/** Test-phase diagnostics: which auth headers does Email Routing hand us? */
function logRoutingHeaders(message: ForwardableEmailMessage): void {
  const found: Record<string, string> = {};
  for (const [key, value] of message.headers) if (ROUTING_HEADERS.has(key)) found[key] = value;
  console.log("auth headers (Email Routing view)", {
    to: message.to,
    envelopeFrom: message.from,
    headerNames: [...new Set(message.headers.keys())],
    found,
  });
}
