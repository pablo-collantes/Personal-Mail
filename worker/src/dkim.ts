import { aligned, domainOf } from "./address";
import type { AuthVerdict } from "./types";

// DKIM verification (RFC 6376, updated by RFC 8301 and RFC 8463), for mail
// whose receiving server leaves no Authentication-Results header we can trust:
// some providers record none. The signature travels inside the message, so
// checking it here, after the fact, is as good as the receiver checking it, as
// long as the sender still publishes the key.
//
// Headers are handled as "binary" strings, one character per byte, so raw
// 8-bit header bytes hash exactly as they arrived.

export type DkimStatus = "pass" | "fail" | "neutral" | "permerror" | "temperror";

export interface DkimSignatureResult {
  status: DkimStatus;
  /** Signing domain (d=), lowercase. */
  domain: string | null;
  selector: string | null;
  algorithm: string | null;
  /** Why it didn't pass. */
  reason: string | null;
}

export interface DkimCheck {
  signatures: DkimSignatureResult[];
  /** From header fields in the message. More than one is a known way to fool verifiers (RFC 6376 §8.15). */
  fromFields: number;
}

/** A name's TXT records, each one's strings joined. null when there are none; throws when the lookup itself failed. */
export type TxtResolver = (name: string) => Promise<string[] | null>;

/** The authserv-id on the Authentication-Results we record for our own checks. */
export const DKIM_AUTHSERV_ID = "personal-mail";

/** A failure a since-rotated key would also explain (unlike a body that no longer matches). */
export const SIGNATURE_MISMATCH = "signature did not verify";

const MAX_SIGNATURES = 5;
const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const HTAB = 0x09;

export async function verifyDkim(
  raw: Uint8Array,
  { resolveTxt = resolveTxtOverHttps, now = Date.now() }: { resolveTxt?: TxtResolver; now?: number } = {},
): Promise<DkimCheck> {
  const { fields, body } = splitMessage(raw);
  const bodyHashes = new Map<string, Promise<BodyHash>>();
  const hashBodyOnce = (relaxed: boolean, limit: number | null) => {
    const key = `${relaxed}/${limit}`;
    let hash = bodyHashes.get(key);
    if (!hash) bodyHashes.set(key, (hash = hashBody(body, relaxed, limit)));
    return hash;
  };

  const signatures: DkimSignatureResult[] = [];
  for (const field of fields.filter((f) => f.name === "dkim-signature").slice(0, MAX_SIGNATURES)) {
    signatures.push(await verifySignature(field, fields, hashBodyOnce, resolveTxt, now));
  }
  return { signatures, fromFields: fields.filter((f) => f.name === "from").length };
}

/**
 * "pass" when a signature from the From domain (or one sharing its
 * organizational domain) verifies. "fail" when the message has two From
 * fields, or one of the From domain's signatures is broken in a way a key
 * rotated since can't explain. "none" otherwise: unsigned, signed only by
 * someone else (a mailing list, an email provider), or unknowable.
 */
export function dkimVerdict(check: DkimCheck, fromDomain: string | null, keyMayHaveChanged: boolean): AuthVerdict {
  if (check.fromFields > 1) return "fail";
  if (!fromDomain) return "none";
  const own = check.signatures.filter((s) => s.domain !== null && aligned(fromDomain, s.domain));
  if (own.some((s) => s.status === "pass")) return "pass";
  const broken = own.some((s) => s.status === "fail" && !(keyMayHaveChanged && s.reason === SIGNATURE_MISMATCH));
  return broken ? "fail" : "none";
}

/** The results as an Authentication-Results header value (RFC 8601), for display. */
export function formatDkimResults(check: DkimCheck): string {
  const safe = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "?");
  const results = check.signatures.map((s) =>
    [
      `dkim=${s.status}`,
      s.reason && `(${s.reason.replace(/[();\\]/g, " ")})`,
      s.domain && `header.d=${safe(s.domain)}`,
      s.selector && `header.s=${safe(s.selector)}`,
      s.algorithm && `header.a=${safe(s.algorithm)}`,
    ]
      .filter(Boolean)
      .join(" "),
  );
  if (check.fromFields > 1) results.push(`x-from-fields=${check.fromFields}`);
  return [DKIM_AUTHSERV_ID, ...(results.length ? results : ["dkim=none"])].join("; ");
}

