import { runDurableObjectAlarm, runInDurableObject, env as testEnv } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { newId, rawKey } from "../src/ids";
import { imapSources, parseSources, type ImapSourceConfig } from "../src/imap/config";
import { ByteReader, parseFetch, parseInternalDate, parseList, quote, readResponse, uidSet } from "../src/imap/protocol";
import { ERROR_RETRY_MS, type ImapSource, POLL_INTERVAL_MS, type PollResult } from "../src/imap/source";
import { findSentMailbox, type StateStore, type SyncDeps, syncSource } from "../src/imap/sync";
import { indexMessage, reconcile, saveFetched } from "../src/ingest";
import type { IngestJob } from "../src/types";
import { FakeImapServer } from "./fake-imap";
import { dkimKeys, dkimMessages } from "./fixtures/dkim";
import { buildMime, freshEnv, mailboxOf } from "./helpers";

const enc = new TextEncoder();
const T0 = Date.parse("2026-09-25T12:00:00Z");
const DAY = 86_400_000;

const [PRIMARY, GMAIL] = parseSources([
  {
    name: "primary",
    host: "imap.example.test",
    user: "alex@example.net",
    address: "alex@example.net",
    passwordSecret: "IMAP_PASSWORD_PRIMARY",
    trustedAuthservIds: ["mx.example.test"],
  },
  {
    name: "gmail",
    host: "imap.gmail.test",
    user: "alex@gmail.example",
    address: "alex@gmail.example",
    passwordSecret: "IMAP_PASSWORD_GMAIL",
    mailboxes: ["INBOX", "[Gmail]/All Mail"],
  },
]) as [ImapSourceConfig, ImapSourceConfig];

function readerOf(...chunks: string[]): ByteReader {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(enc.encode(chunk));
      c.close();
    },
  });
  return new ByteReader(stream.getReader());
}

function memoryState(): StateStore & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    get: async <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
    put: async (key, value) => void map.set(key, structuredClone(value)),
    delete: async (key) => map.delete(key),
  };
}

/** Runs syncSource against a fake server, with R2 and the Mailbox real and the queue captured. */
function harness(server: FakeImapServer, env = freshEnv({ IMAP_SOURCES: [PRIMARY, GMAIL] })) {
  const state = memoryState();
  const jobs: IngestJob[] = [];
  let clock = T0;
  const run = (source = PRIMARY, password = server.password, deps: Partial<SyncDeps> = {}) =>
    syncSource(source, password, {
      dial: server.dial,
      state,
      save: async (m) => void jobs.push(await saveFetched(env, m, async () => {})),
      now: () => clock,
      deadline: clock + 60_000,
      maxMessageBytes: 1024 * 1024,
      dailyBackfillBytes: 1024 * 1024 * 1024,
      ...deps,
    });
  return { env, state, jobs, run, advance: (ms: number) => void (clock += ms) };
}

function primaryServer(): FakeImapServer {
  const server = new FakeImapServer();
  server.addMailbox("INBOX");
  return server;
}

