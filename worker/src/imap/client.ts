import { connect } from "cloudflare:sockets";
import {
  ByteReader,
  ImapAuthError,
  ImapCommandError,
  ImapError,
  type ImapValue,
  type ListedMailbox,
  type Response,
  parseFetch,
  parseInternalDate,
  parseList,
  quote,
  readResponse,
  uidSet,
} from "./protocol";

export interface Transport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}

export type Dial = (host: string, port: number) => Promise<Transport>;

/** Implicit TLS (port 993). The runtime verifies the server certificate. */
export const tlsDial: Dial = async (hostname, port) => {
  const socket = connect({ hostname, port }, { secureTransport: "on", allowHalfOpen: false });
  await socket.opened;
  return socket;
};

export interface MailboxStatus {
  uidValidity: number;
  uidNext: number;
  exists: number;
}

export interface MessageMeta {
  uid: number;
  size: number;
  internalDate: number | null;
  /** Gmail's permanent message id, the same in every label/folder. */
  gmMsgId: string | null;
}

type Handlers = {
  onUntagged?: (response: Response) => void;
  onFetch?: (items: Map<string, ImapValue>) => void;
};

const encoder = new TextEncoder();

/**
 * A read-only IMAP session: mailboxes are opened with EXAMINE and bodies are
 * fetched with BODY.PEEK, so nothing on the server changes (not even \Seen).
 */
export class ImapClient {
  private tagCounter = 0;
  private capabilities = new Set<string>();
  private bye: string | null = null;

  private constructor(
    private readonly transport: Transport,
    private readonly reader: ByteReader,
    private readonly writer: WritableStreamDefaultWriter<Uint8Array>,
    private readonly maxLiteral: number,
  ) {}

  static async open(dial: Dial, host: string, port: number, maxLiteral: number): Promise<ImapClient> {
    const transport = await dial(host, port);
    const client = new ImapClient(
      transport,
      new ByteReader(transport.readable.getReader()),
      transport.writable.getWriter(),
      maxLiteral,
    );
    try {
      await client.greeting();
    } catch (err) {
      await client.close();
      throw err;
    }
    return client;
  }

  has(capability: string): boolean {
    return this.capabilities.has(capability.toUpperCase());
  }

  async login(user: string, password: string): Promise<void> {
    if (!this.capabilities.size) await this.command("CAPABILITY");
    try {
      if (this.has("AUTH=PLAIN") && this.has("SASL-IR")) {
        const plain = encoder.encode(`\0${user}\0${password}`);
        await this.command(`AUTHENTICATE PLAIN ${btoa(String.fromCharCode(...plain))}`, {}, "AUTHENTICATE");
      } else {
        if (this.has("LOGINDISABLED")) throw new ImapError("server refuses LOGIN and offers no SASL-IR PLAIN");
        await this.command(`LOGIN ${quote(user)} ${quote(password)}`, {}, "LOGIN");
      }
    } catch (err) {
      if (err instanceof ImapCommandError && err.status === "NO") throw new ImapAuthError(err.message);
      throw err;
    }
    // Capabilities usually change once authenticated (Gmail adds X-GM-EXT-1).
    this.capabilities.clear();
    await this.command("CAPABILITY");
  }

  /** Every mailbox on the account, with its attributes. */
  async list(): Promise<ListedMailbox[]> {
    const boxes: ListedMailbox[] = [];
    await this.command('LIST "" "*"', {
      onUntagged: (r) => {
        const box = parseList(r);
        if (box) boxes.push(box);
      },
    });
    return boxes;
  }

  /** Opens a mailbox read-only. */
  async examine(mailbox: string): Promise<MailboxStatus> {
    let uidValidity: number | null = null;
    let uidNext: number | null = null;
    let exists = 0;
    await this.command(`EXAMINE ${quote(mailbox)}`, {
      onUntagged: (r) => {
        const code = /^OK \[(UIDVALIDITY|UIDNEXT) (\d+)\]/i.exec(r.rest);
        if (code?.[1]!.toUpperCase() === "UIDVALIDITY") uidValidity = Number(code[2]);
        else if (code) uidNext = Number(code[2]);
        const count = /^(\d+) EXISTS\b/i.exec(r.rest);
        if (count) exists = Number(count[1]);
      },
    });
    if (uidValidity === null) throw new ImapError(`no UIDVALIDITY for ${mailbox}`);
    uidNext ??= exists ? Math.max(0, ...(await this.fetchMeta("*")).map((m) => m.uid)) + 1 : 1;
    return { uidValidity, uidNext, exists };
  }

  /** UIDs in `from:to`, ascending. With `*`, filter the result: `n:*` always matches the last message. */
  async search(from: number, to: number | "*"): Promise<number[]> {
    const uids: number[] = [];
    await this.command(`UID SEARCH UID ${from}:${to}`, {
      onUntagged: (r) => {
        const m = /^SEARCH\b(.*)$/i.exec(r.rest);
        if (m) for (const s of m[1]!.trim().split(/\s+/)) if (/^\d+$/.test(s)) uids.push(Number(s));
      },
    });
    return uids.sort((a, b) => a - b);
  }

