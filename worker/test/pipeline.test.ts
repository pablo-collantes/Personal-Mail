import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { attachmentKey, htmlKey, newId, rawKey } from "../src/ids";
import { indexMessage, receiveEmail, reconcile } from "../src/ingest";
import worker from "../src/index";
import type { JmapResponse } from "../src/jmap/protocol";
import type { IngestJob } from "../src/types";
import { buildMime, deliver, fakeEmail, freshEnv, mailboxOf } from "./helpers";

const ALIAS = "acme@example.com";
// Shape of the header Email Routing prepends (captured from real mail).
const CLOUDFLARE_PASS: [string, string] = [
  "Authentication-Results",
  "mx.cloudflare.net; dkim=pass header.d=example.com header.s=s1; dmarc=pass header.from=example.com policy.dmarc=reject",
];

describe("receive and index", () => {
  it("stores the raw message, parts and search index; unknown senders go to the Inbox", async () => {
    const env = freshEnv();
    const raw = buildMime({
      subject: "Your invoice",
      text: "Invoice number 4411 is attached.",
      html: "<p>Invoice number <b>4411</b> is attached.</p>",
      attachments: [{ filename: "invoice-4411.pdf", mimeType: "application/pdf", content: "%PDF-fake" }],
    });
    const { job, result } = await deliver(env, raw, { to: "Acme@Example.com" });

    expect(result).toEqual({ status: "stored", folder: "inbox", notify: true, auth: "none" });
    const id = job!.id;
    expect(await (await env.MAIL_BUCKET.get(rawKey(id)))!.text()).toBe(raw);
    expect(await (await env.MAIL_BUCKET.get(htmlKey(id)))!.text()).toContain("<b>4411</b>");
    const att = await env.MAIL_BUCKET.get(attachmentKey(id, 0));
    expect(await att!.text()).toBe("%PDF-fake");
    expect(att!.httpMetadata?.contentType).toBe("application/pdf");

    const detail = await mailboxOf(env).getMessage(id);
    expect(detail).toMatchObject({
      alias: ALIAS,
      folder: "inbox",
      subject: "Your invoice",
      from: { name: "Alice Example", address: "alice@example.com" },
      to: [{ name: "Alex", address: "alex@example.net" }],
      text: "Invoice number 4411 is attached.",
      hasHtml: true,
      attachmentCount: 1,
      vip: false,
      auth: "none",
    });
    expect(detail!.attachments).toEqual([
      { idx: 0, filename: "invoice-4411.pdf", mimeType: "application/pdf", size: 9, disposition: "attachment", contentId: null },
    ]);
  });

  it("puts verified VIP senders in VIP and asks for a notification", async () => {
    const env = freshEnv();
    await mailboxOf(env).addVipRule("address", "Alice@Example.com", "Alice");
    const { job, result } = await deliver(env, buildMime({ topHeaders: [CLOUDFLARE_PASS] }), { to: "alex+gmail@example.com" });
    expect(result).toEqual({ status: "stored", folder: "vip", notify: true, auth: "pass" });
    expect((await mailboxOf(env).getMessage(job!.id))!.auth).toBe("pass");
  });

  it("files a VIP whose From can't be verified like anyone else", async () => {
    const env = freshEnv();
    await mailboxOf(env).addVipRule("address", "alice@example.com");
    expect((await deliver(env, buildMime(), { to: ALIAS })).result).toMatchObject({ folder: "inbox" });
  });

  it("trusts only the topmost Authentication-Results header", async () => {
    const env = freshEnv();
    const box = mailboxOf(env);
    await box.addVipRule("domain", "example.com");

    const genuine = await deliver(
      env,
      buildMime({ topHeaders: [["Authentication-Results", "mx.cloudflare.net; dkim=pass header.d=example.com"]] }),
      { to: ALIAS },
    );
    expect(genuine.result).toMatchObject({ folder: "vip", notify: true });

    // A sender-supplied header sits below the receiver's, however trusted it claims to be.
    const forged = await deliver(
      env,
      buildMime({
        topHeaders: [["Authentication-Results", "mx.cloudflare.net; dkim=fail header.d=example.com"]],
        headers: [["Authentication-Results", "mx.cloudflare.net; dkim=pass header.d=example.com"]],
      }),
      { to: ALIAS },
    );
    expect(forged.result).toMatchObject({ folder: "inbox" });
    expect((await box.getMessage(forged.job!.id))!.vip).toBe(true);
  });

  it("files Spam by the receiving server's verdict, and by the user's rules", async () => {
    const env = freshEnv();
    const box = mailboxOf(env);
    const spam = await deliver(env, buildMime({ topHeaders: [["X-Spam-Status", "Yes (9.2/5.0)"]] }), { to: ALIAS });
    expect(spam.result).toMatchObject({ folder: "junk", notify: false });
    // A "No" further down (or forged) counts for nothing, and neither does a lone "No".
    const ham = await deliver(env, buildMime({ topHeaders: [["X-Spam-Status", "No (0.5/5.0)"]] }), { to: ALIAS });
    expect(ham.result).toMatchObject({ folder: "inbox" });

    const created = (await box.jmap(
      {
        using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
        methodCalls: [["Mailbox/set", { accountId: env.MAILBOX_NAME, create: { p: { name: "Payload" } } }, "c"]],
      },
      env.MAILBOX_NAME,
    )) as unknown as JmapResponse;
    const folder = (created.methodResponses[0]![1] as { created: Record<string, { id: string }> }).created.p!.id;
    const { rule, moved } = await box.addSortRule("domain", "example.com", folder);
    // Mail filed automatically follows the new rule, and a rule outranks the spam filter.
    expect(moved).toBe(2);
    expect((await box.getMessage(ham.job!.id))!.folder).toBe(folder);
    expect((await box.getMessage(spam.job!.id))!.folder).toBe(folder);
    expect((await deliver(env, buildMime(), { to: ALIAS })).result).toMatchObject({ folder, notify: false });

    expect(await box.removeSortRule(rule.id)).toEqual({ removed: true, moved: 3 });
    expect((await box.getMessage(spam.job!.id))!.folder).toBe("junk");
  });

  it("indexes each message once", async () => {
    const env = freshEnv();
    const { job } = await deliver(env, buildMime(), { to: ALIAS });
    expect(await indexMessage(env, job!)).toEqual({ status: "duplicate" });
    expect(await mailboxOf(env).listMessages()).toHaveLength(1);
  });

  it("acks queue messages once indexed", async () => {
    const env = freshEnv();
    const { message } = fakeEmail(buildMime(), { to: ALIAS });
    const job = (await receiveEmail(message, env, async () => {}))!;
    const batch = createMessageBatch<IngestJob>("personal-mail-ingest", [
      { id: "m1", timestamp: new Date(), attempts: 1, body: job },
    ]);
    const ctx = createExecutionContext();
    await (worker as ExportedHandler<Env, IngestJob>).queue!(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.explicitAcks).toEqual(["m1"]);
    expect(await mailboxOf(env).getMessage(job.id)).not.toBeNull();
  });
});

