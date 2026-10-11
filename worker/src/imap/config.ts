/** A mailbox we pull from over IMAP, instead of having it forwarded. */
export interface ImapSourceConfig {
  /** Short id: names the ImapSource Durable Object and tags stored mail. */
  name: string;
  host: string;
  port: number;
  user: string;
  /** The address this account receives at. Its mail is filed under this alias (or a +tag of it). */
  address: string;
  /** Name of the Worker secret holding the password. */
  passwordSecret: string;
  mailboxes: string[];
  /**
   * The account's own sent mail, filed into Sent: true finds the folder (its \Sent attribute, or
   * a usual name), a string names it, false leaves it. Never sorted by rules, never notifies.
   */
  sent: boolean | string;
  /** Also import what was already in the mailbox when we first connected (never notifies). */
  backfill: boolean;
  /** Most backfill to download per UTC day, in MB (Gmail allows 2500 MB/day of IMAP downloads). */
  dailyBackfillMB: number;
  /** authserv-ids whose topmost Authentication-Results header we trust for this account's mail. */
  trustedAuthservIds: string[];
}

export function imapSources(env: Env): ImapSourceConfig[] {
  return parseSources((env as unknown as { IMAP_SOURCES?: unknown }).IMAP_SOURCES);
}

export function imapPassword(env: Env, source: ImapSourceConfig): string | null {
  const value = (env as unknown as Record<string, unknown>)[source.passwordSecret];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseSources(value: unknown): ImapSourceConfig[] {
  if (value === undefined || value === null || value === "") return [];
  const list: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(list)) throw new Error("IMAP_SOURCES must be a list");
  const names = new Set<string>();
  return list.map((item: unknown, i) => {
    const s = (item ?? {}) as Record<string, unknown>;
    const where = `IMAP_SOURCES[${i}]`;
    const text = (key: string) => {
      const v = s[key];
      if (typeof v !== "string" || !v.trim()) throw new Error(`${where}.${key} must be a non-empty string`);
      return v.trim();
    };
    const strings = (key: string, fallback: string[]) => {
      const v = s[key] ?? fallback;
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && x.trim())) {
        throw new Error(`${where}.${key} must be a list of strings`);
      }
      return v.map((x: string) => x.trim());
    };

    const name = text("name");
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`${where}.name must be lowercase letters, digits and dashes`);
    if (names.has(name)) throw new Error(`${where}.name "${name}" is used twice`);
    names.add(name);
    const port = s.port ?? 993;
    if (!Number.isInteger(port) || (port as number) < 1 || (port as number) > 65535) {
      throw new Error(`${where}.port must be a port number`);
    }
    const address = text("address").toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(address)) throw new Error(`${where}.address must be an email address`);
    const backfill = s.backfill ?? false;
    if (typeof backfill !== "boolean") throw new Error(`${where}.backfill must be true or false`);
    const dailyBackfillMB = s.dailyBackfillMB ?? 1500;
    if (typeof dailyBackfillMB !== "number" || !(dailyBackfillMB > 0)) {
      throw new Error(`${where}.dailyBackfillMB must be a positive number`);
    }
    const mailboxes = strings("mailboxes", ["INBOX"]);
    if (!mailboxes.length) throw new Error(`${where}.mailboxes must not be empty`);
    const sent = s.sent ?? false;
    if (typeof sent !== "boolean" && !(typeof sent === "string" && sent.trim())) {
      throw new Error(`${where}.sent must be true, false or a folder name`);
    }

    return {
      name,
      host: text("host"),
      port: port as number,
      user: text("user"),
      address,
      passwordSecret: text("passwordSecret"),
      mailboxes,
      sent: typeof sent === "string" ? sent.trim() : sent,
      backfill,
      dailyBackfillMB,
      trustedAuthservIds: strings("trustedAuthservIds", []).map((id) => id.toLowerCase()),
    };
  });
}