describe("imap protocol", () => {
  it("reassembles lines and literals split across chunks", async () => {
    const reader = readerOf("* 3 FETCH (UID 9 BODY[] {1", "2}\r\nhello", "\r\nworld X-GM-MSGID 1234)", "\r", "\nA1 OK done\r\n");
    const fetch = parseFetch(await readResponse(reader, 100))!;
    expect(fetch.get("UID")).toBe("9");
    expect(new TextDecoder().decode(fetch.get("BODY[]") as Uint8Array)).toBe("hello\r\nworld");
    expect(fetch.get("X-GM-MSGID")).toBe("1234");
    expect(await readResponse(reader, 100)).toMatchObject({ tag: "A1", rest: "OK done" });
  });

  it("parses nested lists, quoted strings, NIL and bracketed sections", async () => {
    const reader = readerOf(
      '* 1 FETCH (FLAGS (\\Seen NIL) INTERNALDATE " 5-Oct-2026 10:00:00 +0200" BODY[HEADER.FIELDS (FROM TO)] "a \\"q\\" \\\\" UID 4)\r\n',
    );
    const fetch = parseFetch(await readResponse(reader, 100))!;
    expect(fetch.get("FLAGS")).toEqual(["\\Seen", null]);
    expect(fetch.get("BODY[HEADER.FIELDS (FROM TO)]")).toBe('a "q" \\');
    expect(parseInternalDate(fetch.get("INTERNALDATE") as string)).toBe(Date.UTC(2026, 9, 5, 8, 0, 0));
  });

  it("parses LIST responses: attributes, quoted, atom and literal names, a NIL delimiter", async () => {
    const reader = readerOf(
      '* LIST (\\HasNoChildren \\Sent) "/" "[Gmail]/Sent Mail"\r\n',
      '* LIST (\\Noselect) "." INBOX\r\n',
      '* LIST () NIL {9}\r\nEnviados \r\n',
      "* 3 EXISTS\r\n",
    );
    expect(parseList(await readResponse(reader, 100))).toEqual({ name: "[Gmail]/Sent Mail", delimiter: "/", attributes: ["\\hasnochildren", "\\sent"] });
    expect(parseList(await readResponse(reader, 100))).toEqual({ name: "INBOX", delimiter: ".", attributes: ["\\noselect"] });
    expect(parseList(await readResponse(reader, 100))).toEqual({ name: "Enviados ", delimiter: null, attributes: [] });
    expect(parseList(await readResponse(reader, 100))).toBeNull();
  });

  it("finds the Sent folder by its \\Sent mark, else by a usual name", () => {
    const box = (name: string, ...attributes: string[]) => ({ name, delimiter: ".", attributes });
    expect(findSentMailbox([box("INBOX"), box("INBOX.Enviados"), box("Outbox", "\\sent")])).toBe("Outbox");
    expect(findSentMailbox([box("INBOX"), box("INBOX.Drafts"), box("INBOX.Enviados")])).toBe("INBOX.Enviados");
    expect(findSentMailbox([box("Sent Items", "\\noselect"), box("INBOX.Sent")])).toBe("INBOX.Sent");
    expect(findSentMailbox([box("INBOX"), box("Sentimental")])).toBeNull();
  });

  it("refuses literals over the limit", async () => {
    await expect(readResponse(readerOf("* 1 FETCH (BODY[] {500}\r\n"), 100)).rejects.toThrow(/limit/);
  });

  it("formats arguments", () => {
    expect(uidSet([9, 1, 2, 3, 5, 10, 2])).toBe("1:3,5,9:10");
    expect(quote('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(() => quote("contraseña")).toThrow();
    expect(parseInternalDate("25-Sep-2026 10:00:00 -0130")).toBe(Date.UTC(2026, 8, 25, 11, 30, 0));
    expect(parseInternalDate("yesterday")).toBeNull();
  });
});

describe("imap sync", () => {
  it("imports only mail that arrives after the first connection, without changing the server", async () => {
    const server = primaryServer();
    server.deliver("INBOX", buildMime({ subject: "already there" }));
    const h = harness(server);

    expect(await h.run()).toEqual({ status: "ok", imported: 0, backfilled: 0, bytes: 0, backfillDone: true });

    const raw = buildMime({ subject: "fresh", headers: [["Return-Path", "<bounce@example.com>"]] });
    server.deliver("INBOX", raw, "25-Sep-2026 12:30:00 +0200");
    expect(await h.run()).toMatchObject({ status: "ok", imported: 1, backfilled: 0 });
    expect(await h.run()).toMatchObject({ status: "ok", imported: 0 });

    const [job] = h.jobs;
    expect(h.jobs).toHaveLength(1);
    expect(job).toMatchObject({
      source: "primary",
      envelopeTo: "alex@example.net",
      envelopeFrom: "bounce@example.com",
      receivedAt: Date.UTC(2026, 8, 25, 10, 30, 0),
    });
    expect(job!.quiet).toBeUndefined();
    const stored = await h.env.MAIL_BUCKET.get(rawKey(job!.id));
    expect(await stored!.text()).toBe(raw);
    expect(stored!.customMetadata).toMatchObject({ source: "primary", envelopeTo: "alex@example.net" });

    expect(await indexMessage(h.env, job!)).toMatchObject({ status: "stored", folder: "inbox" });
    expect(await mailboxOf(h.env).getMessage(job!.id)).toMatchObject({ subject: "fresh", alias: "alex@example.net" });

    // Read-only: EXAMINE, never SELECT; BODY.PEEK, so nothing gets marked \Seen.
    expect(server.commands.some((c) => /^(SELECT|STORE|UID STORE|EXPUNGE|COPY|MOVE|UID MOVE)\b/i.test(c))).toBe(false);
    expect(server.commands.filter((c) => /BODY/.test(c)).every((c) => c.includes("BODY.PEEK["))).toBe(true);
    expect(server.commands).toContain("AUTHENTICATE ***");
  });

  it("backfills older mail newest first, quietly, within the daily download budget", async () => {
    const server = primaryServer();
    server.deliver("INBOX", buildMime({ subject: "old 1" }), "01-Jan-2026 09:00:00 +0000");
    server.deliver("INBOX", buildMime({ subject: "old 2" }), "01-Feb-2026 09:00:00 +0000");
    server.deliver("INBOX", buildMime({ subject: "old 3" }), "01-Mar-2026 09:00:00 +0000");
    const h = harness(server);
    const source = { ...PRIMARY, backfill: true };
    const tiny = { dailyBackfillBytes: 1 }; // one message per day

    expect(await h.run(source, undefined, tiny)).toMatchObject({ backfilled: 1, backfillDone: false });
    server.deliver("INBOX", buildMime({ subject: "new" }), "25-Sep-2026 12:00:00 +0000");
    // New mail isn't held back by the budget; the backfill waits for tomorrow.
    expect(await h.run(source, undefined, tiny)).toMatchObject({ imported: 1, backfilled: 0, backfillDone: false });
    h.advance(DAY);
    expect(await h.run(source, undefined, tiny)).toMatchObject({ backfilled: 1, backfillDone: false });
    h.advance(DAY);
    expect(await h.run(source, undefined, tiny)).toMatchObject({ backfilled: 1, backfillDone: true });
    expect(await h.run(source, undefined, tiny)).toMatchObject({ imported: 0, backfilled: 0, backfillDone: true });

    const box = mailboxOf(h.env);
    for (const job of h.jobs) await indexMessage(h.env, job);
    expect(h.jobs.map((j) => j.quiet ?? false)).toEqual([true, false, true, true]);
    // Listed by receive time, not by import order.
    expect((await box.listMessages()).map((m) => m.subject)).toEqual(["new", "old 3", "old 2", "old 1"]);
  });

  it("files +tagged Gmail mail under the tag and keeps one copy across labels", async () => {
    const server = new FakeImapServer();
    server.user = GMAIL.user;
    server.authedCapabilities = ["X-GM-EXT-1"];
    server.addMailbox("INBOX", 7);
    server.addMailbox("[Gmail]/All Mail", 9);
    const h = harness(server);
    await h.run(GMAIL);

    const tagged = buildMime({ subject: "leak check", topHeaders: [["Delivered-To", "alex+shop@gmail.example"]] });
    server.deliver("INBOX", tagged, "25-Sep-2026 12:00:00 +0000", "1790000000000000001");
    server.deliver("[Gmail]/All Mail", tagged, "25-Sep-2026 12:00:00 +0000", "1790000000000000001");
    server.deliver("[Gmail]/All Mail", buildMime({ topHeaders: [["Delivered-To", "someone@example.com"]] }), undefined, "17");
    expect(await h.run(GMAIL)).toMatchObject({ imported: 3 });

    const [inbox, allMail, other] = h.jobs;
    expect(inbox!.id).toBe(allMail!.id);
    expect(inbox!.envelopeTo).toBe("alex+shop@gmail.example");
    expect(other!.envelopeTo).toBe("alex@gmail.example");
    expect(await indexMessage(h.env, inbox!)).toMatchObject({ status: "stored" });
    expect(await indexMessage(h.env, allMail!)).toEqual({ status: "duplicate" });
  });

  it("gives the same message the same id when it is fetched again", async () => {
    const server = primaryServer();
    const h = harness(server);
    await h.run();
    server.deliver("INBOX", buildMime());
    await h.run();
    h.state.map.clear();
    await h.run({ ...PRIMARY, backfill: true });
    expect(h.jobs).toHaveLength(2);
    expect(h.jobs[0]!.id).toBe(h.jobs[1]!.id);
  });

  it("backs off after a rejected password and retries at once when the password changes", async () => {
    const server = primaryServer();
    const h = harness(server);

    expect(await h.run(PRIMARY, "wrong")).toMatchObject({ status: "auth-failed", retryAt: T0 + 15 * 60_000 });
    expect(await h.run(PRIMARY, "wrong")).toEqual({ status: "auth-backoff", retryAt: T0 + 15 * 60_000 });
    expect(server.connections).toBe(1);

    h.advance(16 * 60_000);
    expect(await h.run(PRIMARY, "wrong")).toMatchObject({ status: "auth-failed", retryAt: T0 + 76 * 60_000 });
    expect(await h.run(PRIMARY, "also wrong")).toMatchObject({ status: "auth-failed" });
    expect(await h.run()).toMatchObject({ status: "ok" });
    expect(h.state.map.has("authFailure")).toBe(false);
    expect(server.connections).toBe(4);
  });

  it("starts a mailbox over when its UIDVALIDITY changes", async () => {
    const server = primaryServer();
    const h = harness(server);
    await h.run();
    const box = server.mailboxes.get("INBOX")!;
    box.uidValidity = 2000;
    server.deliver("INBOX", buildMime({ subject: "renumbered" }));
    expect(await h.run()).toMatchObject({ imported: 0 });
    server.deliver("INBOX", buildMime({ subject: "after" }));
    expect(await h.run()).toMatchObject({ imported: 1 });
  });

  it("imports just the header of an oversized message, with a note", async () => {
    const server = primaryServer();
    const h = harness(server);
    await h.run();
    server.deliver("INBOX", buildMime({ subject: "huge video", text: "x".repeat(5000) }));
    expect(await h.run(PRIMARY, undefined, { maxMessageBytes: 2000 })).toMatchObject({ imported: 1 });

    const [job] = h.jobs;
    expect(job!.size).toBeLessThan(2000);
    await indexMessage(h.env, job!);
    const detail = await mailboxOf(h.env).getMessage(job!.id);
    expect(detail).toMatchObject({ subject: "huge video", from: { address: "alice@example.com" } });
    expect(detail!.text).toMatch(/over the 0\.0 MB import limit[\s\S]*INBOX folder of alex@example\.net/);
  });

  it("copes with one-byte chunks and unsolicited responses", async () => {
    const server = primaryServer();
    server.chunkSize = 1;
    server.noisy = true;
    const h = harness(server);
    await h.run();
    server.deliver("INBOX", buildMime({ subject: "a" }));
    server.deliver("INBOX", buildMime({ subject: "b" }));
    expect(await h.run()).toMatchObject({ imported: 2 });
  });

  it("stops at the deadline and carries on next run", async () => {
    const server = primaryServer();
    const h = harness(server);
    await h.run();
    for (let i = 0; i < 3; i++) server.deliver("INBOX", buildMime({ subject: `m${i}` }));
    let calls = 0;
    // The clock passes the deadline after a few reads.
    const report = await h.run(PRIMARY, undefined, { now: () => T0 + (++calls > 3 ? 120_000 : 0), deadline: T0 + 60_000 });
    expect(report).toMatchObject({ status: "ok", backfillDone: false });
    const first = h.jobs.length;
    expect(first).toBeLessThan(3);
    await h.run();
    expect(h.jobs.map((j) => j.id)).toHaveLength(3);
  });
});

describe("imap sent mail", () => {
  const SENT_PRIMARY = { ...PRIMARY, sent: true, backfill: true };

  function sentServer(): FakeImapServer {
    const server = primaryServer();
    server.delimiter = ".";
    server.addMailbox("INBOX.Drafts", 1000, ["\\Drafts"]);
    server.addMailbox("INBOX.Sent", 2000, ["\\Sent"]);
    return server;
  }

  const mine = (o: { to?: string; subject?: string } = {}) =>
    buildMime({ from: "Alex <alex@example.net>", to: o.to ?? "Ana <ana@example.org>", subject: o.subject ?? "Re: lunch" });

  it("imports the account's Sent folder into Sent, read and never notifying, history included", async () => {
    const server = sentServer();
    server.deliver("INBOX.Sent", mine({ subject: "sent long ago" }), "01-Mar-2026 09:00:00 +0000");
    const h = harness(server);

    expect(await h.run(SENT_PRIMARY)).toMatchObject({ imported: 0, backfilled: 1, backfillDone: true });
    server.deliver("INBOX.Sent", mine({ subject: "sent just now" }), "25-Sep-2026 12:00:00 +0000");
    expect(await h.run(SENT_PRIMARY)).toMatchObject({ imported: 1, backfilled: 0 });
    expect(h.jobs.map((j) => [j.sent, j.quiet ?? false, j.envelopeTo])).toEqual([
      [true, true, "alex@example.net"],
      [true, false, "alex@example.net"],
    ]);
    // Found once with LIST, then remembered.
    expect(server.commands.filter((c) => c.startsWith("LIST"))).toHaveLength(1);
    expect(h.state.map.get("sentMailbox")).toEqual({ name: "INBOX.Sent", at: T0 });

    const box = mailboxOf(h.env);
    for (const job of h.jobs) {
      expect(await indexMessage(h.env, job)).toEqual({ status: "stored", folder: "sent", notify: false, auth: "none" });
    }
    const listed = await box.listMessages({ folder: "sent" });
    expect(listed.map((m) => [m.subject, m.seen])).toEqual([
      ["sent just now", true],
      ["sent long ago", true],
    ]);
    // Sent mail isn't mail an alias received.
    expect(await box.listAliases()).toEqual([]);
  });

  it("keeps rules and VIPs off sent mail, and learns nothing when it is moved", async () => {
    const server = sentServer();
    const h = harness(server);
    const box = mailboxOf(h.env);
    await box.addVipRule("address", "alex@example.net");
    await h.run(SENT_PRIMARY);
    server.deliver("INBOX.Sent", mine({ to: "Shop <orders@shop.example>" }));
    await h.run(SENT_PRIMARY);
    const [job] = h.jobs;
    expect(await indexMessage(h.env, job!)).toMatchObject({ folder: "sent", notify: false });

    expect((await box.addSortRule("to_domain", "shop.example", "junk")).moved).toBe(0);
    expect((await box.getMessage(job!.id))!.folder).toBe("sent");
    // Called in place: a refusal over RPC also surfaces as an unhandled rejection in the test pool.
    await runInDurableObject(box, (mailbox) => {
      expect(() => mailbox.addSortRule("address", "ana@example.org", "sent")).toThrow(/Rules can file mail into/);
      expect(() => mailbox.setShowInInbox("sent", true)).toThrow(/Only VIP and your own folders/);
    });

    // Moving your own mail to Spam must not make a "your own address is spam" rule.
    await box.updateMessage(job!.id, { folder: "junk" });
    expect((await box.listSortRules()).map((r) => r.value)).toEqual(["shop.example"]);
  });

  it("uses a named Sent folder as is, and looks again when the folder goes away", async () => {
    const server = sentServer();
    server.addMailbox("Elementos enviados", 3000);
    const h = harness(server);
    await h.run({ ...PRIMARY, sent: "Elementos enviados" });
    expect(server.commands.some((c) => c.startsWith("LIST"))).toBe(false);
    expect(h.state.map.has("cursor:Elementos enviados")).toBe(true);

    const lists = () => server.commands.filter((c) => c.startsWith("LIST")).length;
    await h.run(SENT_PRIMARY);
    expect(h.state.map.get("sentMailbox")).toEqual({ name: "INBOX.Sent", at: T0 });
    server.mailboxes.delete("INBOX.Sent");
    server.deliver("INBOX", buildMime({ subject: "still arrives" }));
    expect(await h.run(SENT_PRIMARY)).toMatchObject({ status: "ok", imported: 1 });
    expect(h.state.map.has("sentMailbox")).toBe(false);
    await h.run(SENT_PRIMARY);
    expect(h.state.map.get("sentMailbox")).toEqual({ name: "Elementos enviados", at: T0 });
    expect(lists()).toBe(2);

    // With no Sent folder at all, it looks again a day later, not every minute.
    server.mailboxes.delete("Elementos enviados");
    await h.run(SENT_PRIMARY);
    await h.run(SENT_PRIMARY);
    expect(h.state.map.get("sentMailbox")).toEqual({ name: null, at: T0 });
    await h.run(SENT_PRIMARY);
    expect(lists()).toBe(3);
    h.advance(DAY);
    await h.run(SENT_PRIMARY);
    expect(lists()).toBe(4);
  });

  it("keeps one copy of mail sent to yourself on Gmail, in the Inbox", async () => {
    const server = new FakeImapServer();
    server.user = GMAIL.user;
    server.authedCapabilities = ["X-GM-EXT-1"];
    server.addMailbox("INBOX", 7);
    server.addMailbox("[Gmail]/Sent Mail", 8, ["\\Sent"]);
    const h = harness(server);
    const gmail = { ...GMAIL, mailboxes: ["INBOX"], sent: true };
    await h.run(gmail);
    const note = buildMime({ from: "alex@gmail.example", to: "alex@gmail.example", subject: "note to self" });
    server.deliver("INBOX", note, undefined, "1790000000000000009");
    server.deliver("[Gmail]/Sent Mail", note, undefined, "1790000000000000009");
    expect(await h.run(gmail)).toMatchObject({ imported: 2 });

    const [inbox, sent] = h.jobs;
    expect(sent!.id).toBe(inbox!.id);
    expect(await indexMessage(h.env, inbox!)).toMatchObject({ folder: "inbox" });
    expect(await indexMessage(h.env, sent!)).toEqual({ status: "duplicate" });
  });

  it("reconcile keeps the sent mark", async () => {
    const env = freshEnv({ IMAP_SOURCES: [PRIMARY] });
    const receivedAt = Date.now();
    const message = { id: newId(receivedAt), source: "primary", receivedAt, raw: enc.encode(mine()), envelopeFrom: "", alias: "alex@example.net", quiet: false, sent: true };
    await expect(saveFetched(env, message, () => Promise.reject(new Error("queue down")))).rejects.toThrow(/queue down/);
    const requeued: IngestJob[] = [];
    await reconcile(env, Date.now() + 20 * 60_000, async (jobs) => void requeued.push(...jobs));
    expect(requeued.find((j) => j.id === message.id)).toMatchObject({ sent: true });
  });
});

describe("imap mail in the mailbox", () => {
  const AUTH = (authserv: string) =>
    ["Authentication-Results", `${authserv}; dkim=pass header.i=@example.com header.s=s1; dmarc=pass header.from=example.com`] as [
      string,
      string,
    ];

  it("trusts the account's own receiver for VIP checks, and nobody else's", async () => {
    const server = primaryServer();
    const h = harness(server);
    await mailboxOf(h.env).addVipRule("address", "alice@example.com");
    await h.run();
    server.deliver("INBOX", buildMime({ topHeaders: [AUTH("mx.example.test")] }));
    server.deliver("INBOX", buildMime({ topHeaders: [AUTH("mx.cloudflare.net")] }));
    await h.run();

    expect(await indexMessage(h.env, h.jobs[0]!)).toEqual({ status: "stored", folder: "vip", notify: true, auth: "pass" });
    expect(await indexMessage(h.env, h.jobs[1]!)).toEqual({ status: "stored", folder: "inbox", notify: true, auth: "none" });
  });

  it("checks DKIM itself when the account's receiver records no verdict", async () => {
    // Cloudflare DNS-over-HTTPS, which splits long TXT records into 255-byte strings.
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const name = new URL(String(input)).searchParams.get("name")!;
      const value = dkimKeys[name];
      const data = value?.match(/.{1,255}/g)!.map((s) => `"${s}"`).join(" ");
      return Response.json({ Status: value ? 0 : 3, Answer: value ? [{ name, type: 16, TTL: 300, data }] : [] });
    });
    try {
      const server = primaryServer();
      const h = harness(server);
      await mailboxOf(h.env).addVipRule("address", "ana@example.org");
      await h.run();
      server.deliver("INBOX", dkimMessages.relaxed);
      const split = dkimMessages.relaxed.indexOf("\r\n\r\n");
      const forged = dkimMessages.relaxed.slice(0, split).replace("<fixture@", "<forged@") + dkimMessages.relaxed.slice(split).replace("domingo", "lunes");
      server.deliver("INBOX", forged);
      await h.run();

      expect(await indexMessage(h.env, h.jobs[0]!)).toEqual({ status: "stored", folder: "vip", notify: true, auth: "pass" });
      expect(await indexMessage(h.env, h.jobs[1]!)).toEqual({ status: "stored", folder: "inbox", notify: true, auth: "fail" });
      expect((await mailboxOf(h.env).getMessage(h.jobs[0]!.id))!.authResults).toBe(
        "personal-mail; dkim=pass header.d=example.org header.s=rsa header.a=rsa-sha256",
      );
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("name=rsa._domainkey.example.org"), expect.anything());
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("reconcile keeps the source and quiet flag of stored IMAP mail", async () => {
    const env = freshEnv({ IMAP_SOURCES: [PRIMARY] });
    const raw = enc.encode(buildMime());
    const receivedAt = Date.now();
    const message = { id: newId(receivedAt), source: "primary", receivedAt, raw, envelopeFrom: "", alias: "alex@example.net", quiet: true };
    await expect(saveFetched(env, message, () => Promise.reject(new Error("queue down")))).rejects.toThrow(/queue down/);

    const requeued: IngestJob[] = [];
    await reconcile(env, Date.now() + 20 * 60_000, async (jobs) => void requeued.push(...jobs));
    expect(requeued.find((j) => j.id === message.id)).toMatchObject({ source: "primary", quiet: true });
  });

  it("the committed config parses, and polling waits for a password", async () => {
    expect(imapSources(testEnv).map((s) => [s.name, s.sent])).toEqual([
      ["primary", true],
      ["gmail", true],
    ]);
    expect(await testEnv.IMAP_SOURCE.getByName("primary").poll("primary")).toEqual({ status: "not-configured" });
  });

  it("an account polls on its own alarm, started once, and stops without its password secret", async () => {
    const source = testEnv.IMAP_SOURCE.getByName("alarm-start");
    expect(await source.startPolling("primary")).toBe(true);
    // Its first poll is due at once. The test env has no IMAP_PASSWORD_PRIMARY: the poll finds the
    // account not configured, and no next alarm is set.
    await runDurableObjectAlarm(source);
    await runInDurableObject(source, async (_instance, state) => expect(await state.storage.getAlarm()).toBeNull());
    // An account that is polling (its next alarm set) is left alone.
    await runInDurableObject(source, (_instance, state) => state.storage.setAlarm(Date.now() + 60 * 60_000));
    expect(await source.startPolling("primary")).toBe(false);
  });

  it("each poll sets the alarm for the next: sooner after a good one, later after a failure", async () => {
    const source = testEnv.IMAP_SOURCE.getByName("alarm-next");
    await source.startPolling("primary");
    const nextAfter = (result: PollResult | Error) =>
      runInDurableObject(source, async (instance: ImapSource, state) => {
        await state.storage.deleteAlarm();
        instance.poll = async () => {
          if (result instanceof Error) throw result;
          return result;
        };
        const before = Date.now();
        await instance.alarm();
        const at = await state.storage.getAlarm();
        return at === null ? null : at - before;
      });
    const ok = { status: "ok", imported: 1, backfilled: 0, bytes: 10, backfillDone: true } as const;
    expect(await nextAfter(ok)).toBeGreaterThanOrEqual(POLL_INTERVAL_MS);
    expect(await nextAfter(ok)).toBeLessThan(POLL_INTERVAL_MS + 1000);
    expect(await nextAfter({ status: "auth-backoff", retryAt: Date.now() + DAY })).toBeLessThan(POLL_INTERVAL_MS + 1000);
    expect(await nextAfter({ status: "error", error: "ECONNRESET" })).toBeGreaterThanOrEqual(ERROR_RETRY_MS);
    expect(await nextAfter(new Error("storage reset"))).toBeGreaterThanOrEqual(ERROR_RETRY_MS);
    expect(await nextAfter({ status: "not-configured" })).toBeNull();
  });

  it("rejects bad source config", () => {
    const base = { name: "a", host: "h", user: "u", address: "a@b.c", passwordSecret: "S" };
    expect(() => parseSources([base, base])).toThrow(/used twice/);
    expect(() => parseSources([{ ...base, port: 0 }])).toThrow(/port/);
    expect(() => parseSources([{ ...base, name: "A B" }])).toThrow(/lowercase/);
    expect(() => parseSources([{ ...base, mailboxes: [] }])).toThrow(/mailboxes/);
    expect(() => parseSources([{ ...base, dailyBackfillMB: 0 }])).toThrow(/dailyBackfillMB/);
    expect(() => parseSources([{ ...base, sent: " " }])).toThrow(/sent/);
    expect(() => parseSources([{ ...base, sent: 1 }])).toThrow(/sent/);
    expect(parseSources([{ ...base, sent: " Sent " }])[0]!.sent).toBe("Sent");
    expect(parseSources([base])[0]).toMatchObject({ port: 993, mailboxes: ["INBOX"], sent: false, backfill: false, dailyBackfillMB: 1500, trustedAuthservIds: [] });
  });
});