describe("search", () => {
  it("finds messages by body, sender, alias and attachment name", async () => {
    const env = freshEnv();
    const box = mailboxOf(env);
    const invoice = await deliver(
      env,
      buildMime({
        subject: "Receipt",
        text: "Thanks for your purchase",
        attachments: [{ filename: "factura-marzo.pdf", mimeType: "application/pdf", content: "x" }],
      }),
      { to: ALIAS },
    );
    const news = await deliver(
      env,
      buildMime({ from: "Weekly Digest <news@newsletter.io>", subject: "This week", html: "<p>Café culture</p>" }),
      { to: "news@example.com" },
    );

    const ids = async (text: string) => (await box.listMessages({ text })).map((m) => m.id);
    expect(await ids("purchase")).toEqual([invoice.job!.id]);
    expect(await ids("factura")).toEqual([invoice.job!.id]);
    expect(await ids("digest")).toEqual([news.job!.id]);
    expect(await ids("cafe")).toEqual([news.job!.id]); // diacritics folded
    expect(await ids("acme")).toEqual([invoice.job!.id]); // the alias it was sent to
    expect(await ids('") OR (')).toEqual([]);
    expect((await box.listMessages({ alias: "News@example.com" })).map((m) => m.id)).toEqual([news.job!.id]);
  });

  it("pages newest first", async () => {
    const env = freshEnv();
    const box = mailboxOf(env);
    const sent: string[] = [];
    for (let i = 0; i < 3; i++) sent.push((await deliver(env, buildMime({ subject: `m${i}` }), { to: ALIAS })).job!.id);
    const first = await box.listMessages({ limit: 2 });
    expect(first.map((m) => m.subject)).toEqual(["m2", "m1"]);
    const next = await box.listMessages({ limit: 2, before: first[1]!.id });
    expect(next.map((m) => m.subject)).toEqual(["m0"]);
  });
});

