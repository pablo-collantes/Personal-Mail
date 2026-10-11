import { runInDurableObject } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clearAccessCache } from "../src/http/access";
import { eventSourceResponse } from "../src/http/eventsource";
import { handleHttp } from "../src/http/router";
import { PUSH_INTERVAL_MS } from "../src/mailbox";
import { migrate } from "../src/schema";
import { buildMime, deliver, freshEnv, mailboxOf } from "./helpers";

const TEAM = "team.cloudflareaccess.com";
const AUD = "aud-personal-mail";
const ORIGIN = "https://mail.example.com";
const MAIL = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
const CLOUDFLARE_PASS: [string, string] = [
  "Authentication-Results",
  "mx.cloudflare.net; dkim=pass header.d=example.com header.s=s1; dmarc=pass header.from=example.com",
];

let keys: CryptoKeyPair;
let jwks: { keys: JsonWebKey[] };

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

async function jwt(claims: Record<string, unknown>, key = keys.privateKey, kid = "k1"): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const head = b64urlJson({ alg: "RS256", kid, typ: "JWT" });
  const body = b64urlJson({ iss: `https://${TEAM}`, aud: [AUD], iat: now, nbf: now, exp: now + 3600, ...claims });
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

const fetcher = (async (input: RequestInfo | URL) => {
  expect(String(input)).toBe(`https://${TEAM}/cdn-cgi/access/certs`);
  return Response.json(jwks);
}) as typeof fetch;

function accessEnv(overrides: Record<string, unknown> = {}): Env {
  return freshEnv({
    ACCESS_TEAM_DOMAIN: TEAM,
    ACCESS_AUD: AUD,
    ACCESS_ALLOWED_EMAILS: "alex@example.net",
    ACCESS_SERVICE_TOKENS: "phone.access",
    ...overrides,
  });
}

async function call(env: Env, path: string, init: RequestInit & { token?: string | null } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const token = init.token === undefined ? await jwt({ email: "Alex@example.net" }) : init.token;
  if (token) headers.set("Cf-Access-Jwt-Assertion", token);
  return handleHttp(new Request(`${ORIGIN}${path}`, { ...init, headers }), env, { fetcher });
}

async function jmap(env: Env, methodCalls: unknown[], using = MAIL) {
  const res = await call(env, "/jmap/api", { method: "POST", body: JSON.stringify({ using, methodCalls }) });
  expect(res.status).toBe(200);
  return ((await res.json()) as { methodResponses: [string, Record<string, any>, string][] }).methodResponses;
}

/** The single response of a one-call request. */
async function one(env: Env, name: string, args: Record<string, unknown>) {
  const [response] = await jmap(env, [[name, { accountId: env.MAILBOX_NAME, ...args }, "c"]]);
  return response!;
}

beforeAll(async () => {
  keys = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as JsonWebKey;
  jwks = { keys: [{ ...pub, kid: "k1", alg: "RS256", use: "sig" } as JsonWebKey] };
});

beforeEach(() => clearAccessCache());

describe("Access gate", () => {
  it("answers nothing until Access is configured", async () => {
    const res = await call(freshEnv({ ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }), "/.well-known/jmap");
    expect(res.status).toBe(404);
  });

  it("lets in the allowed person and the phone's service token", async () => {
    const env = accessEnv();
    expect((await call(env, "/.well-known/jmap")).status).toBe(200);
    const phone = await jwt({ common_name: "phone.access", type: "app" });
    expect((await call(env, "/.well-known/jmap", { token: phone })).status).toBe(200);
  });

  it("refuses missing, forged, misdirected, expired and unknown tokens", async () => {
    const env = accessEnv();
    const other = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const now = Math.floor(Date.now() / 1000);
    const tokens = [
      null,
      "not.a.jwt",
      await jwt({ email: "alex@example.net" }, other.privateKey),
      await jwt({ email: "alex@example.net", aud: ["someone-else"] }),
      await jwt({ email: "alex@example.net", iss: "https://evil.cloudflareaccess.com" }),
      await jwt({ email: "alex@example.net", exp: now - 600 }),
      await jwt({ email: "stranger@example.com" }),
      await jwt({ common_name: "other.access" }),
    ];
    for (const token of tokens) {
      const res = await call(env, "/.well-known/jmap", { token });
      expect(res.status, String(token)).toBe(403);
    }
  });

  it("honours the wrangler dev sign-in only on localhost", async () => {
    const env = accessEnv({ DEV_ACCESS_EMAIL: "alex@example.net" });
    const local = await handleHttp(new Request("http://localhost:8787/.well-known/jmap"), env, { fetcher });
    expect(local.status).toBe(200);
    const remote = await handleHttp(new Request(`${ORIGIN}/.well-known/jmap`), env, { fetcher });
    expect(remote.status).toBe(403);
  });

  it("refuses changes sent from another site", async () => {
    const env = accessEnv();
    const res = await call(env, "/jmap/api", {
      method: "POST",
      headers: { Origin: "https://evil.example" },
      body: JSON.stringify({ using: MAIL, methodCalls: [] }),
    });
    expect(res.status).toBe(403);
    const same = await call(env, "/jmap/api", {
      method: "POST",
      headers: { Origin: ORIGIN },
      body: JSON.stringify({ using: MAIL, methodCalls: [] }),
    });
    expect(same.status).toBe(200);
  });
});

