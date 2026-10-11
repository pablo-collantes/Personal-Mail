import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { BUILTIN_CATEGORIES, categoryAnswer, categoryRequest, estimateTokens, guessCategory, type Guessable } from "../src/categories";
import { categorizeInbox } from "../src/classifier";
import { handleHttp } from "../src/http/router";
import { migrate } from "../src/schema";
import { buildMime, deliver, freshEnv, mailboxOf } from "./helpers";

const URL_BASE = "http://127.0.0.1";
const CLASSIFIER_URL = "https://clef.example/v1/systemone";
const LIST: [string, string] = ["List-Unsubscribe", "<https://shop.example/unsub>"];

// DEV_ACCESS_EMAIL comes from .dev.vars, so the generated Env type doesn't list it.
const DEV_LOGIN: Record<string, unknown> = { DEV_ACCESS_EMAIL: "alex@example.net" };

function testEnv(overrides: Record<string, unknown> = {}): Env {
  return freshEnv({ ...DEV_LOGIN, ...overrides });
}

async function api<T = any>(env: Env, path: string, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const response = await handleHttp(
    new Request(`${URL_BASE}${path}`, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    }),
    env,
  );
  return { status: response.status, body: (await response.json()) as T };
}

async function jmap(env: Env, name: string, args: Record<string, unknown>) {
  const { body } = await api<{ methodResponses: [string, any, string][] }>(env, "/jmap/api", "POST", {
    using: ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    methodCalls: [[name, { accountId: env.MAILBOX_NAME, ...args }, "c"]],
  });
  return body.methodResponses[0]![1];
}

async function send(env: Env, o: Parameters<typeof buildMime>[0], to = "alex@example.net") {
  const { job, result } = await deliver(env, buildMime(o), { to });
  expect(result).toMatchObject({ status: "stored" });
  return job!.id;
}

const categoryOf = async (env: Env, id: string) => (await jmap(env, "Email/get", { ids: [id], properties: ["category"] })).list[0].category;

/** A classifier that answers by subject: "school" anywhere picks c1, else what `pick` says. */
function fakeClassifier(pick: (subject: string, options: string[]) => string, seen: unknown[] = []) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe(CLASSIFIER_URL);
    const body = JSON.parse(String(init!.body)) as any;
    seen.push(body);
    const options = Object.keys(body.questions.category.criteria);
    const choice = pick(body.state.email.subject, options);
    return Response.json({
      model: body.model,
      answers: { category: { type: "choice", choice, confidence: 0.9, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 0.9 : 0.1 / (options.length - 1)])) } },
    });
  }) as typeof fetch;
}

/** Workers AI's AI binding, answering as Clef does, by subject like fakeClassifier, at `tokens` a request. */
function fakeAi(pick: (subject: string, options: string[]) => string, calls: { model: string; body: any }[] = [], tokens = 600) {
  return {
    async run(model: string, body: any) {
      calls.push({ model, body });
      const options = Object.keys(body.questions.category.criteria);
      const choice = pick(body.state.email.subject, options);
      return {
        model: body.model,
        answers: { category: { type: "choice", choice, confidence: 0.8, probabilities: Object.fromEntries(options.map((o) => [o, o === choice ? 0.9 : 0.1 / (options.length - 1)])) } },
        usage: { input_tokens: tokens, output_tokens: 0 },
      };
    },
  };
}

/** The Workers AI binding's error for a code. */
const aiError = (message: string) => Object.assign(new Error(message), { name: "AiError" });

async function setReceivedAt(env: Env, times: Record<string, number>) {
  await runInDurableObject(mailboxOf(env), async (_instance, state) => {
    for (const [id, at] of Object.entries(times)) state.storage.sql.exec("UPDATE messages SET received_at = ? WHERE id = ?", at, id);
  });
}

const HOUR = 3_600_000;
/** A day the tests' clocks are set to (UTC). */
const DAY = Date.UTC(2026, 9, 5);
const NOON = DAY + 12 * HOUR;
/** In the backlog's hour (BACKLOG_FROM_UTC_HOUR). */
const LATE = DAY + 23.5 * HOUR;