describe("deleting", () => {
  it("purging an alias deletes its mail everywhere and rejects future mail", async () => {
    const env = freshEnv();
    const box = mailboxOf(env);
    const leaked = await deliver(
      env,
      buildMime({ html: "<p>spam</p>", attachments: [{ filename: "a.txt", mimeType: "text/plain", content: "a" }] }),
      { to: ALIAS },
    );
    const kept = await deliver(env, buildMime(), { to: "alex+gmail@example.com" });
    const id = leaked.job!.id;

    expect(await box.purgeAlias(ALIAS)).toBe(1);
    expect(await box.getMessage(id)).toBeNull();
    expect(await box.listMessages({ text: "spam" })).toEqual([]);
    for (const key of [rawKey(id), htmlKey(id), attachmentKey(id, 0)]) expect(await env.MAIL_BUCKET.head(key)).toBeNull();
    expect(await box.getMessage(kept.job!.id)).not.toBeNull();

    const again = await deliver(env, buildMime(), { to: ALIAS });
    expect(again.rejected).toBe("Address does not exist");
    expect(again.job).toBeNull();
    expect((await box.listAliases()).find((a) => a.address === ALIAS)).toMatchObject({ status: "blocked", messageCount: 0 });
  });

  it("drops mail that was already queued when its alias got purged", async () => {
    const env = freshEnv();
    const { message } = fakeEmail(buildMime(), { to: ALIAS });
    const job = (await receiveEmail(message, env, async () => {}))!;
    await mailboxOf(env).purgeAlias(ALIAS);

    expect(await indexMessage(env, job)).toEqual({ status: "dropped", reason: "alias-blocked" });
    expect(await env.MAIL_BUCKET.head(rawKey(job.id))).toBeNull();
  });

  it("deleted messages never come back", async () => {
    const env = freshEnv();
    const box = mailboxOf(env);
    const { job } = await deliver(env, buildMime(), { to: ALIAS });
    expect(await box.deleteMessages([job!.id])).toBe(1);
    expect(await env.MAIL_BUCKET.head(rawKey(job!.id))).toBeNull();

    // A late duplicate delivery of the same job must not resurrect it.
    await env.MAIL_BUCKET.put(rawKey(job!.id), "From: x@example.com\r\n\r\nhi");
    expect(await indexMessage(env, job!)).toEqual({ status: "dropped", reason: "deleted" });
    expect(await env.MAIL_BUCKET.head(rawKey(job!.id))).toBeNull();
  });
});

describe("aliases", () => {
  it("locked mode rejects addresses that haven't been created", async () => {
    const env = freshEnv();
    const box = mailboxOf(env);
    await box.updateSettings({ aliasMode: "locked" });
    await box.setAlias("shop@example.com", { label: "Shop" });

    expect((await deliver(env, buildMime(), { to: "random@example.com" })).rejected).toBe("Address does not exist");
    expect((await deliver(env, buildMime(), { to: "shop@example.com" })).result).toMatchObject({ status: "stored" });
  });
});

describe("maintenance", () => {
  it("reconcile re-queues stored mail whose enqueue failed", async () => {
    const env = freshEnv();
    const { message } = fakeEmail(buildMime(), { to: ALIAS });
    const job = (await receiveEmail(message, env, () => Promise.reject(new Error("queue down"))))!;
    expect(await env.MAIL_BUCKET.head(rawKey(job.id))).not.toBeNull();

    const requeued: IngestJob[] = [];
    await reconcile(env, Date.now() + 20 * 60_000, async (jobs) => void requeued.push(...jobs));
    expect(requeued.find((j) => j.id === job.id)).toEqual(job);

    // Once indexed it is no longer a candidate.
    await indexMessage(env, job);
    requeued.length = 0;
    await reconcile(env, Date.now() + 20 * 60_000, async (jobs) => void requeued.push(...jobs));
    expect(requeued.find((j) => j.id === job.id)).toBeUndefined();
  });

  it("attachment retention drops old raw messages and attachments but keeps text and HTML", async () => {
    const env = freshEnv();
    const box = mailboxOf(env);
    const receivedAt = Date.now() - 40 * 86_400_000;
    const id = newId(receivedAt);
    const raw = buildMime({ html: "<p>old</p>", attachments: [{ filename: "a.txt", mimeType: "text/plain", content: "a" }] });
    await env.MAIL_BUCKET.put(rawKey(id), raw);
    await indexMessage(env, { id, receivedAt, envelopeFrom: "x@example.com", envelopeTo: ALIAS, size: raw.length });
    const fresh = await deliver(env, raw, { to: ALIAS });

    expect(await box.maintain()).toEqual({ blobsCleared: 0, expired: 0 }); // keep forever by default
    await box.updateSettings({ attachmentRetentionDays: 30 });
    expect(await box.maintain()).toEqual({ blobsCleared: 0, expired: 1 });

    expect(await env.MAIL_BUCKET.head(rawKey(id))).toBeNull();
    expect(await env.MAIL_BUCKET.head(attachmentKey(id, 0))).toBeNull();
    expect(await env.MAIL_BUCKET.head(htmlKey(id))).not.toBeNull();
    expect(await box.getMessage(id)).toMatchObject({ blobsExpired: true, text: "old" });
    expect(await env.MAIL_BUCKET.head(rawKey(fresh.job!.id))).not.toBeNull();
  });

  it("validates settings", async () => {
    const box = mailboxOf(freshEnv());
    // Settle RPC promises inside a plain async function so vitest sees the rejection as handled.
    const failure = async (call: () => Promise<unknown>) => {
      try {
        await call();
      } catch (err) {
        return String(err);
      }
      return "no error";
    };
    expect(await failure(() => box.updateSettings({ attachmentRetentionDays: 0 }))).toMatch(/whole number/);
    expect(await failure(() => box.updateSettings({ aliasMode: "closed" as never }))).toMatch(/aliasMode/);
    expect(await box.getSettings()).toEqual({ aliasMode: "open", vipRequireAuth: true, attachmentRetentionDays: null });
  });
});