async function verifySignature(
  field: HeaderField,
  fields: readonly HeaderField[],
  hashBody: (relaxed: boolean, limit: number | null) => Promise<BodyHash>,
  resolveTxt: TxtResolver,
  now: number,
): Promise<DkimSignatureResult> {
  const tags = parseTags(field.raw.slice(field.raw.indexOf(":") + 1));
  const domain = tags?.get("d")?.toLowerCase() ?? null;
  const selector = tags?.get("s") ?? null;
  const algorithm = tags?.get("a")?.toLowerCase() ?? null;
  const result = (status: DkimStatus, reason: string | null = null): DkimSignatureResult => ({
    status,
    domain,
    selector,
    algorithm,
    reason,
  });

  if (!tags) return result("permerror", "malformed signature");
  for (const tag of ["v", "a", "b", "bh", "d", "h", "s"]) {
    if (!tags.has(tag)) return result("permerror", `no ${tag}= tag`);
  }
  if (tags.get("v") !== "1") return result("permerror", "unknown version");
  if (!domain || domainOf(domain) !== domain || !/^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/i.test(selector!)) {
    return result("permerror", "malformed d= or s=");
  }
  // RFC 8301: SHA-1 signatures no longer count.
  if (algorithm === "rsa-sha1") return result("neutral", "rsa-sha1 is no longer accepted");
  if (algorithm !== "rsa-sha256" && algorithm !== "ed25519-sha256") return result("permerror", "unknown algorithm");

  const canon = (tags.get("c") ?? "simple/simple").toLowerCase().split("/");
  const [headerCanon, bodyCanon = "simple"] = canon;
  if (canon.length > 2 || !isCanon(headerCanon) || !isCanon(bodyCanon)) {
    return result("permerror", "unknown canonicalization");
  }
  const signedNames = tags
    .get("h")!
    .split(":")
    .map((name) => asciiLower(name.replace(/[ \t\r\n]/g, "")));
  if (!signedNames.includes("from")) return result("permerror", "From is not signed");

  const identity = tags.get("i");
  const identityDomain = identity === undefined ? domain : asciiLower(identity.slice(identity.lastIndexOf("@") + 1));
  if (
    identity !== undefined &&
    (!identity.includes("@") || (identityDomain !== domain && !identityDomain.endsWith(`.${domain}`)))
  ) {
    return result("permerror", "i= is outside d=");
  }
  const length = tags.get("l");
  if (length !== undefined && !/^\d{1,15}$/.test(length)) return result("permerror", "malformed l=");
  const expires = tags.get("x");
  if (expires !== undefined) {
    if (!/^\d{1,12}$/.test(expires)) return result("permerror", "malformed x=");
    if (Number(expires) * 1000 < now) return result("neutral", "signature expired");
  }
  const bodyHash = base64(tags.get("bh")!);
  const signature = base64(tags.get("b")!);
  if (!bodyHash || !signature) return result("permerror", "malformed bh= or b=");

  let records: string[] | null;
  try {
    records = await resolveTxt(`${selector}._domainkey.${domain}`);
  } catch {
    return result("temperror", "key lookup failed");
  }
  const key = pickKey(records, algorithm);
  if (typeof key === "string") return result("permerror", key);
  // RFC 6376 §3.6.1: a key in testing mode makes the mail count as unsigned.
  if (key.testing) return result("neutral", "key is in testing mode");
  if (key.strict && identityDomain !== domain) return result("permerror", "i= must equal d= for this key");

  const limit = length === undefined ? null : Number(length);
  const computed = await hashBody(bodyCanon === "relaxed", limit);
  // A partial-body signature lets anyone append to the body.
  if (limit !== null && limit !== computed.length) return result("neutral", "l= doesn't cover the whole body");
  if (!bytesEqual(computed.hash, bodyHash)) return result("fail", "body hash did not verify");

  const data = signedHeaderData(fields, signedNames, field, headerCanon === "relaxed");
  const verified = await verifyBytes(algorithm, key.data, signature, data);
  if (typeof verified === "string") return result("permerror", verified);
  return verified ? result("pass") : result("fail", SIGNATURE_MISMATCH);
}

