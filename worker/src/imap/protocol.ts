// IMAP wire format (RFC 3501 / RFC 9051), just enough to log in, open a
// mailbox read-only and fetch messages by UID. Everything is read as bytes:
// message bodies arrive as literals whose length is counted in bytes, and they
// need not be valid UTF-8.

const MAX_LINE = 1 << 20;
const decoder = new TextDecoder();

export class ImapError extends Error {}

/** A tagged NO or BAD. The message never contains the command's arguments (they may hold a password). */
export class ImapCommandError extends ImapError {
  constructor(
    readonly command: string,
    readonly status: string,
    readonly text: string,
  ) {
    super(`${command} failed: ${status} ${text}`.trim());
  }
}

export class ImapAuthError extends ImapError {}

/** Buffers a byte stream so it can be read as CRLF lines and fixed-length literals. */
export class ByteReader {
  private buf: Uint8Array = new Uint8Array(0);
  private pos = 0;

  constructor(private readonly source: ReadableStreamDefaultReader<Uint8Array>) {}

  private async pull(): Promise<Uint8Array> {
    const { value, done } = await this.source.read();
    if (done) throw new ImapError("connection closed by server");
    return value;
  }

  /** The next line, without its line ending. */
  async readLine(): Promise<Uint8Array> {
    let from = this.pos;
    for (;;) {
      const lf = this.buf.indexOf(0x0a, from);
      if (lf >= 0) {
        const end = lf > this.pos && this.buf[lf - 1] === 0x0d ? lf - 1 : lf;
        const line = this.buf.subarray(this.pos, end);
        this.pos = lf + 1;
        return line;
      }
      if (this.buf.length - this.pos > MAX_LINE) throw new ImapError("response line too long");
      const chunk = await this.pull();
      const rest = this.buf.subarray(this.pos);
      const next = new Uint8Array(rest.length + chunk.length);
      next.set(rest);
      next.set(chunk, rest.length);
      from = rest.length;
      this.buf = next;
      this.pos = 0;
    }
  }

  /** Exactly n bytes, copied straight into one buffer (no re-copying per chunk). */
  async readBytes(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let filled = Math.min(n, this.buf.length - this.pos);
    out.set(this.buf.subarray(this.pos, this.pos + filled));
    this.pos += filled;
    while (filled < n) {
      const chunk = await this.pull();
      const take = Math.min(chunk.length, n - filled);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take < chunk.length) {
        this.buf = chunk.subarray(take);
        this.pos = 0;
      }
    }
    return out;
  }
}

/**
 * One server response. `texts` are its lines; `literals[i]` came between
 * `texts[i]` (which ends in `{n}`) and `texts[i + 1]`.
 */
export interface Response {
  /** `*` (untagged), `+` (continuation) or a command tag. */
  tag: string;
  /** The first line after the tag, e.g. `OK [UIDNEXT 5] Predicted next UID` or `3 FETCH (...`. */
  rest: string;
  texts: string[];
  literals: Uint8Array[];
}

export async function readResponse(reader: ByteReader, maxLiteral: number): Promise<Response> {
  const texts: string[] = [];
  const literals: Uint8Array[] = [];
  for (;;) {
    const line = decoder.decode(await reader.readLine());
    texts.push(line);
    const m = /\{(\d+)\+?\}$/.exec(line);
    if (!m) break;
    const n = Number(m[1]);
    if (n > maxLiteral) throw new ImapError(`server sent a ${n}-byte literal, above the ${maxLiteral}-byte limit`);
    literals.push(await reader.readBytes(n));
  }
  const first = texts[0]!;
  const space = first.indexOf(" ");
  return {
    tag: space < 0 ? first : first.slice(0, space),
    rest: space < 0 ? "" : first.slice(space + 1),
    texts,
    literals,
  };
}

/** Atom or quoted string, literal bytes, NIL, or a parenthesized list. */
export type ImapValue = string | Uint8Array | null | ImapValue[];

/** Reads values from a response, starting just after its tag. */
export class Tokenizer {
  private part = 0;
  private pos: number;

  constructor(private readonly response: Response) {
    this.pos = response.texts[0]!.length - response.rest.length;
  }

  private get text(): string {
    return this.response.texts[this.part] ?? "";
  }

  private skipSpaces(): void {
    while (this.text[this.pos] === " ") this.pos++;
  }