const guess = (o: Partial<Guessable>) =>
  guessCategory({ fromAddress: "alice@example.com", subject: "Hi", preview: "", listId: null, listUnsubscribe: null, vip: false, ...o });

describe("the quick guess", () => {
  it("files receipts, sales, newsletters and people the way Apple Mail would", () => {
    expect(guess({ subject: "Dinner on Sunday?" })).toBe("primary");
    expect(guess({ subject: "Your Amazon.com order #112-334 has shipped", fromAddress: "shipment-tracking@amazon.com" })).toBe("transactions");
    expect(guess({ subject: "Your receipt from Apple", fromAddress: "no_reply@email.apple.com", listUnsubscribe: "<x>" })).toBe("transactions");
    expect(guess({ subject: "Hello", fromAddress: "auto-confirm@amazon.com" })).toBe("transactions");
    expect(guess({ subject: "Weekend sale: 40% off everything", listUnsubscribe: "<x>" })).toBe("promotions");
    expect(guess({ subject: "New for you", preview: "Use promo code FALL for free shipping", fromAddress: "hello@shop.example" })).toBe("promotions");
    expect(guess({ subject: "The Morning: markets and weather", listId: "<morning.nyt>" })).toBe("updates");
    expect(guess({ subject: "Ana commented on your post", fromAddress: "notification@facebookmail.com" })).toBe("updates");
    // Urgent beats bulk, and a VIP is always Primary.
    expect(guess({ subject: "Your verification code is 449120", fromAddress: "noreply@bank.example" })).toBe("primary");
    expect(guess({ subject: "Flight change: UA 123 now departs 7:05", listUnsubscribe: "<x>" })).toBe("primary");
    expect(guess({ subject: "50% off for you", listUnsubscribe: "<x>", vip: true })).toBe("primary");
    // A person writing about a sale is still a person.
    expect(guess({ subject: "Garage sale on Saturday" })).toBe("primary");
    // "border" is not an order.
    expect(guess({ subject: "Across the border", fromAddress: "news@paper.example" })).toBe("updates");
  });
});

describe("the classifier's question", () => {
  const options = [
    ...BUILTIN_CATEGORIES.map((c) => ({ id: c.id, name: c.name, description: c.description, builtin: true })),
    { id: "c1", name: "School", description: "The kids' school: events, grades, trips", builtin: false },
  ];

  it("asks one choice question whose options are the categories' descriptions", () => {
    const request = categoryRequest(
      "clef-flash",
      { from: "Ms. Lee <lee@school.example>", to: "alex@example.net", subject: "Field trip", text: "x".repeat(5000), mailingList: false, unsubscribeLink: false, vipSender: false },
      options,
    );
    expect(request.model).toBe("clef-flash");
    expect(request.state.email).toMatchObject({ from: "Ms. Lee <lee@school.example>", subject: "Field trip", sent_to_a_mailing_list: false });
    expect(request.state.email.text).toHaveLength(1500);
    const question = request.questions.category;
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria)).toEqual(["primary", "transactions", "updates", "promotions", "c1"]);
    expect(question.criteria.c1).toBe("School: The kids' school: events, grades, trips");
    expect(question.instructions).toContain("My own categories (School) come before");
  });

  it("only takes an answer that names a category it asked about", () => {
    expect(categoryAnswer({ answers: { category: { choice: "c1", confidence: 0.8 } } }, options)).toEqual({ category: "c1", confidence: 0.8 });
    expect(categoryAnswer({ answers: { category: { choice: "updates" } } }, options)).toEqual({ category: "updates", confidence: 0 });
    expect(() => categoryAnswer({ answers: { category: { choice: "spam" } } }, options)).toThrow();
    expect(() => categoryAnswer({ answers: {} }, options)).toThrow();
    expect(() => categoryAnswer("nope", options)).toThrow();
  });
});