function isCanon(value: string | undefined): value is "simple" | "relaxed" {
  return value === "simple" || value === "relaxed";
}

interface PublicKey {
  data: Uint8Array;
  testing: boolean;
  strict: boolean;
}

/** The first usable key record, or why none was. */
function pickKey(records: string[] | null, algorithm: string): PublicKey | string {
  if (!records?.length) return "no key published";
  let reason = "malformed key";
  for (const record of records) {
    const tags = parseTags(record);
    if (!tags || (tags.has("v") && tags.get("v") !== "DKIM1")) continue;
    if ((tags.get("k") ?? "rsa").toLowerCase() !== algorithm.split("-")[0]) {
      reason = "key type doesn't match";
      continue;
    }
    const hashes = tags.get("h")?.split(":").map((h) => h.trim().toLowerCase());
    if (hashes && !hashes.includes("sha256")) {
      reason = "key doesn't allow sha256";
      continue;
    }
    const services = tags.get("s")?.split(":").map((s) => s.trim());
    if (services && !services.includes("*") && !services.includes("email")) {
      reason = "key is not for email";
      continue;
    }
    const p = tags.get("p");
    if (p === undefined) continue;
    if (!p.replace(/[ \t\r\n]/g, "")) {
      reason = "key revoked";
      continue;
    }
    const data = base64(p);
    if (!data) continue;
    const flags = (tags.get("t") ?? "").split(":").map((f) => f.trim().toLowerCase());
    return { data, testing: flags.includes("y"), strict: flags.includes("s") };
  }
  return reason;
}

/** true or false, or why the key can't be used. */
async function verifyBytes(
  algorithm: string,
  keyData: Uint8Array,
  signature: Uint8Array,
  data: Uint8Array,
): Promise<boolean | string> {
  if (algorithm === "ed25519-sha256") {
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey("raw", keyData, { name: "Ed25519" }, false, ["verify"]);
    } catch {
      return "malformed key";
    }
    // RFC 8463: Ed25519 signs the SHA-256 hash of the header data.
    const digest = await crypto.subtle.digest("SHA-256", data);
    return crypto.subtle.verify({ name: "Ed25519" }, key, signature, digest).catch(() => false);
  }

  const key = await importRsaKey(keyData);
  if (!key) return "malformed key";
  // RFC 8301: keys under 1024 bits don't count.
  if (((key.algorithm as { modulusLength?: number }).modulusLength ?? 0) < 1024) return "key shorter than 1024 bits";
  return crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data).catch(() => false);
}

async function importRsaKey(der: Uint8Array): Promise<CryptoKey | null> {
  const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  // RFC 6376 says p= holds an RSAPublicKey, but almost every signer publishes
  // a SubjectPublicKeyInfo (the DomainKeys format). Accept both.
  for (const spki of [der, wrapRsaPublicKey(der)]) {
    try {
      return await crypto.subtle.importKey("spki", spki, algorithm, false, ["verify"]);
    } catch {
      // try the other form
    }
  }
  return null;
}

