import type { Dial, Transport } from "../src/imap/client";

// An in-memory IMAP server speaking enough of RFC 3501 for the sync code:
// CAPABILITY, AUTHENTICATE PLAIN, LOGIN, LIST, EXAMINE, UID SEARCH, UID FETCH,
// LOGOUT. Responses go out in tiny chunks so line and literal reassembly get
// exercised at every boundary.

export interface FakeMessage {
  uid: number;
  raw: string;
  /** IMAP INTERNALDATE, e.g. "25-Sep-2026 10:00:00 +0000". */
  internalDate: string;
  gmMsgId?: string;
}

export interface FakeMailbox {
  uidValidity: number;
  uidNext: number;
  messages: FakeMessage[];
  /** LIST attributes, e.g. `\Sent` (RFC 6154). */
  attributes: string[];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export class FakeImapServer {
  capabilities = ["IMAP4rev1", "SASL-IR", "AUTH=PLAIN", "LITERAL+"];
  /** Extra capabilities once logged in (Gmail adds X-GM-EXT-1). */
  authedCapabilities: string[] = [];
  user = "alex@example.net";
  password = "correct horse";
  mailboxes = new Map<string, FakeMailbox>();
  /** Hierarchy delimiter in LIST responses. */
  delimiter = "/";
  chunkSize = 7;
  /** Unsolicited untagged responses slipped into every FETCH, like a busy mailbox. */
  noisy = false;
  /** Every command received, credentials redacted. */
  commands: string[] = [];
  connections = 0;

  readonly dial: Dial = async () => this.connect();

  addMailbox(name: string, uidValidity = 1000, attributes: string[] = []): FakeMailbox {
    const box = { uidValidity, uidNext: 1, messages: [], attributes };
    this.mailboxes.set(name, box);
    return box;
  }

  deliver(mailbox: string, raw: string, internalDate = "25-Sep-2026 10:00:00 +0000", gmMsgId?: string): number {
    const box = this.mailboxes.get(mailbox)!;
    const uid = box.uidNext++;
    box.messages.push({ uid, raw, internalDate, gmMsgId });
    return uid;
  }

  private connect(): Transport {
    this.connections++;
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const readable = new ReadableStream<Uint8Array>({ start: (c) => void (out = c) });
    const send = (data: string | Uint8Array) => {
      if (closed) return;
      const bytes = typeof data === "string" ? enc.encode(data) : data;
      for (let i = 0; i < bytes.length; i += this.chunkSize) out.enqueue(bytes.slice(i, i + this.chunkSize));
    };
    const close = () => {
      if (!closed) out.close();
      closed = true;
    };
    const session: Session = { authed: false, box: null };
    let pending = "";
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        pending += dec.decode(chunk);
        for (let nl = pending.indexOf("\r\n"); nl >= 0; nl = pending.indexOf("\r\n")) {
          const line = pending.slice(0, nl);
          pending = pending.slice(nl + 2);
          this.handle(line, session, send, close);
        }
      },
    });
    send(`* OK [CAPABILITY ${this.capabilities.join(" ")}] Fake IMAP ready\r\n`);
    return { readable, writable, close: async () => close() };
  }

  private handle(line: string, s: Session, send: (d: string | Uint8Array) => void, close: () => void): void {
    const [tag = "", rawCommand = "", ...args] = line.split(" ");
    const command = rawCommand.toUpperCase();
    this.commands.push(command === "AUTHENTICATE" || command === "LOGIN" ? `${command} ***` : line.slice(tag.length + 1));
    const ok = (text = "done") => send(`${tag} OK ${text}\r\n`);

    if (command === "CAPABILITY") {
      send(`* CAPABILITY ${[...this.capabilities, ...(s.authed ? this.authedCapabilities : [])].join(" ")}\r\n`);
      return ok();
    }
    if (command === "AUTHENTICATE" && args[0] === "PLAIN") {
      const [, user, password] = dec.decode(Uint8Array.from(atob(args[1] ?? ""), (c) => c.charCodeAt(0))).split("\0");
      return this.login(tag, user, password, s, send);
    }
    if (command === "LOGIN") {
      const [user, password] = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]!.replace(/\\(.)/g, "$1"));
      return this.login(tag, user, password, s, send);
    }
    if (command === "LOGOUT") {
      send("* BYE logging out\r\n");
      ok();
      return close();
    }
    if (!s.authed) return send(`${tag} BAD not authenticated\r\n`);

    if (command === "LIST") {
      for (const [name, box] of this.mailboxes) {
        send(`* LIST (\\HasNoChildren${box.attributes.map((a) => ` ${a}`).join("")}) "${this.delimiter}" "${name}"\r\n`);
      }
      return ok();
    }
    if (command === "EXAMINE") {
      const box = this.mailboxes.get(JSON.parse(args.join(" ")) as string);
      if (!box) return send(`${tag} NO no such mailbox\r\n`);
      s.box = box;
      send(`* FLAGS (\\Seen \\Answered)\r\n* ${box.messages.length} EXISTS\r\n`);
      send(`* OK [UIDVALIDITY ${box.uidValidity}] UIDs valid\r\n* OK [UIDNEXT ${box.uidNext}] next\r\n`);
      return ok("[READ-ONLY] EXAMINE completed");
    }
    if (command === "UID" && s.box) {
      const sub = (args[0] ?? "").toUpperCase();
      if (sub === "SEARCH" && args[1]?.toUpperCase() === "UID") {
        const uids = matching(s.box, args[2]!).map((m) => m.uid);
        send(`* SEARCH${uids.map((u) => ` ${u}`).join("")}\r\n`);
        return ok();
      }
      if (sub === "FETCH") {
        const items = line.slice(line.indexOf("(") + 1, line.lastIndexOf(")")).split(" ");
        s.box.messages.forEach((m, i) => {
          if (!matching(s.box!, args[1]!).includes(m)) return;
          if (this.noisy) send(`* ${i + 1} FETCH (FLAGS (\\Seen))\r\n* ${s.box!.messages.length} EXISTS\r\n`);
          send(`* ${i + 1} FETCH (UID ${m.uid}`);
          for (const item of items) {
            const up = item.toUpperCase();
            if (up === "RFC822.SIZE") send(` RFC822.SIZE ${enc.encode(m.raw).length}`);
            else if (up === "INTERNALDATE") send(` INTERNALDATE "${m.internalDate}"`);
            else if (up === "X-GM-MSGID" && m.gmMsgId) send(` X-GM-MSGID ${m.gmMsgId}`);
            else if (up === "BODY.PEEK[]") literal("BODY[]", m.raw, send);
            else if (up === "BODY.PEEK[HEADER]") literal("BODY[HEADER]", m.raw.slice(0, m.raw.indexOf("\r\n\r\n") + 4), send);
          }
          send(")\r\n");
        });
        return ok();
      }
    }
    send(`${tag} BAD unsupported\r\n`);
  }

  private login(tag: string, user: string | undefined, password: string | undefined, s: Session, send: (d: string) => void) {
    if (user !== this.user || password !== this.password) return send(`${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`);
    s.authed = true;
    send(`${tag} OK Logged in\r\n`);
  }
}

interface Session {
  authed: boolean;
  box: FakeMailbox | null;
}

function literal(name: string, content: string, send: (d: string | Uint8Array) => void): void {
  const bytes = enc.encode(content);
  send(` ${name} {${bytes.length}}\r\n`);
  send(bytes);
}

/** Messages in a UID set like `1:3,7,9:*`, where `*` is the highest UID present (and `n:*` matches it even if n is higher). */
function matching(box: FakeMailbox, set: string): FakeMessage[] {
  const max = box.messages.at(-1)?.uid ?? 0;
  const value = (v: string) => (v === "*" ? max : Number(v));
  return box.messages.filter((m) =>
    set.split(",").some((range) => {
      const [a = "", b = a] = range.split(":");
      const [lo, hi] = [value(a), value(b)].sort((x, y) => x - y);
      return m.uid >= lo! && m.uid <= hi!;
    }),
  );
}