  next(): ImapValue {
    this.skipSpaces();
    const ch = this.text[this.pos];
    if (ch === undefined) throw new ImapError("response ended early");
    if (ch === "(") {
      this.pos++;
      const items: ImapValue[] = [];
      for (;;) {
        this.skipSpaces();
        if (this.text[this.pos] === ")") {
          this.pos++;
          return items;
        }
        items.push(this.next());
      }
    }
    if (ch === '"') return this.quoted();
    if (ch === "{") {
      const literal = this.response.literals[this.part];
      if (!/^\{\d+\+?\}$/.test(this.text.slice(this.pos)) || !literal) throw new ImapError("malformed literal");
      this.part++;
      this.pos = 0;
      return literal;
    }
    return this.atom();
  }

  private quoted(): string {
    let out = "";
    this.pos++;
    for (;;) {
      const ch = this.text[this.pos++];
      if (ch === undefined) throw new ImapError("unterminated quoted string");
      if (ch === "\\") out += this.text[this.pos++] ?? "";
      else if (ch === '"') return out;
      else out += ch;
    }
  }

  /** An atom, keeping a `[section]` as part of it (`BODY[HEADER.FIELDS (A B)]`). */
  private atom(): string | null {
    const start = this.pos;
    for (;;) {
      const ch = this.text[this.pos];
      if (ch === undefined || ch === " " || ch === "(" || ch === ")") break;
      if (ch === "[") {
        const close = this.text.indexOf("]", this.pos);
        if (close < 0) throw new ImapError("unterminated [section]");
        this.pos = close + 1;
      } else {
        this.pos++;
      }
    }
    const atom = this.text.slice(start, this.pos);
    if (!atom) throw new ImapError(`unexpected ${JSON.stringify(this.text[this.pos])} in response`);
    return atom.toUpperCase() === "NIL" ? null : atom;
  }
}

/** `* 12 FETCH (UID 34 BODY[] {5}...)` → the item map, keys upper-cased. Null for other responses. */
export function parseFetch(response: Response): Map<string, ImapValue> | null {
  if (response.tag !== "*" || !/^\d+ FETCH /i.test(response.rest)) return null;
  const t = new Tokenizer(response);
  t.next();
  t.next();
  const list = t.next();
  if (!Array.isArray(list)) throw new ImapError("FETCH response without an item list");
  const items = new Map<string, ImapValue>();
  for (let i = 0; i + 1 < list.length; i += 2) {
    const key = list[i];
    if (typeof key === "string") items.set(key.toUpperCase(), list[i + 1]!);
  }
  return items;
}

/** A mailbox from a LIST response. */
export interface ListedMailbox {
  name: string;
  /** Hierarchy delimiter, null for a flat namespace. */
  delimiter: string | null;
  /** Lowercased, e.g. `\sent`, `\noselect` (RFC 6154 special-use attributes among them). */
  attributes: string[];
}

/** `* LIST (\HasNoChildren \Sent) "/" "Sent"` → the mailbox. Null for other responses. */
export function parseList(response: Response): ListedMailbox | null {
  if (response.tag !== "*" || !/^LIST /i.test(response.rest)) return null;
  const t = new Tokenizer(response);
  t.next();
  const attributes = t.next();
  const delimiter = t.next();
  const name = t.next();
  if (!Array.isArray(attributes) || Array.isArray(delimiter) || delimiter instanceof Uint8Array || name === null || Array.isArray(name)) {
    throw new ImapError("malformed LIST response");
  }
  return {
    name: typeof name === "string" ? name : decoder.decode(name),
    delimiter,
    attributes: attributes.filter((a): a is string => typeof a === "string").map((a) => a.toLowerCase()),
  };
}

/** Quoted string for a command argument. Refuses anything that would need a literal. */
export function quote(value: string): string {
  if (/[^\x20-\x7e]/.test(value)) throw new ImapError("argument needs characters a quoted string can't carry");
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

/** Sorted UIDs → compact set syntax (`1:3,7,9:10`). */
export function uidSet(uids: number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    out.push(i === j ? `${sorted[i]}` : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  return out.join(",");
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** INTERNALDATE (`25-Sep-2026 10:00:00 +0200`) → ms since epoch. */
export function parseInternalDate(value: string | null | undefined): number | null {
  const m = /^\s*(\d{1,2})-([a-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/i.exec(value ?? "");
  if (!m) return null;
  const month = MONTHS.indexOf(m[2]!.toLowerCase());
  if (month < 0) return null;
  const offset = (m[7] === "-" ? -1 : 1) * (Number(m[8]) * 60 + Number(m[9])) * 60_000;
  return Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6])) - offset;
}