describe("categories", () => {
  it("gives new mail a category, which JMAP shows and filters on, and counts the Inbox by category", async () => {
    const env = testEnv();
    const person = await send(env, { subject: "Dinner on Sunday?" });
    const receipt = await send(env, { from: "Shop <orders@shop.example>", subject: "Your order has shipped", headers: [LIST] });
    const sale = await send(env, { from: "Shop <deals@shop.example>", subject: "Flash sale: 30% off", headers: [LIST] });
    const news = await send(env, { from: "Paper <news@paper.example>", subject: "Morning briefing" });

    expect(await categoryOf(env, person)).toBe("primary");
    expect(await categoryOf(env, receipt)).toBe("transactions");
    expect(await categoryOf(env, sale)).toBe("promotions");
    expect(await categoryOf(env, news)).toBe("updates");
    // Asked for by default too.
    expect((await jmap(env, "Email/get", { ids: [news] })).list[0].category).toBe("updates");

    const query = await jmap(env, "Email/query", {
      filter: { operator: "AND", conditions: [{ inMailbox: "inbox" }, { category: "promotions" }] },
    });
    expect(query.ids).toEqual([sale]);
    await jmap(env, "Email/set", { update: { [receipt]: { "keywords/$seen": true } } });

    const { body } = await api(env, "/api/categories");
    expect(body.categories.map((c: any) => [c.id, c.name, c.color, c.builtin, c.total, c.unread])).toEqual([
      ["primary", "Primary", "blue", true, 1, 1],
      ["transactions", "Transactions", "green", true, 1, 0],
      ["updates", "Updates", "purple", true, 1, 1],
      ["promotions", "Promotions", "pink", true, 1, 1],
    ]);
    expect(body.classifier).toMatchObject({ configured: false, pending: 4, lastOkAt: null });
  });

  it("adds, changes and removes the user's own categories", async () => {
    const env = testEnv();
    const created = await api(env, "/api/categories", "POST", { name: " School ", description: "The kids' school: events, grades, trips" });
    expect(created.status).toBe(201);
    expect(created.body.category).toMatchObject({ id: "c1", name: "School", color: "orange", builtin: false, total: 0 });

    expect((await api(env, "/api/categories", "POST", { name: "school", description: "again" })).body.error).toMatch(/already a category called School/);
    expect((await api(env, "/api/categories", "POST", { name: "Updates", description: "x" })).status).toBe(400);
    expect((await api(env, "/api/categories", "POST", { name: "All", description: "x" })).status).toBe(400);
    expect((await api(env, "/api/categories", "POST", { name: "Bills" })).body.error).toMatch(/what belongs/);
    expect((await api(env, "/api/categories", "POST", { name: "Bills", description: "x", color: "plaid" })).status).toBe(400);
    expect((await api(env, "/api/categories/primary", "PATCH", { name: "Main" })).status).toBe(400);
    expect((await api(env, "/api/categories/primary", "DELETE")).status).toBe(400);

    const patched = await api(env, "/api/categories/c1", "PATCH", { description: "School and after-school clubs", color: "teal" });
    expect(patched.body.category).toMatchObject({ name: "School", description: "School and after-school clubs", color: "teal" });

    // A removed category's id never comes back.
    expect((await api(env, "/api/categories/c1", "DELETE")).body).toEqual({ ok: true, moved: 0 });
    expect((await api(env, "/api/categories/c1", "DELETE")).status).toBe(404);
    expect((await api(env, "/api/categories", "POST", { name: "Bills", description: "Utility bills" })).body.category.id).toBe("c2");
  });

  it("files a sender's mail, past and future, in the category the user picks, and lets go again", async () => {
    const env = testEnv();
    const first = await send(env, { from: "Paper <news@paper.example>", subject: "Morning briefing" });
    const before = (await jmap(env, "Email/get", { ids: [first] })).state;

    const set = await api(env, "/api/category-senders", "POST", { address: "News@Paper.example", category: "primary" });
    expect(set.status).toBe(201);
    expect(set.body).toMatchObject({ sender: { address: "news@paper.example", category: "primary" }, moved: 1 });
    expect(await categoryOf(env, first)).toBe("primary");
    const changes = await jmap(env, "Email/changes", { sinceState: before });
    expect(changes.updated).toEqual([first]);

    const next = await send(env, { from: "Paper <news@paper.example>", subject: "Evening briefing" });
    expect(await categoryOf(env, next)).toBe("primary");
    expect((await api(env, "/api/category-senders")).body.senders).toEqual([expect.objectContaining({ address: "news@paper.example", category: "primary" })]);
    expect((await api(env, "/api/category-senders", "POST", { address: "news@paper.example", category: "nope" })).status).toBe(400);

    expect((await api(env, "/api/category-senders/news%40paper.example", "DELETE")).body).toEqual({ ok: true, moved: 2 });
    expect(await categoryOf(env, first)).toBe("updates");
    expect((await api(env, "/api/category-senders/news%40paper.example", "DELETE")).status).toBe(404);

    // A category that goes takes its senders with it, and its mail gets a quick guess again.
    const { body } = await api(env, "/api/categories", "POST", { name: "Papers", description: "Newspapers" });
    await api(env, "/api/category-senders", "POST", { address: "news@paper.example", category: body.category.id });
    expect(await categoryOf(env, next)).toBe(body.category.id);
    expect((await api(env, `/api/categories/${body.category.id}`, "DELETE")).body).toEqual({ ok: true, moved: 2 });
    expect(await categoryOf(env, next)).toBe("updates");
    expect((await api(env, "/api/category-senders")).body.senders).toEqual([]);
  });

  it("asks the classifier about Inbox mail, newest first, and takes its answers", async () => {
    const env = testEnv({ CLASSIFIER_URL, CLASSIFIER_MODEL: "clef-flash", CLASSIFIER_ACCESS_CLIENT_ID: "id.access", CLASSIFIER_ACCESS_CLIENT_SECRET: "s3cret" });
    const trip = await send(env, { from: "School <office@school.example>", subject: "Field trip on Friday", headers: [LIST] });
    const coupon = await send(env, { from: "Ana <ana@example.org>", subject: "A coupon for you" });
    const spam = await send(env, { from: "Spam <x@spam.example>", subject: "Buy now", headers: [["X-Spam-Flag", "YES"]] });
    expect(await categoryOf(env, trip)).toBe("updates");
    await api(env, "/api/categories", "POST", { name: "School", description: "The kids' school" });

    const seen: any[] = [];
    let headers: Headers | null = null;
    const answer = fakeClassifier((subject, options) => {
      expect(options.slice(0, 5)).toEqual(["primary", "transactions", "updates", "promotions", "c1"]);
      return /trip/i.test(subject) ? "c1" : "promotions";
    }, seen);
    const before = (await jmap(env, "Email/get", { ids: [trip] })).state;
    const result = await categorizeInbox(env, {
      fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
        headers = new Headers(init!.headers);
        return answer(input, init);
      }) as typeof fetch,
    });
    expect(result).toMatchObject({ asked: 2, changed: 2 });
    expect(headers!.get("CF-Access-Client-Id")).toBe("id.access");
    expect(headers!.get("CF-Access-Client-Secret")).toBe("s3cret");
    // Spam isn't in the Inbox view: never asked about.
    expect(seen.map((b) => b.state.email.subject)).toEqual(["A coupon for you", "Field trip on Friday"]);
    expect(seen[0].model).toBe("clef-flash");
    expect(await categoryOf(env, trip)).toBe("c1");
    expect(await categoryOf(env, coupon)).toBe("promotions");
    expect(await categoryOf(env, spam)).not.toBe("c1");
    expect((await jmap(env, "Email/changes", { sinceState: before })).updated.sort()).toEqual([trip, coupon].sort());

    // Asked once: the next sweep has nothing to do.
    expect(await categorizeInbox(env, { fetcher: answer })).toMatchObject({ asked: 0 });
    const status = (await api(env, "/api/categories")).body.classifier;
    expect(status).toMatchObject({ configured: true, model: "clef-flash", pending: 0, lastError: null });
    expect(status.lastOkAt).toEqual(expect.any(Number));

    // A sender the user categorized is theirs: the classifier isn't asked.
    await api(env, "/api/category-senders", "POST", { address: "ana@example.org", category: "primary" });
    await send(env, { from: "Ana <ana@example.org>", subject: "Another coupon" });
    expect(await categorizeInbox(env, { fetcher: answer })).toMatchObject({ asked: 0 });

    // A new category puts what the classifier sorted back in its queue.
    await api(env, "/api/categories", "POST", { name: "Bills", description: "Utility bills" });
    expect((await api(env, "/api/categories")).body.classifier.pending).toBe(1);
    expect(await categorizeInbox(env, { fetcher: answer })).toMatchObject({ asked: 1, changed: 0 });
  });

  it("without an allowance asks about old mail too, and drops answers to categories that have since changed", async () => {
    const env = testEnv({ CLASSIFIER_URL });
    const recent = await send(env, { subject: "Recent" });
    const old = await send(env, { subject: "Old" });
    await setReceivedAt(env, { [old]: Date.now() - 400 * 24 * HOUR });
    const mailbox = mailboxOf(env);
    const work = (await mailbox.categoryWork("sweep-1", 10, null))!;
    expect(work.messages.map((m) => m.id)).toEqual([recent, old]);
    expect(work.wakeAt).toBeNull();
    // Another sweep can't take the queue meanwhile.
    expect(await mailbox.categoryWork("sweep-2", 10, null)).toBeNull();
    await api(env, "/api/categories", "POST", { name: "School", description: "The kids' school" });
    const answer = { category: "updates", confidence: 1 };
    expect(await mailbox.applyCategories("sweep-1", work.generation, [{ id: recent, answer, tokens: 700 }, { id: old, answer, tokens: 650 }])).toBe(0);
    expect(await categoryOf(env, recent)).toBe("primary");
    // What was asked still cost what it did.
    expect(await mailbox.classifierStatus(true)).toMatchObject({ usedTokens: 1350, budget: null, pending: 1, backlog: 1 });
    await mailbox.endCategorySweep("sweep-1", null);
    expect((await mailbox.categoryWork("sweep-2", 10, null))!.messages.map((m) => m.id)).toEqual([recent, old]);
  });

  it("asks Clef on Workers AI about new mail as it arrives, and older mail in the day's last hour (UTC)", async () => {
    const calls: { model: string; body: any }[] = [];
    const ai = fakeAi((subject) => (/week|month/i.test(subject) ? "promotions" : "updates"), calls);
    const env = testEnv({ CLASSIFIER_MODEL: "clef", AI: ai });
    const fresh = await send(env, { from: "Ana <ana@example.org>", subject: "Fresh" });
    const fresher = await send(env, { from: "Ana <ana@example.org>", subject: "Fresher" });
    const week = await send(env, { from: "Ana <ana@example.org>", subject: "Last week" });
    const month = await send(env, { from: "Ana <ana@example.org>", subject: "Last month" });
    await setReceivedAt(env, { [fresh]: NOON - 2 * HOUR, [fresher]: NOON - HOUR, [week]: NOON - 7 * 24 * HOUR, [month]: NOON - 30 * 24 * HOUR });

    // At noon: the new mail only.
    expect(await categorizeInbox(env, { now: NOON })).toMatchObject({ asked: 2, changed: 2 });
    expect(calls.map((c) => [c.model, c.body.model, c.body.state.email.subject])).toEqual([
      ["@cf/cloudflare/clef", "clef", "Fresher"],
      ["@cf/cloudflare/clef", "clef", "Fresh"],
    ]);
    expect(await categoryOf(env, fresh)).toBe("updates");
    expect(await categoryOf(env, week)).toBe("primary");
    // Workers AI's free 10,000 neurons less the margin, at Clef's 21,818 a million tokens.
    const budget = { dailyTokens: Math.floor((9500 / 21_818) * 1e6) };
    expect(await mailboxOf(env).classifierStatus(true, budget, NOON)).toMatchObject({
      pending: 0,
      backlog: 2,
      usedTokens: 1200,
      budget: { dailyTokens: 435_420, resetsAt: DAY + 24 * HOUR, backlogFrom: DAY + 23 * HOUR },
    });
    expect((await api(env, "/api/categories")).body.classifier).toMatchObject({ configured: true, model: "clef", budget: { dailyTokens: 435_420 } });
    // The rest of the day there's nothing else to ask about.
    expect(await categorizeInbox(env, { now: NOON + 3 * HOUR })).toMatchObject({ asked: 0 });

    // From 23:00 UTC: the backlog, newest first.
    expect(await categorizeInbox(env, { now: LATE })).toMatchObject({ asked: 2, changed: 2 });
    expect(calls.slice(2).map((c) => c.body.state.email.subject)).toEqual(["Last week", "Last month"]);
    expect(await categoryOf(env, month)).toBe("promotions");
    expect(await mailboxOf(env).classifierStatus(true, budget, LATE)).toMatchObject({ pending: 0, backlog: 0, usedTokens: 2400 });
  });

  it("keeps to the day's allowance: new mail first, a reserve left for it in the backlog's hour, and the reset awaited", async () => {
    const env = testEnv();
    const ids: string[] = [];
    for (const subject of ["New", "Newer", "Old", "Older"]) ids.push(await send(env, { subject }));
    const [neu, newer, old, older] = ids as [string, string, string, string];
    await setReceivedAt(env, { [neu]: NOON - 2 * HOUR, [newer]: NOON - HOUR, [old]: NOON - 3 * 24 * HOUR, [older]: NOON - 4 * 24 * HOUR });
    const mailbox = mailboxOf(env);
    // What the Mailbox will estimate each to cost, newest first.
    const probe = (await mailbox.categoryWork("probe", 10, null, LATE))!;
    expect(probe.messages.map((m) => m.id)).toEqual([newer, neu, old, older]);
    const cost = probe.messages.map((m) => estimateTokens(categoryRequest("", m.state, probe.options)));
    await mailbox.endCategorySweep("probe", null);
    const all = cost.reduce((a, b) => a + b, 0);
    const answer = { category: "updates", confidence: 1 };

    // In the backlog's hour, with room for all four: the last doesn't fit in what the 5% reserve
    // for new mail leaves, so it waits for tomorrow's hour (nothing wakes the Mailbox for it).
    const budget = { dailyTokens: all };
    let work = (await mailbox.categoryWork("late", 10, budget, LATE))!;
    expect(work.messages.map((m) => m.id)).toEqual([newer, neu, old]);
    expect(work.wakeAt).toBeNull();
    expect((await mailbox.classifierStatus(true, budget, LATE)).usedTokens).toBe(cost[0]! + cost[1]! + cost[2]!);
    // They cost less than estimated (they always do): the difference goes back, and makes room.
    await mailbox.applyCategories("late", work.generation, work.messages.map((m) => ({ id: m.id, answer, tokens: 10 })), LATE);
    expect((await mailbox.classifierStatus(true, budget, LATE)).usedTokens).toBe(30);
    work = (await mailbox.categoryWork("late", 10, budget, LATE))!;
    expect(work.messages.map((m) => m.id)).toEqual([older]);
    await mailbox.applyCategories("late", work.generation, [{ id: older, answer, tokens: 10 }], LATE);
    await mailbox.endCategorySweep("late", null);

    // The next day: new mail, as long as the day's allowance covers it; then the reset.
    const tomorrow = NOON + 24 * HOUR;
    const later = await send(env, { subject: "Later" });
    const latest = await send(env, { subject: "Latest" });
    await setReceivedAt(env, { [later]: tomorrow - 2 * HOUR, [latest]: tomorrow - HOUR });
    const small = { dailyTokens: cost[0]! + Math.floor(cost[0]! / 2) };
    expect((await mailbox.classifierStatus(true, small, tomorrow)).usedTokens).toBe(0);
    work = (await mailbox.categoryWork("day", 10, small, tomorrow))!;
    expect(work.messages.map((m) => m.id)).toEqual([latest]);
    expect(work.wakeAt).toBe(DAY + 48 * HOUR);
    await mailbox.applyCategories("day", work.generation, [{ id: latest, answer, tokens: cost[0]! }], tomorrow);
    await mailbox.endCategorySweep("day", { ok: true, model: "clef" }, false, work.wakeAt);
    await runInDurableObject(mailbox, async (_instance, state) => expect(await state.storage.getAlarm()).toBe(DAY + 48 * HOUR));
    work = (await mailbox.categoryWork("day", 10, small, tomorrow))!;
    expect(work.messages).toEqual([]);
    expect(work.wakeAt).toBe(DAY + 48 * HOUR);
    await mailbox.endCategorySweep("day", null);
    // After midnight the allowance is whole again.
    work = (await mailbox.categoryWork("night", 10, small, DAY + 48 * HOUR + 60_000))!;
    expect(work.messages.map((m) => m.id)).toEqual([later]);
    await mailbox.endCategorySweep("night", null);
  });

  it("tells Workers AI failing from a request it refused, and stops when it refuses every one", async () => {
    let fail: ((subject: string) => Error | null) | null = () => aiError("3040: Capacity temporarily exceeded, please try again.");
    const answer = fakeAi(() => "updates");
    const ai = { run: (model: string, body: any) => (fail?.(body.state.email.subject) ? Promise.reject(fail(body.state.email.subject)) : answer.run(model, body)) };
    const env = testEnv({ CLASSIFIER_MODEL: "clef", AI: ai });
    await send(env, { subject: "Hello" });
    await send(env, { subject: "Poison" });

    // Out of capacity: the sweep stops, the mail waits, and the next sweep waits a minute.
    expect(await categorizeInbox(env)).toMatchObject({ asked: 0, error: "Workers AI: 3040: Capacity temporarily exceeded, please try again." });
    expect(await categorizeInbox(env)).toMatchObject({ skipped: "backoff" });

    // Every request refused: the requests are wrong, not the mail. Stop, and keep it waiting.
    fail = () => aiError("5012: Unsupported model 'clef-flash'. Use 'clef'.");
    expect((await categorizeInbox(env, { force: true })).error).toMatch(/refused the request: 5012: Unsupported model/);
    expect((await api(env, "/api/categories")).body.classifier).toMatchObject({ pending: 2 });

    // One refused among others: only that message keeps its guess, and isn't asked again.
    fail = (subject) => (subject === "Poison" ? aiError("5006: Error: required properties at '/' are 'model,state,questions'") : null);
    expect(await categorizeInbox(env, { force: true })).toMatchObject({ asked: 2, changed: 1 });
    expect((await api(env, "/api/categories")).body.classifier).toMatchObject({ pending: 0, lastError: "Workers AI refused the request: 5012: Unsupported model 'clef-flash'. Use 'clef'." });
    expect(await categorizeInbox(env)).toMatchObject({ asked: 0 });
  });

  it("stops at a classifier that can't be reached, says why, and waits before trying again", async () => {
    const env = testEnv({ CLASSIFIER_URL });
    const id = await send(env, { subject: "Hello" });
    let calls = 0;
    const down = (async () => {
      calls++;
      return new Response("<html>Bad gateway</html>", { status: 502 });
    }) as typeof fetch;
    const result = await categorizeInbox(env, { fetcher: down });
    expect(result).toMatchObject({ asked: 0, error: "the classifier answered HTTP 502" });
    expect(calls).toBe(1);
    expect(await categoryOf(env, id)).toBe("primary");
    expect((await api(env, "/api/categories")).body.classifier).toMatchObject({ lastError: "the classifier answered HTTP 502", pending: 1 });
    expect(await categorizeInbox(env, { fetcher: down })).toMatchObject({ skipped: "backoff" });
    expect(calls).toBe(1);

    // Access's login redirect means the service token is wrong; one bad answer only costs its message.
    const redirect = (async () => new Response(null, { status: 302, headers: { Location: "https://x.cloudflareaccess.com/login" } })) as typeof fetch;
    expect((await categorizeInbox(env, { fetcher: redirect, force: true })).error).toMatch(/Access service token/);
    const garbled = (async () => Response.json({ answers: { category: { choice: "weather" } } })) as typeof fetch;
    expect(await categorizeInbox(env, { fetcher: garbled, force: true })).toMatchObject({ asked: 1, changed: 0 });
    expect((await api(env, "/api/categories")).body.classifier).toMatchObject({ pending: 0 });
  });

  it("does nothing without a classifier, and says so when asked to sort now", async () => {
    const env = testEnv();
    await send(env, { subject: "Hello" });
    expect((await api(env, "/api/categories/sort", "POST")).body).toEqual({ asked: 0, changed: 0, skipped: "unconfigured" });
    // Nothing is set to wake the Mailbox for it either.
    await runInDurableObject(mailboxOf(env), async (_instance, state) => expect(await state.storage.getAlarm()).toBeNull());
  });

  it("sets the Mailbox's alarm only while mail waits: soon to carry on, later after a failure", async () => {
    const env = testEnv({ CLASSIFIER_URL });
    for (let i = 0; i < 3; i++) await send(env, { subject: `Hello ${i}` });
    const alarm = () => runInDurableObject(mailboxOf(env), (_instance, state) => state.storage.getAlarm());
    const answer = fakeClassifier(() => "primary");

    // Out of room after two: the alarm carries on in a moment.
    let started = Date.now();
    expect(await categorizeInbox(env, { fetcher: answer, limit: 2 })).toMatchObject({ asked: 2 });
    expect(await alarm()).toBeGreaterThanOrEqual(started);
    expect(await alarm()).toBeLessThan(started + 10_000);

    // The alarm runs the sweep inside the Mailbox; with nothing left, it sets no other.
    await runInDurableObject(mailboxOf(env), async (_instance, state) => state.storage.deleteAlarm());
    expect(await categorizeInbox(env, { fetcher: answer })).toMatchObject({ asked: 1 });
    expect(await alarm()).toBeNull();

    // Unreachable: asked again after a minute, then two, ...
    await send(env, { subject: "Hello again" });
    started = Date.now();
    const down = (async () => new Response("", { status: 503 })) as typeof fetch;
    expect(await categorizeInbox(env, { fetcher: down })).toMatchObject({ error: "the classifier answered HTTP 503" });
    expect(await alarm()).toBeGreaterThanOrEqual(started + 60_000);
    expect(await alarm()).toBeLessThan(started + 70_000);
  });

  it("guesses the mail from before categories in batches, and leaves Sent mail without one", async () => {
    const env = testEnv();
    await runInDurableObject(mailboxOf(env), async (_instance, state) => {
      const sql = state.storage.sql;
      for (const { name } of sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'messages_fts_%' AND name != '_cf_KV'")
        .toArray()) {
        sql.exec(`DROP TABLE IF EXISTS ${name}`);
      }
      migrate(sql, 6);
      const insert = (seq: number, folder: string, from: string, subject: string, list: string | null) =>
        sql.exec(
          `INSERT INTO messages (seq, id, received_at, envelope_from, alias, folder, auth, subject, from_address, list_unsubscribe, size, created_modseq, updated_modseq)
           VALUES (?, ?, ?, '', 'alex@example.net', ?, 'none', ?, ?, ?, 1, 1, 1)`,
          seq, `m${seq}`, seq, folder, subject, from, list,
        );
      insert(1, "inbox", "ana@example.org", "Lunch?", null);
      insert(2, "inbox", "deals@shop.example", "Flash sale: 30% off", "<x>");
      insert(3, "archive", "orders@shop.example", "Order confirmation", "<x>");
      insert(4, "sent", "alex@example.net", "Re: Lunch?", null);
      migrate(sql);
      expect(sql.exec("SELECT id, category, category_by FROM messages ORDER BY seq").toArray()).toEqual([
        { id: "m1", category: null, category_by: null },
        { id: "m2", category: null, category_by: null },
        { id: "m3", category: null, category_by: null },
        { id: "m4", category: null, category_by: "none" },
      ]);
    });
    const mailbox = mailboxOf(env);
    expect(await mailbox.fillCategoryGuesses(2)).toBe(2);
    expect(await mailbox.fillCategoryGuesses(2)).toBe(1);
    expect(await mailbox.fillCategoryGuesses(2)).toBe(0);
    await runInDurableObject(mailbox, async (_instance, state) => {
      expect(state.storage.sql.exec("SELECT id, category, category_by, updated_modseq FROM messages ORDER BY seq").toArray()).toEqual([
        { id: "m1", category: "primary", category_by: "guess", updated_modseq: 1 },
        { id: "m2", category: "promotions", category_by: "guess", updated_modseq: 1 },
        { id: "m3", category: "transactions", category_by: "guess", updated_modseq: 1 },
        { id: "m4", category: null, category_by: "none", updated_modseq: 1 },
      ]);
    });
  });
});