  async fetchMeta(uids: number[] | "*"): Promise<MessageMeta[]> {
    const items = ["UID", "RFC822.SIZE", "INTERNALDATE", ...(this.has("X-GM-EXT-1") ? ["X-GM-MSGID"] : [])];
    const out: MessageMeta[] = [];
    await this.command(`UID FETCH ${uids === "*" ? "*" : uidSet(uids)} (${items.join(" ")})`, {
      onFetch: (f) => {
        const uid = numberOf(f.get("UID"));
        const size = numberOf(f.get("RFC822.SIZE"));
        if (uid === null || size === null) return; // an unsolicited flag update
        const gm = f.get("X-GM-MSGID");
        out.push({
          uid,
          size,
          internalDate: parseInternalDate(stringOf(f.get("INTERNALDATE"))),
          gmMsgId: typeof gm === "string" ? gm : null,
        });
      },
    });
    return out;
  }

  /** The whole message (or just its header). Null when it was expunged meanwhile. */
  async fetchBody(uid: number, section: "" | "HEADER" = ""): Promise<Uint8Array | null> {
    let body: Uint8Array | null = null;
    await this.command(`UID FETCH ${uid} (UID BODY.PEEK[${section}])`, {
      onFetch: (f) => {
        if (numberOf(f.get("UID")) !== uid) return;
        const value = f.get(`BODY[${section}]`);
        if (value instanceof Uint8Array) body = value;
        else if (typeof value === "string") body = encoder.encode(value);
        else if (value === null) body = new Uint8Array(0);
      },
    });
    return body;
  }

  async logout(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } catch {
      // Closing anyway.
    } finally {
      await this.close();
    }
  }

  async close(): Promise<void> {
    try {
      await this.writer.close();
    } catch {
      // Already closed.
    }
    try {
      await this.transport.close();
    } catch {
      // Already closed.
    }
  }

  private async greeting(): Promise<void> {
    const r = await readResponse(this.reader, this.maxLiteral);
    const status = firstWord(r.rest);
    if (r.tag !== "*" || (status !== "OK" && status !== "PREAUTH")) {
      throw new ImapError(`unexpected greeting: ${r.tag} ${r.rest}`.trim());
    }
    this.noteCapabilities(r.rest);
  }

  /** Sends a command and handles responses until its tagged completion. `label` names it in errors. */
  private async command(command: string, handlers: Handlers = {}, label = commandName(command)): Promise<void> {
    const tag = `A${++this.tagCounter}`;
    await this.writer.write(encoder.encode(`${tag} ${command}\r\n`));
    for (;;) {
      let r: Response;
      try {
        r = await readResponse(this.reader, this.maxLiteral);
      } catch (err) {
        if (this.bye) throw new ImapError(`${label}: server closed the connection: ${this.bye}`);
        throw err;
      }
      if (r.tag === tag) {
        this.noteCapabilities(r.rest);
        const status = firstWord(r.rest);
        if (status !== "OK") throw new ImapCommandError(label, status, r.rest.slice(status.length).trim());
        return;
      }
      if (r.tag === "+") throw new ImapError(`${label}: unexpected continuation request`);
      if (r.tag !== "*") continue;

      const word = firstWord(r.rest);
      if (word === "BYE") this.bye = r.rest.slice(3).trim();
      else if (word === "CAPABILITY") this.setCapabilities(r.rest.slice(word.length));
      else this.noteCapabilities(r.rest);
      if (handlers.onFetch) {
        const items = parseFetch(r);
        if (items) handlers.onFetch(items);
      }
      handlers.onUntagged?.(r);
    }
  }

  /** Picks up a `[CAPABILITY ...]` response code. */
  private noteCapabilities(rest: string): void {
    const m = /\[CAPABILITY ([^\]]*)\]/i.exec(rest);
    if (m) this.setCapabilities(m[1]!);
  }

  private setCapabilities(list: string): void {
    this.capabilities = new Set(list.trim().toUpperCase().split(/\s+/).filter(Boolean));
  }
}

function firstWord(text: string): string {
  return (/^\S*/.exec(text)?.[0] ?? "").toUpperCase();
}

/** `UID FETCH 1:5 (...)` → `UID FETCH`: enough to identify a command without echoing its arguments. */
function commandName(command: string): string {
  const [first = "", second = ""] = command.split(" ");
  return first.toUpperCase() === "UID" ? `UID ${second.toUpperCase()}` : first.toUpperCase();
}

function numberOf(value: ImapValue | undefined): number | null {
  return typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
}

function stringOf(value: ImapValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}