describe("JMAP session and envelope", () => {
  it("describes the account with absolute URLs", async () => {
    const env = accessEnv();
    const session = (await (await call(env, "/.well-known/jmap")).json()) as Record<string, any>;
    expect(session).toMatchObject({
      username: "alex@example.net",
      apiUrl: `${ORIGIN}/jmap/api`,
      downloadUrl: `${ORIGIN}/jmap/download/{accountId}/{blobId}/{name}?type={type}`,
      eventSourceUrl: `${ORIGIN}/jmap/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
      primaryAccounts: { "urn:ietf:params:jmap:mail": env.MAILBOX_NAME },
    });
    expect(session.accounts[env.MAILBOX_NAME].name).toBe("alex@example.net");
    expect(session.capabilities["urn:ietf:params:jmap:core"].maxObjectsInGet).toBeGreaterThanOrEqual(500);
    // The phone app asks for Email's `category` only from a server that says it has one.
    expect(session.capabilities["urn:io.github.pablocollantes:jmap:categories"]).toEqual({});
  });

  it("reports request errors as problem details and method errors in place", async () => {
    const env = accessEnv();
    const bad = await call(env, "/jmap/api", { method: "POST", body: "{" });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { type: string }).type).toBe("urn:ietf:params:jmap:error:notJSON");

    const responses = await jmap(
      env,
      [
        ["Identity/get", { accountId: env.MAILBOX_NAME }, "i"],
        ["Core/echo", { hello: true }, "e"],
        ["Mailbox/get", { accountId: "someone-else" }, "m"],
      ],
      [...MAIL, "urn:ietf:params:jmap:submission"],
    );
    expect(responses).toEqual([
      ["error", { type: "unknownMethod", description: "Unknown method Identity/get." }, "i"],
      ["Core/echo", { hello: true }, "e"],
      ["error", { type: "accountNotFound", description: "No such account." }, "m"],
    ]);
  });

  it("refuses uploads: the mailbox is receive-only", async () => {
    const res = await call(accessEnv(), "/jmap/upload/x/", { method: "POST", body: "data" });
    expect(res.status).toBe(403);
  });
});

/** Three messages: a verified VIP in VIP, and two in the Inbox (one with an attachment and inline image). */
async function seed(env: Env) {
  await mailboxOf(env).addVipRule("address", "alice@example.com");
  const vip = await deliver(
    env,
    buildMime({ subject: "Dinner on Sunday", text: "Are you coming to dinner?", topHeaders: [CLOUDFLARE_PASS] }),
    { to: "alex@example.com" },
  );
  const invoice = await deliver(
    env,
    buildMime({
      from: "Shop <billing@shop.example>",
      subject: "Your invoice",
      text: "Invoice number 4411 is attached.",
      html: '<p>Invoice <b>4411</b> <img src="cid:logo@shop"></p>',
      headers: [
        ["List-Unsubscribe", "<https://shop.example/unsub>, <mailto:unsub@shop.example>"],
        ["List-Unsubscribe-Post", "List-Unsubscribe=One-Click"],
      ],
      attachments: [{ filename: "invoice-4411.pdf", mimeType: "application/pdf", content: "%PDF-fake" }],
    }),
    { to: "shop@example.com" },
  );
  const news = await deliver(
    env,
    buildMime({ from: "News <news@paper.example>", subject: "Morning briefing", text: "Today: weather and markets." }),
    { to: "paper@example.com" },
  );
  return { vip: vip.job!.id, invoice: invoice.job!.id, news: news.job!.id };
}

describe("JMAP mail", () => {
  it("lists the built-in mailboxes with counts", async () => {
    const env = accessEnv();
    await seed(env);
    const [, result] = await one(env, "Mailbox/get", { ids: null });
    expect(result.list.map((m: any) => [m.id, m.name, m.role, m.totalEmails, m.unreadEmails])).toEqual([
      ["vip", "VIP", "important", 1, 1],
      ["inbox", "Inbox", "inbox", 2, 2],
      ["sent", "Sent", "sent", 0, 0],
      ["archive", "Archive", "archive", 0, 0],
      ["junk", "Spam", "junk", 0, 0],
      ["trash", "Trash", "trash", 0, 0],
    ]);
    expect(result.list[0].myRights.mayDelete).toBe(false);
  });

  it("queries a mailbox newest first and fetches the page through a back-reference", async () => {
    const env = accessEnv();
    const ids = await seed(env);
    const [query, get] = await jmap(env, [
      ["Email/query", { accountId: env.MAILBOX_NAME, filter: { inMailbox: "inbox" }, limit: 50, calculateTotal: true }, "q"],
      [
        "Email/get",
        {
          accountId: env.MAILBOX_NAME,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: ["threadId", "mailboxIds", "keywords", "from", "subject", "hasAttachment", "receivedAt"],
        },
        "g",
      ],
    ]);
    expect(query![1]).toMatchObject({ ids: [ids.news, ids.invoice], total: 2, position: 0, canCalculateChanges: false });
    expect(get![1].list).toEqual([
      expect.objectContaining({
        id: ids.news,
        threadId: `T${ids.news}`,
        mailboxIds: { inbox: true },
        keywords: {},
        from: [{ name: "News", email: "news@paper.example" }],
        subject: "Morning briefing",
        hasAttachment: false,
      }),
      expect.objectContaining({ id: ids.invoice, hasAttachment: true }),
    ]);
    expect(get![1].list[0].receivedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it("pages with an anchor and reports a missing one", async () => {
    const env = accessEnv();
    const ids = await seed(env);
    const [, page] = await one(env, "Email/query", { anchor: ids.news, anchorOffset: 1, limit: 10 });
    expect(page.ids).toEqual([ids.invoice, ids.vip]);
    expect(page.position).toBe(1);
    const [name, error] = await one(env, "Email/query", { anchor: "0000000000AAAAAAAAAAAAAAAA" });
    expect([name, error.type]).toEqual(["error", "anchorNotFound"]);
  });

  it("filters with operators, keywords and full-text search, and highlights snippets", async () => {
    const env = accessEnv();
    const ids = await seed(env);
    const query = async (filter: unknown) => (await one(env, "Email/query", { filter }))[1].ids;
    expect(await query({ text: "invoice" })).toEqual([ids.invoice]);
    expect(await query({ from: "paper" })).toEqual([ids.news]);
    expect(await query({ operator: "OR", conditions: [{ subject: "dinner" }, { subject: "briefing" }] })).toEqual([
      ids.news,
      ids.vip,
    ]);
    expect(await query({ operator: "AND", conditions: [{ text: "invoice" }, { operator: "NOT", conditions: [{ inMailbox: "trash" }] }] })).toEqual([
      ids.invoice,
    ]);
    expect(await query({ hasAttachment: true })).toEqual([ids.invoice]);
    expect(await query({ notKeyword: "$seen", inMailboxOtherThan: ["inbox"] })).toEqual([ids.vip]);
    expect(await query({ hasKeyword: "$color:red" })).toEqual([]);
    expect((await one(env, "Email/query", { filter: { header: ["X-Mailer"] } }))[1].type).toBe("unsupportedFilter");

    const [, snippets] = await one(env, "SearchSnippet/get", { filter: { text: "invoice" }, emailIds: [ids.invoice] });
    expect(snippets.list[0].subject).toBe("Your <mark>invoice</mark>");
    expect(snippets.list[0].preview).toContain("<mark>Invoice</mark>");
  });

  it("matches one letter or digit as a whole word and highlights prefixes per column", async () => {
    const env = accessEnv();
    const ids = await seed(env);
    const query = async (filter: unknown) => (await one(env, "Email/query", { filter }))[1].ids;
    expect(await query({ text: "a" })).toEqual([]);
    expect(await query({ text: "4" })).toEqual([]);
    expect(await query({ text: "44" })).toEqual([ids.invoice]);

    const [, text] = await one(env, "SearchSnippet/get", { filter: { text: "weath" }, emailIds: [ids.news] });
    expect(text.list).toEqual([{ emailId: ids.news, subject: null, preview: "Today: <mark>weather</mark> and markets." }]);
    const [, subject] = await one(env, "SearchSnippet/get", {
      filter: { operator: "AND", conditions: [{ subject: "brief" }, { inMailbox: "inbox" }] },
      emailIds: [ids.news, ids.invoice],
    });
    expect(subject.list).toEqual([
      { emailId: ids.news, subject: "Morning <mark>briefing</mark>", preview: null },
      { emailId: ids.invoice, subject: null, preview: null },
    ]);
  });

  it("returns bodies, attachments, raw headers and parsed header fields", async () => {
    const env = accessEnv();
    const { invoice } = await seed(env);
    const [, result] = await one(env, "Email/get", {
      ids: [invoice, "0000000000AAAAAAAAAAAAAAAA"],
      properties: [
        "subject",
        "messageId",
        "textBody",
        "htmlBody",
        "attachments",
        "bodyValues",
        "headers",
        "header:List-Unsubscribe:asText",
        "header:List-Unsubscribe:asURLs",
        "header:List-Unsubscribe-Post:asText",
        "header:Disposition-Notification-To:asText",
      ],
      fetchHTMLBodyValues: true,
      fetchTextBodyValues: true,
      maxBodyValueBytes: 256000,
    });
    expect(result.notFound).toEqual(["0000000000AAAAAAAAAAAAAAAA"]);
    const email = result.list[0];
    expect(email.textBody).toEqual([expect.objectContaining({ partId: "t", type: "text/plain" })]);
    expect(email.htmlBody).toEqual([expect.objectContaining({ partId: "h", type: "text/html" })]);
    expect(email.bodyValues.t.value).toBe("Invoice number 4411 is attached.");
    expect(email.bodyValues.h).toEqual({
      value: expect.stringMatching(/^<p>Invoice <b>4411<\/b> <img src="cid:logo@shop"><\/p>\s*$/),
      isTruncated: false,
      isEncodingProblem: false,
    });
    expect(email.attachments).toEqual([
      expect.objectContaining({ partId: "a0", blobId: `A${invoice}_0`, name: "invoice-4411.pdf", type: "application/pdf", size: 9 }),
    ]);
    expect(email.messageId[0]).toMatch(/@example\.com$/);
    expect(email.headers).toEqual(expect.arrayContaining([{ name: "Subject", value: " Your invoice" }]));
    expect(email["header:List-Unsubscribe:asText"]).toBe("<https://shop.example/unsub>, <mailto:unsub@shop.example>");
    expect(email["header:List-Unsubscribe:asURLs"]).toEqual(["https://shop.example/unsub", "mailto:unsub@shop.example"]);
    expect(email["header:List-Unsubscribe-Post:asText"]).toBe("List-Unsubscribe=One-Click");
    expect(email["header:Disposition-Notification-To:asText"]).toBeNull();

    const [, short] = await one(env, "Email/get", { ids: [invoice], properties: ["bodyValues"], fetchAllBodyValues: true, maxBodyValueBytes: 7 });
    expect(short.list[0].bodyValues.t).toEqual({ value: "Invoice", isTruncated: true, isEncodingProblem: false });
  });

  it("marks read and flagged, moves, and refuses impossible changes", async () => {
    const env = accessEnv();
    const ids = await seed(env);
    const [, first] = await one(env, "Email/set", {
      update: {
        [ids.vip]: { "keywords/$seen": true, "keywords/$flagged": true },
        // jmap-webmail removes keywords with false; it also moves with a full mailboxIds.
        [ids.news]: { "keywords/$seen": false, mailboxIds: { archive: true } },
        [ids.invoice]: { "mailboxIds/inbox": null, "mailboxIds/trash": true, "keywords/$junk": true },
        "0000000000AAAAAAAAAAAAAAAA": { "keywords/$seen": true },
      },
      create: { draft: { subject: "hi" } },
    });
    expect(first.updated).toEqual({
      [ids.vip]: null,
      [ids.news]: null,
      // $junk isn't stored: the server says what the keywords really are.
      [ids.invoice]: { keywords: {} },
    });
    expect(first.notUpdated["0000000000AAAAAAAAAAAAAAAA"].type).toBe("notFound");
    expect(first.notCreated.draft.type).toBe("forbidden");
    expect(Number(first.newState)).toBeGreaterThan(Number(first.oldState));

    const [, got] = await one(env, "Email/get", { ids: [ids.vip, ids.news, ids.invoice], properties: ["mailboxIds", "keywords"] });
    expect(got.list.map((e: any) => [e.mailboxIds, e.keywords])).toEqual([
      [{ vip: true }, { $seen: true, $flagged: true }],
      [{ archive: true }, {}],
      [{ trash: true }, {}],
    ]);

    const [, bad] = await one(env, "Email/set", {
      update: {
        [ids.vip]: { "mailboxIds/archive": true },
        [ids.news]: { mailboxIds: { nowhere: true } },
        [ids.invoice]: { subject: "edited" },
      },
    });
    expect(Object.values(bad.notUpdated).map((e: any) => e.type)).toEqual([
      "invalidProperties",
      "invalidProperties",
      "invalidProperties",
    ]);
    const [, stale] = await one(env, "Email/set", { ifInState: "1", update: {} });
    expect(stale.type).toBe("stateMismatch");
  });

  it("destroys mail for good and reports created, updated and destroyed changes", async () => {
    const env = accessEnv();
    const ids = await seed(env);
    const [, before] = await one(env, "Email/get", { ids: [], properties: ["id"] });
    const since = before.state as string;

    await one(env, "Email/set", { update: { [ids.vip]: { "keywords/$seen": true } } });
    const [, destroyed] = await one(env, "Email/set", { destroy: [ids.news, "0000000000AAAAAAAAAAAAAAAA"] });
    expect(destroyed.destroyed).toEqual([ids.news]);
    expect(destroyed.notDestroyed["0000000000AAAAAAAAAAAAAAAA"].type).toBe("notFound");
    const late = await deliver(env, buildMime({ subject: "Late" }), { to: "late@example.com" });

    const [, changes] = await one(env, "Email/changes", { sinceState: since });
    expect(changes).toMatchObject({
      oldState: since,
      hasMoreChanges: false,
      created: [late.job!.id],
      updated: [ids.vip],
      destroyed: [ids.news],
    });
    const [, paged] = await one(env, "Email/changes", { sinceState: since, maxChanges: 1 });
    expect(paged).toMatchObject({ hasMoreChanges: true, updated: [ids.vip], created: [], destroyed: [] });
    const [, rest] = await one(env, "Email/changes", { sinceState: paged.newState });
    expect(rest).toMatchObject({ created: [late.job!.id], destroyed: [ids.news], hasMoreChanges: false });

    const [, threads] = await one(env, "Thread/changes", { sinceState: since });
    expect(threads).toMatchObject({ created: [`T${late.job!.id}`], destroyed: [`T${ids.news}`], updated: [] });
    const [, mailboxes] = await one(env, "Mailbox/changes", { sinceState: since });
    expect(mailboxes.updated).toEqual(["vip", "inbox", "sent", "archive", "junk", "trash"]);
    expect(mailboxes.updatedProperties).toEqual(["totalEmails", "unreadEmails", "totalThreads", "unreadThreads"]);
    expect((await one(env, "Email/changes", { sinceState: "99999" }))[1].type).toBe("cannotCalculateChanges");
    expect((await one(env, "Email/queryChanges", { sinceQueryState: since }))[1].type).toBe("cannotCalculateChanges");

    expect(await env.MAIL_BUCKET.head(`raw/${ids.news}.eml`)).toBeNull();
  });

  it("gives every email its own thread", async () => {
    const env = accessEnv();
    const { vip } = await seed(env);
    const [, result] = await one(env, "Thread/get", { ids: [`T${vip}`, "Tnope"] });
    expect(result.list).toEqual([{ id: `T${vip}`, emailIds: [vip] }]);
    expect(result.notFound).toEqual(["Tnope"]);
  });

  it("creates, renames and deletes the user's own folders, never the built-in ones", async () => {
    const env = accessEnv();
    const ids = await seed(env);
    const since = (await one(env, "Mailbox/get", { ids: [] }))[1].state as string;
    const [, made] = await one(env, "Mailbox/set", {
      create: { p: { name: " Payload ", parentId: null }, dup: { name: "inbox" }, nested: { name: "A", parentId: "inbox" }, bare: {} },
      update: { vip: { name: "Important" }, inbox: { isSubscribed: true } },
      destroy: ["trash"],
    });
    const folder = made.created.p.id as string;
    expect(folder).toMatch(/^f\d+$/);
    expect(made.created.p).toMatchObject({ role: null, totalEmails: 0, myRights: { mayRename: true, mayDelete: true } });
    expect([made.notCreated.dup.type, made.notCreated.nested.type, made.notCreated.bare.type]).toEqual([
      "invalidProperties",
      "invalidProperties",
      "invalidProperties",
    ]);
    expect(made.notUpdated.vip.type).toBe("forbidden");
    expect(made.updated).toEqual({ inbox: null });
    expect(made.notDestroyed.trash.type).toBe("forbidden");

    const [, renamed] = await one(env, "Mailbox/set", { update: { [folder]: { name: "Payload Inc", sortOrder: 20 } } });
    expect(renamed.updated).toEqual({ [folder]: null });
    const [, changes] = await one(env, "Mailbox/changes", { sinceState: since });
    expect(changes.created).toEqual([folder]);
    const [, query] = await one(env, "Mailbox/query", { filter: { hasAnyRole: false } });
    expect(query.ids).toEqual([folder]);

    // Mail in it: deleting needs onDestroyRemoveEmails, and then the mail goes to the Trash.
    await one(env, "Email/set", { update: { [ids.news]: { mailboxIds: { [folder]: true } } } });
    await call(env, "/api/rules", {
      method: "POST",
      body: JSON.stringify({ kind: "domain", value: "paper.example", folder }),
      headers: { "Content-Type": "application/json" },
    });
    const beforeDelete = (await one(env, "Mailbox/get", { ids: [] }))[1].state as string;
    const [, refused] = await one(env, "Mailbox/set", { destroy: [folder] });
    expect(refused.notDestroyed[folder].type).toBe("mailboxHasEmail");
    const [, gone] = await one(env, "Mailbox/set", { destroy: [folder], onDestroyRemoveEmails: true });
    expect(gone.destroyed).toEqual([folder]);
    expect((await mailboxOf(env).getMessage(ids.news))!.folder).toBe("trash");
    expect(await mailboxOf(env).listSortRules()).toEqual([]);
    const [, after] = await one(env, "Mailbox/changes", { sinceState: beforeDelete });
    expect(after).toMatchObject({ created: [], destroyed: [folder] });
    expect((await one(env, "Mailbox/get", { ids: [folder] }))[1].notFound).toEqual([folder]);
  });

  it("puts the standard folders and the user's own in whatever order the user drags them", async () => {
    const env = accessEnv();
    await seed(env);
    const [, made] = await one(env, "Mailbox/set", { create: { p: { name: "Payload" } } });
    const folder = made.created.p.id as string;
    const since = (await one(env, "Mailbox/get", { ids: [] }))[1].state as string;

    const [, moved] = await one(env, "Mailbox/set", {
      update: {
        inbox: { sortOrder: 1 },
        [folder]: { sortOrder: 2 },
        vip: { sortOrder: 3, name: "VIP" },
        archive: { sortOrder: 4 },
        junk: { sortOrder: 5 },
        trash: { sortOrder: 6, name: "Bin" },
        sent: { sortOrder: 7 },
      },
    });
    expect(moved.updated).toEqual({ inbox: null, [folder]: null, vip: null, archive: null, junk: null, sent: null });
    expect(moved.notUpdated.trash.type).toBe("forbidden");
    const [, bad] = await one(env, "Mailbox/set", { update: { archive: { sortOrder: -1 } } });
    expect(bad.notUpdated.archive.type).toBe("invalidProperties");

    const [, query] = await one(env, "Mailbox/query", {});
    // Trash kept its place (5), level with Spam, and "Spam" sorts first by name.
    expect(query.ids).toEqual(["inbox", folder, "vip", "archive", "junk", "trash", "sent"]);
    const [, got] = await one(env, "Mailbox/get", { ids: ["trash"], properties: ["name", "sortOrder"] });
    expect(got.list).toEqual([{ id: "trash", name: "Trash", sortOrder: 5 }]);
    const [, changes] = await one(env, "Mailbox/changes", { sinceState: since });
    expect(changes.updated).toEqual(expect.arrayContaining(["inbox", folder, "vip"]));
    expect((await call(env, "/api/folders").then((r) => r.json<{ folders: { id: string }[] }>())).folders.map((f) => f.id).slice(0, 3)).toEqual([
      "inbox",
      folder,
      "vip",
    ]);
  });

  it("takes the Android app's folder create, and a rule that files earlier mail into it", async () => {
    const env = accessEnv();
    const ids = await seed(env);
    // Sterna always sends isSubscribed: true with the name (JmapClient.createMailbox).
    const [, made] = await one(env, "Mailbox/set", { create: { new: { name: "Payload", isSubscribed: true } } });
    const folder = made.created.new.id as string;
    expect(made.notCreated).toBeNull();
    const response = await call(env, "/api/rules", {
      method: "POST",
      body: JSON.stringify({ kind: "address", value: "news@paper.example", folder }),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as { moved: number }).moved).toBe(1);
    expect((await mailboxOf(env).getMessage(ids.news))!.folder).toBe(folder);
    // A second create with the same name is refused with a reason the app shows as is.
    const [, again] = await one(env, "Mailbox/set", { create: { new: { name: "payload", isSubscribed: true } } });
    expect(again.created).toBeNull();
    expect(again.notCreated.new).toMatchObject({ type: "invalidProperties", description: "There is already a folder called payload." });
  });

  it("files by who mail was sent to: a +tag, a redirected address, a whole domain", async () => {
    const env = accessEnv();
    const post = async (body: unknown) => {
      const response = await call(env, "/api/rules", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const tagged = await deliver(env, buildMime({ from: "noreply@openai.example", to: "alex+chatgpt@example.com" }), {
      to: "alex+chatgpt@example.com",
    });
    // A redirect: it arrives at the usual address, only To says where it was sent.
    const redirected = await deliver(env, buildMime({ from: "team@cursor.example", to: "cursor@redirect.example" }), {
      to: "alex@example.com",
    });
    const other = await deliver(env, buildMime({ from: "x@shop.example", to: "Claude <claude@redirect.example>" }), {
      to: "alex@example.com",
    });
    const box = mailboxOf(env);
    expect((await box.getMessage(tagged.job!.id))!.folder).toBe("inbox");

    const [, made] = await one(env, "Mailbox/set", {
      create: { a: { name: "ChatGPT", isSubscribed: true }, b: { name: "Redirects", isSubscribed: true } },
    });
    const chatgpt = made.created.a.id as string;
    const redirects = made.created.b.id as string;

    expect(await post({ kind: "tag", value: "+ChatGPT", folder: chatgpt })).toMatchObject({
      status: 201,
      body: { rule: { kind: "tag", value: "chatgpt", folder: chatgpt }, moved: 1 },
    });
    expect(await post({ kind: "to_domain", value: "@Redirect.example", folder: redirects })).toMatchObject({
      status: 201,
      body: { rule: { kind: "to_domain", value: "redirect.example" }, moved: 2 },
    });
    expect((await box.getMessage(tagged.job!.id))!.folder).toBe(chatgpt);
    expect((await box.getMessage(redirected.job!.id))!.folder).toBe(redirects);
    // The exact address beats its domain, and moves just that mail.
    expect(await post({ kind: "alias", value: "claude@redirect.example", folder: "inbox" })).toMatchObject({ body: { moved: 1 } });
    expect((await box.getMessage(other.job!.id))!.folder).toBe("inbox");
    expect((await box.getMessage(redirected.job!.id))!.folder).toBe(redirects);
    // New mail sorts the same way.
    const next = await deliver(env, buildMime({ from: "a@b.example", to: "you+chatgpt@example.net" }), { to: "alex@example.com" });
    expect(next.result).toMatchObject({ folder: chatgpt, notify: false });
    expect((await post({ kind: "tag", value: "a b", folder: chatgpt })).status).toBe(400);
  });

  it("shows VIP, and any of the user's folders, in the Inbox view on request", async () => {
    const env = accessEnv();
    const folders = async () =>
      ((await (await call(env, "/api/folders")).json()) as { folders: { id: string; showInInbox: boolean }[] }).folders;
    const patch = (id: string, body: unknown) =>
      call(env, `/api/folders/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    expect((await folders()).filter((f) => f.showInInbox).map((f) => f.id)).toEqual(["vip"]);
    const [, made] = await one(env, "Mailbox/set", { create: { a: { name: "ChatGPT", isSubscribed: true } } });
    const id = made.created.a.id as string;
    const [, before] = await one(env, "Mailbox/get", { ids: [id] });

    const response = await patch(id, { showInInbox: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ folder: { id, name: "ChatGPT", role: null, showInInbox: true } });
    expect((await folders()).filter((f) => f.showInInbox).map((f) => f.id)).toEqual(["vip", id]);
    // Clients hear of it as a mailbox change.
    const [, changes] = await one(env, "Mailbox/changes", { sinceState: before.state });
    expect(changes).toMatchObject({ updated: expect.arrayContaining([id]), updatedProperties: null });
    // Mail that lands there is mail the clients' Inbox shows.
    await mailboxOf(env).addSortRule("tag", "chatgpt", id);
    expect((await deliver(env, buildMime({ to: "me+chatgpt@example.net" }), { to: "alex@example.com" })).result).toMatchObject({
      folder: id,
      notify: true,
    });

    expect((await patch("junk", { showInInbox: true })).status).toBe(400);
    expect((await patch("inbox", { showInInbox: true })).status).toBe(400);
    expect((await patch(id, { showInInbox: "yes" })).status).toBe(400);
    expect((await patch("f999", { showInInbox: true })).status).toBe(400);
    expect((await patch("vip", { showInInbox: false })).status).toBe(200);
    expect((await folders()).filter((f) => f.showInInbox).map((f) => f.id)).toEqual([id]);
  });

  it("tells clients a VIP or rule changed even when no mail moved", async () => {
    const env = accessEnv();
    const box = mailboxOf(env);
    const [, made] = await one(env, "Mailbox/set", { create: { a: { name: "Shops", isSubscribed: true } } });
    const id = made.created.a.id as string;
    const state = async () => (await one(env, "Mailbox/get", { ids: [] }))[1].state as string;
    const states: string[] = [await state()];
    const step = async <T>(change: Promise<T>) => {
      const result = await change;
      states.push(await state());
      return result;
    };

    const { vip, moved } = await step(box.addVip("address", "nobody@example.com"));
    expect(moved).toBe(0);
    expect(await step(box.removeVip(vip.id))).toEqual({ removed: true, moved: 0 });
    const { rule } = await step(box.addSortRule("domain", "shop.example", id));
    expect(await step(box.removeSortRule(rule.id))).toEqual({ removed: true, moved: 0 });
    // Each one is a new state for push to carry.
    expect(new Set(states).size).toBe(5);
    // Removing what isn't there changes nothing.
    expect(await step(box.removeSortRule(rule.id))).toEqual({ removed: false, moved: 0 });
    expect(await step(box.removeVip(vip.id))).toEqual({ removed: false, moved: 0 });
    expect(states.slice(-3)).toEqual([states[4], states[4], states[4]]);
  });

  it("adds several rules as one change, and says which matching mail stayed put and why", async () => {
    const env = accessEnv();
    const box = mailboxOf(env);
    const state = async () => (await one(env, "Mailbox/get", { ids: [] }))[1].state as string;
    const mail = async (from: string, to = "alex@example.com", topHeaders: [string, string][] = []) =>
      (await deliver(env, buildMime({ from, to, topHeaders }), { to })).job!.id;
    const filed = [await mail("a@shop.example"), await mail("b@shop.example"), await mail("x@deals.example")];
    const byHand = await mail("c@shop.example");
    const otherRule = await mail("d@shop.example");
    await mail("alice@example.com", "alex+shop@example.com", [CLOUDFLARE_PASS]);
    await box.addVipRule("address", "alice@example.com");
    const [, made] = await one(env, "Mailbox/set", {
      create: { a: { name: "Shops", isSubscribed: true }, b: { name: "Mine", isSubscribed: true } },
    });
    const shops = made.created.a.id as string;
    const mine = made.created.b.id as string;
    await one(env, "Email/set", { update: { [byHand]: { mailboxIds: { archive: true } } } });
    await box.addSortRule("address", "d@shop.example", mine);
    const before = Number(await state());

    const response = await call(env, "/api/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folder: shops,
        rules: [
          { kind: "domain", value: "shop.example" },
          { kind: "domain", value: "deals.example" },
          { kind: "tag", value: "shop" },
          { kind: "address", value: "nobody" },
          { kind: "domain", value: "Shop.example" },
        ],
      }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, any>;
    expect(body.rules.map((r: { value: string }) => r.value)).toEqual(["shop.example", "deals.example", "shop"]);
    expect(body.moved).toBe(3);
    expect(body.failed).toEqual([{ kind: "address", value: "nobody", error: "not an email address: nobody" }]);
    // The hand-filed message, the VIP's and the one an address rule claims all stay, and say so.
    expect(body.stayed).toEqual({
      byHand: 1,
      vip: 1,
      unverified: 0,
      otherRules: [{ rule: expect.objectContaining({ kind: "address", value: "d@shop.example", folder: mine }), count: 1 }],
    });
    for (const id of filed) expect((await box.getMessage(id))!.folder).toBe(shops);
    expect((await box.getMessage(byHand))!.folder).toBe("archive");
    expect((await box.getMessage(otherRule))!.folder).toBe(mine);
    // However many rules, one change for push to carry.
    expect(Number(await state())).toBe(before + 1);

    const bad = await call(env, "/api/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder: shops, rules: "shop.example" }),
    });
    expect(bad.status).toBe(400);
  });

  it("adds several VIPs as one change", async () => {
    const env = accessEnv();
    const ids = await seed(env);
    const response = await call(env, "/api/vips", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vips: [{ kind: "domain", value: "shop.example" }, { kind: "domain", value: "paper.example" }, { kind: "address", value: "x" }] }),
    });
    expect(response.status).toBe(201);
    const body = (await response.json()) as Record<string, any>;
    expect(body.vips.map((v: { value: string }) => v.value)).toEqual(["shop.example", "paper.example"]);
    expect(body.failed).toHaveLength(1);
    // Neither sender's mail is verified (vipRequireAuth): it stays, and that is what it says.
    expect(body).toMatchObject({ moved: 0, stayed: { byHand: 0, vip: 0, unverified: 2, otherRules: [] } });
    expect((await mailboxOf(env).getMessage(ids.news))!.folder).toBe("inbox");
  });

  it("reports mail from more than a hundred senders as spam in one move", async () => {
    const env = accessEnv();
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) {
      ids.push((await deliver(env, buildMime({ from: `s${i}@bulk${i}.example` }), { to: "alex@example.com" })).job!.id);
    }
    const [name, result] = await one(env, "Email/set", { update: Object.fromEntries(ids.map((id) => [id, { mailboxIds: { junk: true } }])) });
    expect(name).toBe("Email/set");
    expect(Object.keys(result.updated)).toHaveLength(120);
    expect(await mailboxOf(env).listSortRules()).toHaveLength(120);
  });

  it("learns from Report spam and Not spam", async () => {
    const env = accessEnv();
    const ids = await seed(env);
    const box = mailboxOf(env);
    // Report spam: the sender always goes to Spam, including mail already in the Inbox.
    const second = await deliver(env, buildMime({ from: "News <news@paper.example>", subject: "Evening" }), { to: "paper@example.com" });
    await one(env, "Email/set", { update: { [ids.news]: { mailboxIds: { junk: true } } } });
    expect(await box.listSortRules()).toEqual([expect.objectContaining({ kind: "address", value: "news@paper.example", folder: "junk" })]);
    expect((await box.getMessage(second.job!.id))!.folder).toBe("junk");
    expect((await deliver(env, buildMime({ from: "news@paper.example" }), { to: "paper@example.com" })).result).toMatchObject({
      folder: "junk",
    });

    // Not spam: always the Inbox, even when the spam filter disagrees.
    await one(env, "Email/set", { update: { [second.job!.id]: { mailboxIds: { inbox: true } } } });
    expect(await box.listSortRules()).toEqual([expect.objectContaining({ value: "news@paper.example", folder: "inbox" })]);
    expect((await box.getMessage(ids.news))!.folder).toBe("junk"); // moved by hand: left where the user put it
    const flagged = buildMime({ from: "news@paper.example", topHeaders: [["X-Spam-Status", "Yes (8.0/5.0)"]] });
    expect((await deliver(env, flagged, { to: "paper@example.com" })).result).toMatchObject({ folder: "inbox" });
  });
});