/** SubjectPublicKeyInfo around a bare PKCS#1 RSAPublicKey. */
function wrapRsaPublicKey(pkcs1: Uint8Array): Uint8Array {
  const length = (n: number) => (n < 0x80 ? [n] : n < 0x100 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
  // SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }
  const algorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const bitString = [0x03, ...length(pkcs1.length + 1), 0x00];
  const inner = algorithm.length + bitString.length + pkcs1.length;
  return new Uint8Array([0x30, ...length(inner), ...algorithm, ...bitString, ...pkcs1]);
}

// --- Headers ---

interface HeaderField {
  /** Lowercase name, for matching against h=. */
  name: string;
  /** The field as it appears, one character per byte, lines joined by CRLF, without the final CRLF. */
  raw: string;
}

/** Header fields in order, and the body (bare LF line endings are accepted as CRLF). */
function splitMessage(raw: Uint8Array): { fields: HeaderField[]; body: Uint8Array } {
  const fields: HeaderField[] = [];
  let current: HeaderField | null = null;
  let pos = 0;
  while (pos < raw.length) {
    const lf = raw.indexOf(LF, pos);
    const end = lf < 0 ? raw.length : lf;
    const line = binaryString(raw.subarray(pos, end > pos && raw[end - 1] === CR ? end - 1 : end));
    pos = lf < 0 ? raw.length : lf + 1;
    if (line === "") return { fields, body: raw.subarray(pos) };
    if (line[0] === " " || line[0] === "\t") {
      if (current) current.raw += `\r\n${line}`;
      continue;
    }
    const colon = line.indexOf(":");
    current = colon > 0 ? { name: asciiLower(line.slice(0, colon).replace(/[ \t]+$/, "")), raw: line } : null;
    if (current) fields.push(current);
  }
  return { fields, body: new Uint8Array(0) };
}

/**
 * The header data a signature covers (RFC 6376 §5.4.2): each name in h=,
 * taking repeated fields from the bottom up (a name listed more times than it
 * occurs adds nothing), then the signature field itself with b= emptied.
 */
function signedHeaderData(
  fields: readonly HeaderField[],
  signedNames: readonly string[],
  signatureField: HeaderField,
  relaxed: boolean,
): Uint8Array {
  const used = new Map<string, number>();
  let data = "";
  for (const name of signedNames) {
    const matching = fields.filter((f) => f.name === name);
    const taken = used.get(name) ?? 0;
    const field = matching[matching.length - 1 - taken];
    if (!field) continue;
    used.set(name, taken + 1);
    data += `${canonHeader(field.raw, relaxed)}\r\n`;
  }
  data += canonHeader(withoutSignatureValue(signatureField.raw), relaxed);
  return binaryBytes(data);
}

function canonHeader(raw: string, relaxed: boolean): string {
  if (!relaxed) return raw;
  const colon = raw.indexOf(":");
  const name = asciiLower(raw.slice(0, colon).replace(/[ \t]+$/, ""));
  const value = raw
    .slice(colon + 1)
    .replace(/\r\n/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/^ | $/g, "");
  return `${name}:${value}`;
}

/** The DKIM-Signature field with the b= value (and the whitespace around it) removed. */
function withoutSignatureValue(raw: string): string {
  const colon = raw.indexOf(":");
  const tags = raw
    .slice(colon + 1)
    .split(";")
    .map((tag) => /^[ \t\r\n]*b[ \t\r\n]*=/.exec(tag)?.[0] ?? tag);
  return `${raw.slice(0, colon + 1)}${tags.join(";")}`;
}

/** A tag=value list (RFC 6376 §3.2). Tag names are case-sensitive; null when malformed. */
function parseTags(text: string): Map<string, string> | null {
  const tags = new Map<string, string>();
  for (const part of text.split(";")) {
    const tag = part.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
    if (!tag) continue;
    const eq = tag.indexOf("=");
    const name = tag.slice(0, Math.max(eq, 0)).replace(/[ \t\r\n]+$/, "");
    if (eq < 0 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || tags.has(name)) return null;
    tags.set(name, tag.slice(eq + 1).replace(/^[ \t\r\n]+/, ""));
  }
  return tags;
}

// --- Body ---

interface BodyHash {
  hash: Uint8Array;
  /** Length of the whole canonicalized body. */
  length: number;
}

/**
 * SHA-256 of the canonicalized body (RFC 6376 §3.4.3-3.4.4) over at most
 * `limit` bytes, streamed through DigestStream so a 30 MB message isn't
 * copied whole.
 */
async function hashBody(body: Uint8Array, relaxed: boolean, limit: number | null): Promise<BodyHash> {
  const digest = new crypto.DigestStream("SHA-256");
  const writer = digest.getWriter();
  const out = new ChunkedOutput();
  let blankLines = 0; // held back: empty lines at the end of the body don't count
  let lineHasContent = false;
  let space = false; // relaxed: a run of whitespace, written as one space if the line goes on

  for (let i = 0; i < body.length; i++) {
    const byte = body[i]!;
    if (byte === LF || (byte === CR && body[i + 1] === LF)) {
      if (byte === CR) i++;
      if (lineHasContent) out.crlf();
      else blankLines++;
      lineHasContent = false;
      space = false;
      if (out.ready.length) await out.drain(writer, limit);
      continue;
    }
    if (relaxed && (byte === SP || byte === HTAB)) {
      space = true;
      continue;
    }
    if (!lineHasContent) {
      for (; blankLines > 0; blankLines--) out.crlf();
      lineHasContent = true;
    }
    if (space) out.byte(SP);
    space = false;
    out.byte(byte);
  }
  if (lineHasContent) out.crlf();
  // An empty body is CRLF under "simple" and nothing under "relaxed".
  if (!relaxed && out.length === 0) out.crlf();
  await out.drain(writer, limit, true);
  await writer.close();
  return { hash: new Uint8Array(await digest.digest), length: out.length };
}

const CHUNK_BYTES = 64 * 1024;

class ChunkedOutput {
  length = 0;
  ready: Uint8Array[] = [];
  private chunk = new Uint8Array(CHUNK_BYTES);
  private used = 0;
  private hashed = 0;

  byte(b: number): void {
    if (this.used === CHUNK_BYTES) {
      this.ready.push(this.chunk);
      this.chunk = new Uint8Array(CHUNK_BYTES);
      this.used = 0;
    }
    this.chunk[this.used++] = b;
    this.length++;
  }

  crlf(): void {
    this.byte(CR);
    this.byte(LF);
  }

  /** Feeds finished chunks to the hash, stopping after `limit` bytes. */
  async drain(writer: WritableStreamDefaultWriter<ArrayBuffer | ArrayBufferView>, limit: number | null, final = false) {
    if (final && this.used) {
      this.ready.push(this.chunk.subarray(0, this.used));
      this.used = 0;
    }
    for (const chunk of this.ready) {
      const take = limit === null ? chunk.length : Math.min(chunk.length, Math.max(0, limit - this.hashed));
      if (take) await writer.write(chunk.subarray(0, take));
      this.hashed += take;
    }
    this.ready = [];
  }
}

// --- DNS ---

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const KEY_CACHE_MS = 10 * 60_000;
const KEY_CACHE_ENTRIES = 1000;
const keyCache = new Map<string, { expires: number; records: string[] | null }>();

/** TXT lookup over Cloudflare's DNS-over-HTTPS, cached briefly per isolate (a backfill hits the same keys a lot). */
export async function resolveTxtOverHttps(name: string): Promise<string[] | null> {
  const cached = keyCache.get(name);
  if (cached && cached.expires > Date.now()) return cached.records;

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`${DOH_URL}?name=${encodeURIComponent(name)}&type=TXT`, {
        headers: { accept: "application/dns-json" },
      });
      if (!response.ok) throw new Error(`DNS-over-HTTPS answered ${response.status}`);
      const answer = (await response.json()) as { Status: number; Answer?: { type: number; data: string }[] };
      // 0 NOERROR, 3 NXDOMAIN; anything else (SERVFAIL...) is temporary.
      if (answer.Status !== 0 && answer.Status !== 3) throw new Error(`DNS rcode ${answer.Status}`);
      const txt = (answer.Answer ?? []).filter((a) => a.type === 16).map((a) => joinTxtStrings(a.data));
      const records = txt.length ? txt : null;
      if (keyCache.size >= KEY_CACHE_ENTRIES) keyCache.clear();
      keyCache.set(name, { expires: Date.now() + KEY_CACHE_MS, records });
      return records;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/** `"v=DKIM1; k=rsa; " "p=MIG..."` → `v=DKIM1; k=rsa; p=MIG...` */
export function joinTxtStrings(data: string): string {
  if (!data.startsWith('"')) return data;
  let out = "";
  for (const m of data.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
    out += m[1]!.replace(/\\(\d{3}|.)/g, (_, e: string) => (e.length === 3 ? String.fromCharCode(Number(e)) : e));
  }
  return out;
}

// --- Bytes ---

function binaryString(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x2000) s += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return s;
}

function binaryBytes(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

function asciiLower(s: string): string {
  return s.replace(/[A-Z]+/g, (m) => m.toLowerCase());
}

function base64(value: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(value.replace(/[ \t\r\n]/g, "")), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