describe("migration", () => {
  it("retires the Pile: its mail moves to the Inbox, VIP mail to VIP, and JMAP clients can page through it", async () => {
    const env = accessEnv();
    const stub = mailboxOf(env);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      // Start again from the schema as it was before (version 3).
      for (const { name } of sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts_%' AND name != '_cf_KV'").toArray()) {
        sql.exec(`DROP TABLE IF EXISTS ${name}`);
      }
      migrate(sql, 3);
      sql.exec("INSERT INTO meta (key, value) VALUES ('modseq', '7')");
      sql.exec("INSERT INTO vip_rules (id, kind, value, created_at) VALUES (1, 'address', 'mom@example.com', 0)");
      const insert = (seq: number, folder: string, from: string, vip: number | null) =>
        sql.exec(
          `INSERT INTO messages (seq, id, received_at, envelope_from, alias, folder, vip_rule_id, auth, subject, from_address, size, created_modseq, updated_modseq)
           VALUES (?, ?, ?, '', 'alex@example.net', ?, ?, 'pass', 's', ?, 1, 1, 1)`,
          seq,
          `m${seq}`,
          seq,
          folder,
          vip,
          from,
        );
      insert(1, "inbox", "mom@example.com", 1);
      insert(2, "pile", "shop@store.example", null);
      insert(1200, "pile", "news@paper.example", null);
      insert(3, "archive", "old@friend.example", null);
      migrate(sql);

      const rows = sql.exec<{ id: string; folder: string; auto_filed: number; updated_modseq: number }>(
        "SELECT id, folder, auto_filed, updated_modseq FROM messages ORDER BY seq",
      ).toArray();
      expect(rows.map((r) => [r.id, r.folder, r.auto_filed])).toEqual([
        ["m1", "vip", 1],
        ["m2", "inbox", 1],
        ["m3", "archive", 0],
        ["m1200", "inbox", 1],
      ]);
      // M = 8; moves at M+1+seq/500, and the counter lands on the last of them; Sent arrives after.
      expect(rows.map((r) => r.updated_modseq)).toEqual([9, 9, 1, 11]);
      expect(sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = 'modseq'").one().value).toBe("12");
    });

    const [, changes] = await one(env, "Mailbox/changes", { sinceState: "7" });
    expect(changes).toMatchObject({ created: ["vip", "sent", "junk"], destroyed: ["pile"], updatedProperties: null });
    const [, first] = await one(env, "Email/changes", { sinceState: "7", maxChanges: 2 });
    expect(first).toMatchObject({ updated: ["m1", "m2"], hasMoreChanges: true, newState: "9" });
  });

  it("keeps the rules (and their ids) when recipient rules arrive, and shows VIP in the Inbox", async () => {
    const env = accessEnv();
    const stub = mailboxOf(env);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      for (const { name } of sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts_%' AND name != '_cf_KV'").toArray()) {
        sql.exec(`DROP TABLE IF EXISTS ${name}`);
      }
      migrate(sql, 4);
      sql.exec("INSERT INTO sort_rules (id, kind, value, folder, created_at) VALUES (7, 'alias', 'shop@example.com', 'junk', 5)");
      expect(() => sql.exec("INSERT INTO sort_rules (kind, value, folder, created_at) VALUES ('tag', 'x', 'junk', 0)")).toThrow();
      migrate(sql);
      expect(sql.exec("SELECT id, kind, value, folder, created_at FROM sort_rules").toArray()).toEqual([
        { id: 7, kind: "alias", value: "shop@example.com", folder: "junk", created_at: 5 },
      ]);
      sql.exec("INSERT INTO sort_rules (kind, value, folder, created_at) VALUES ('tag', 'x', 'junk', 0)");
      expect(sql.exec("SELECT id FROM mailboxes WHERE show_in_inbox = 1").toArray()).toEqual([{ id: "vip" }]);
    });
  });

  it("adds Sent next to the Inbox, under another name when the user has a Sent folder of their own", async () => {
    const env = accessEnv();
    const stub = mailboxOf(env);
    await runInDurableObject(stub, async (_instance, state) => {
      const sql = state.storage.sql;
      for (const { name } of sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts_%' AND name != '_cf_KV'").toArray()) {
        sql.exec(`DROP TABLE IF EXISTS ${name}`);
      }
      migrate(sql, 5);
      sql.exec("UPDATE mailboxes SET sort_order = 7 WHERE id = 'inbox'");
      sql.exec("INSERT INTO mailboxes (id, name, role, sort_order, created_modseq, updated_modseq) VALUES ('f1', 'SENT', NULL, 10, 1, 1)");
      sql.exec("INSERT INTO mailboxes (id, name, role, sort_order, created_modseq, updated_modseq) VALUES ('f2', 'Sent mail', NULL, 10, 1, 1)");
      migrate(sql);
      expect(sql.exec("SELECT name, role, sort_order, builtin FROM mailboxes WHERE id = 'sent'").one()).toEqual({
        name: "Sent (imported)",
        role: "sent",
        sort_order: 7,
        builtin: 1,
      });
    });
  });
});

describe("blob downloads", () => {
  it("serves attachments, bodies and raw messages as sandboxed downloads", async () => {
    const env = accessEnv();
    const { invoice } = await seed(env);
    const account = env.MAILBOX_NAME;

    const pdf = await call(env, `/jmap/download/${account}/A${invoice}_0/invoice%204411.pdf?type=application%2Fpdf`);
    expect(pdf.status).toBe(200);
    expect(await pdf.text()).toBe("%PDF-fake");
    expect(pdf.headers.get("Content-Type")).toBe("application/pdf");
    expect(pdf.headers.get("Content-Disposition")).toBe(
      `attachment; filename="invoice 4411.pdf"; filename*=UTF-8''invoice%204411.pdf`,
    );
    expect(pdf.headers.get("Content-Security-Policy")).toBe("default-src 'none'; sandbox");
    expect(pdf.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const html = await call(env, `/jmap/download/${account}/H${invoice}/body.html?type=text%2Fhtml`);
    expect(await html.text()).toContain("<b>4411</b>");
    expect(html.headers.get("Content-Disposition")).toMatch(/^attachment;/);

    const text = await call(env, `/jmap/download/${account}/P${invoice}/body.txt`);
    expect(await text.text()).toBe("Invoice number 4411 is attached.");

    const raw = await call(env, `/jmap/download/${account}/R${invoice}/message.eml`);
    expect(raw.headers.get("Content-Type")).toBe("message/rfc822");
    expect(await raw.text()).toContain("Subject: Your invoice");

    expect((await call(env, `/jmap/download/someone-else/R${invoice}/m.eml`)).status).toBe(404);
    expect((await call(env, `/jmap/download/${account}/Rnot-an-id/m.eml`)).status).toBe(404);
    expect((await call(env, `/jmap/download/${account}/A${invoice}_7/x`)).status).toBe(404);
  });
});

describe("push over EventSource", () => {
  /** A stream whose Mailbox end is played by the test: `mailbox` sends states as the Durable Object would. */
  function stream(url: string, options: { keepAliveMs?: number } = {}) {
    const { 0: worker, 1: mailbox } = new WebSocketPair();
    mailbox.accept();
    const response = eventSourceResponse(new Request(url), { accountId: "acct", connect: async () => worker, ...options });
    expect(response.headers.get("Content-Type")).toBe("text/event-stream");
    return { response, mailbox };
  }
  const states = (email: string) => JSON.stringify({ Email: email, Mailbox: "m" });

  it("sends the current state, then each change, until the Mailbox goes", async () => {
    const { response, mailbox } = stream(`${ORIGIN}/jmap/eventsource?types=Email&closeafter=no&ping=90`);
    for (const s of ["1", "1", "2"]) mailbox.send(states(s));
    mailbox.close(1000, "gone");
    expect(await response.text()).toBe(
      'event: state\ndata: {"@type":"StateChange","changed":{"acct":{"Email":"1"}}}\n\n' +
        'event: state\ndata: {"@type":"StateChange","changed":{"acct":{"Email":"2"}}}\n\n',
    );
  });

  it("with closeafter=state, waits for a change and ends", async () => {
    const { response, mailbox } = stream(`${ORIGIN}/jmap/eventsource?types=*&closeafter=state&ping=0`);
    for (const s of ["5", "5", "6", "7"]) mailbox.send(states(s));
    expect(await response.text()).toBe('event: state\ndata: {"@type":"StateChange","changed":{"acct":{"Email":"6","Mailbox":"m"}}}\n\n');
  });

  it("keeps the push socket alive with the ping the runtime answers", async () => {
    const { response, mailbox } = stream(`${ORIGIN}/jmap/eventsource?closeafter=no&ping=0`, { keepAliveMs: 5 });
    const heard = await new Promise<string>((resolve) => mailbox.addEventListener("message", (e) => resolve(String(e.data))));
    expect(heard).toBe("ping");
    mailbox.close(1000, "gone");
    await response.text();
  });

  it("hears mail arrive through the Mailbox's hibernatable socket", async () => {
    const env = accessEnv();
    const response = await call(env, "/jmap/eventsource?types=Email&closeafter=no&ping=0");
    expect(response.status).toBe(200);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = "";
    const nextEvent = async () => {
      while (!buffered.includes("\n\n")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buffered += value;
      }
      const end = buffered.indexOf("\n\n");
      const event = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      return JSON.parse(event.split("\ndata: ")[1]!).changed[env.MAILBOX_NAME].Email as string;
    };
    const before = await nextEvent();
    await deliver(env, buildMime({ from: "Ana <ana@example.org>" }), { to: "a@example.com" });
    const after = await nextEvent();
    expect(Number(after)).toBeGreaterThan(Number(before));
    await reader.cancel();
  });

  it("the Mailbox answers a push socket's ping itself", async () => {
    const env = freshEnv();
    const res = await mailboxOf(env).fetch("https://mailbox/push", { headers: { Upgrade: "websocket" } });
    const socket = res.webSocket!;
    socket.accept();
    const messages: string[] = [];
    const pong = new Promise<void>((resolve) =>
      socket.addEventListener("message", (e) => {
        messages.push(String(e.data));
        if (e.data === "pong") resolve();
      }),
    );
    socket.send("ping");
    await pong;
    expect(JSON.parse(messages[0]!)).toMatchObject({ Email: expect.any(String) });
    socket.close(1000, "done");
  });

  it("pushes the first change at once, and a burst of them as one more push", async () => {
    const env = freshEnv();
    const box = mailboxOf(env);
    const res = await box.fetch("https://mailbox/push", { headers: { Upgrade: "websocket" } });
    const socket = res.webSocket!;
    socket.accept();
    const heard: { state: string; at: number }[] = [];
    socket.addEventListener("message", (e) => heard.push({ state: JSON.parse(String(e.data)).Email, at: Date.now() }));
    while (!heard.length) await new Promise((r) => setTimeout(r, 10));

    const start = Date.now();
    for (let i = 0; i < 5; i++) await box.addVip("address", `n${i}@example.com`);
    const last = (await box.jmapStates()).Email;
    while (heard.at(-1)!.state !== last && Date.now() - start < 3 * PUSH_INTERVAL_MS) await new Promise((r) => setTimeout(r, 20));

    const pushes = heard.slice(1);
    expect(pushes).toHaveLength(2);
    expect(pushes[0]!.at - start).toBeLessThan(PUSH_INTERVAL_MS / 2);
    expect(pushes[1]!.state).toBe(last);
    socket.close(1000, "done");
  });

  it("answers a keep-alive echo without the Mailbox", async () => {
    const env = accessEnv();
    const echo = await jmap(env, [["Core/echo", { hello: true }, "e"]], ["urn:ietf:params:jmap:core"]);
    expect(echo).toEqual([["Core/echo", { hello: true }, "e"]]);
  });
});

describe("admin endpoints", () => {
  it("manages VIP rules, aliases and settings", async () => {
    const env = accessEnv();
    const post = (path: string, body: unknown, method = "POST") =>
      call(env, path, { method, body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });

    // Verified mail from the new VIP already in the Inbox moves to VIP; a forgery doesn't.
    const passOrg: [string, string] = ["Authentication-Results", "mx.cloudflare.net; dkim=pass header.d=example.org; dmarc=pass header.from=example.org"];
    const verified = await deliver(env, buildMime({ from: "Ana <ana@example.org>", topHeaders: [passOrg] }), { to: "a@example.com" });
    const forged = await deliver(env, buildMime({ from: "Ana <ana@example.org>" }), { to: "a@example.com" });
    expect([verified.result, forged.result]).toMatchObject([{ folder: "inbox" }, { folder: "inbox" }]);
    const created = await post("/api/vips", { kind: "address", value: "Ana@Example.org", label: "Ana" });
    expect(created.status).toBe(201);
    const { vip, moved } = (await created.json()) as { vip: { id: number; value: string }; moved: number };
    expect(vip.value).toBe("ana@example.org");
    expect(moved).toBe(1);
    expect((await mailboxOf(env).getMessage(verified.job!.id))!.folder).toBe("vip");
    expect((await mailboxOf(env).getMessage(forged.job!.id))!.folder).toBe("inbox");
    expect(((await (await call(env, "/api/vips")).json()) as { vips: unknown[] }).vips).toHaveLength(1);
    expect((await post("/api/vips", { kind: "planet", value: "mars" })).status).toBe(400);
    // Removing the VIP sorts its mail again.
    const removed = await call(env, `/api/vips/${vip.id}`, { method: "DELETE" });
    expect(await removed.json()).toEqual({ ok: true, moved: 1 });
    expect((await mailboxOf(env).getMessage(verified.job!.id))!.folder).toBe("inbox");

    // Sorting rules: matching mail filed earlier follows the rule at once.
    const rule = await post("/api/rules", { kind: "address", value: "ANA@example.org", folder: "archive" });
    expect(rule.status).toBe(201);
    const ruleBody = (await rule.json()) as { rule: { id: number; value: string; folder: string }; moved: number };
    expect(ruleBody).toMatchObject({ rule: { value: "ana@example.org", folder: "archive" }, moved: 2 });
    expect(((await (await call(env, "/api/rules")).json()) as { rules: unknown[] }).rules).toHaveLength(1);
    expect((await post("/api/rules", { kind: "address", value: "x@y.example", folder: "trash" })).status).toBe(400);
    expect((await post("/api/rules", { kind: "address", value: "x@y.example", folder: "f99" })).status).toBe(400);
    expect((await post("/api/rules", { kind: "subject", value: "x", folder: "inbox" })).status).toBe(400);
    expect(await (await call(env, `/api/rules/${ruleBody.rule.id}`, { method: "DELETE" })).json()).toEqual({ ok: true, moved: 2 });
    expect((await call(env, `/api/rules/${ruleBody.rule.id}`, { method: "DELETE" })).status).toBe(404);

    await deliver(env, buildMime({ subject: "spam" }), { to: "leaky@example.com" });
    expect((await post("/api/aliases/leaky%40example.com", { label: "Leaky shop" }, "PATCH")).status).toBe(200);
    const purged = await post("/api/aliases/leaky%40example.com/purge", {});
    expect(await purged.json()).toEqual({ deleted: 1 });
    const { aliases } = (await (await call(env, "/api/aliases")).json()) as { aliases: { address: string; status: string; label: string }[] };
    expect(aliases).toEqual(
      expect.arrayContaining([expect.objectContaining({ address: "leaky@example.com", status: "blocked", label: "Leaky shop" })]),
    );

    const patched = await post("/api/settings", { attachmentRetentionDays: 365 }, "PATCH");
    expect(((await patched.json()) as { settings: { attachmentRetentionDays: number } }).settings.attachmentRetentionDays).toBe(365);
  });
});

describe("web client", () => {
  it("serves the app behind the Access check with a per-request script nonce", async () => {
    const env = accessEnv();
    const root = await call(env, "/");
    expect(root.status).toBe(302);
    expect(root.headers.get("Location")).toBe(`${ORIGIN}/en/`);

    const page = await call(env, "/en/");
    expect(page.status).toBe(200);
    const csp = page.headers.get("Content-Security-Policy")!;
    const nonce = /'nonce-([^']+)'/.exec(csp)![1]!;
    expect(csp).toContain("img-src 'self' data: blob:;");
    expect(csp).toContain("connect-src 'self';");
    const html = await page.text();
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts.length).toBeGreaterThan(0);
    for (const tag of scripts) expect(tag).toContain(`nonce="${nonce}"`);

    expect((await call(env, "/en/", { token: null })).status).toBe(403);
  });

  it("fetches the remote images the user asks for, behind the Access check", async () => {
    const env = accessEnv();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const outbound = (async (input: RequestInfo | URL) =>
      String(input) === `https://${TEAM}/cdn-cgi/access/certs`
        ? Response.json(jwks)
        : new Response(png, { headers: { "Content-Type": "image/png" } })) as typeof fetch;
    const image = async (token: string | null) => {
      const headers = new Headers();
      if (token) headers.set("Cf-Access-Jwt-Assertion", token);
      const path = `/api/image?url=${encodeURIComponent("https://img.example/logo.png")}`;
      return handleHttp(new Request(`${ORIGIN}${path}`, { headers }), env, { fetcher: outbound });
    };
    const res = await image(await jwt({ email: "alex@example.net" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect((await image(null)).status).toBe(403);
    // The page CSP still refuses images from anywhere but here.
    const page = await call(env, "/en/");
    expect(page.headers.get("Content-Security-Policy")).toContain("img-src 'self' data: blob:;");
  });
});
