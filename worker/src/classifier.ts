import { categoryAnswer, categoryRequest, estimateTokens, type CategoryAnswer } from "./categories";
import type { CategoryWork, ClassifierBudget } from "./category-store";

// The Worker's side of Inbox categories: asks the classifier about the mail waiting for it, and
// hands the answers to the Mailbox. The classifier answers SystemOne requests: Clef on Workers AI,
// or any SystemOne endpoint over HTTP (POST /v1/systemone: Clef-Flash on the user's own machine
// behind a Cloudflare Tunnel and Access, deploy/clef, or Jev). Neither set up, nothing is asked and
// every message keeps its quick guess.
//
// Workers AI, when CLASSIFIER_URL is unset:
//   AI                                the binding
//   CLASSIFIER_MODEL                  "clef" (@cf/cloudflare/clef) or "clef-flash" (a var)
//   CLASSIFIER_DAILY_NEURONS          what it may spend a UTC day (a var; DEFAULT_DAILY_NEURONS when
//                                     unset). New mail is asked about as it arrives and the backlog at
//                                     the end of the day, on what's left (category-store.ts, work).
// HTTP, with no allowance:
//   CLASSIFIER_URL                    e.g. https://clef.example.com/v1/systemone (a var)
//   CLASSIFIER_MODEL                  the request's `model` (a var; "clef-flash" when unset)
//   CLASSIFIER_ACCESS_CLIENT_ID       an Access service token, when the URL is behind Access (secrets)
//   CLASSIFIER_ACCESS_CLIENT_SECRET
//   CLASSIFIER_API_KEY                sent as a Bearer token, when the endpoint wants one (a secret)

/**
 * Workers AI's Clef models, and what a million input tokens costs in neurons; they bill nothing for
 * output (developers.cloudflare.com/workers-ai/platform/pricing, 2026-10-02).
 */
export const WORKERS_AI_MODELS: Record<string, { id: string; neuronsPerMillionTokens: number }> = {
  clef: { id: "@cf/cloudflare/clef", neuronsPerMillionTokens: 21_818 },
  "clef-flash": { id: "@cf/cloudflare/clef-flash", neuronsPerMillionTokens: 8_182 },
};
/**
 * Workers AI gives an account 10,000 neurons a day free (on the Paid plan, more is billed), shared
 * by everything on the account that uses it. This leaves a little of it for anything else.
 */
export const DEFAULT_DAILY_NEURONS = 9_500;

/** Workers AI's error codes for a request it refused as it stood (workers-ai/platform/errors), as opposed to the service failing. */
const REFUSED_REQUEST_CODES = new Set(["3003", "3006", "5004", "5006", "5012"]);

/** The part of the AI binding a sweep uses (tests pass their own). */
export interface AiRunner {
  run(model: string, inputs: unknown): Promise<unknown>;
}

export type ClassifierConfig =
  | { kind: "workers-ai"; model: string; modelId: string; budget: ClassifierBudget; ai: AiRunner }
  | {
      kind: "http";
      model: string;
      url: string;
      apiKey: string | null;
      accessClientId: string | null;
      accessClientSecret: string | null;
      budget: null;
    };

export function classifierConfig(env: Env): ClassifierConfig | null {
  const vars = env as unknown as Record<string, unknown>;
  const value = (key: string) => (typeof vars[key] === "string" && vars[key] ? (vars[key] as string) : null);
  const url = value("CLASSIFIER_URL");
  if (url) {
    return {
      kind: "http",
      url,
      model: value("CLASSIFIER_MODEL") ?? "clef-flash",
      apiKey: value("CLASSIFIER_API_KEY"),
      accessClientId: value("CLASSIFIER_ACCESS_CLIENT_ID"),
      accessClientSecret: value("CLASSIFIER_ACCESS_CLIENT_SECRET"),
      budget: null,
    };
  }
  const model = value("CLASSIFIER_MODEL");
  const workersAi = model ? WORKERS_AI_MODELS[model] : undefined;
  const ai = vars.AI as AiRunner | undefined;
  if (!model || !workersAi || !ai) return null;
  const neurons = Number(vars.CLASSIFIER_DAILY_NEURONS ?? DEFAULT_DAILY_NEURONS);
  return {
    kind: "workers-ai",
    model,
    modelId: workersAi.id,
    ai,
    budget: { dailyTokens: Math.floor(((Number.isFinite(neurons) ? neurons : DEFAULT_DAILY_NEURONS) / workersAi.neuronsPerMillionTokens) * 1e6) },
  };
}

/** Messages per batch: asked about together, answered with one change (one push). */
const BATCH = 48;
/** Requests in flight at once. The model answers one at a time anyway; this hides the round trips. */
const CONCURRENCY = 4;
/**
 * Workers AI takes 300 requests a minute for a Text Generation model such as Clef, per account
 * (workers-ai/platform/limits); its answers take about 0.3 s, so a sweep starts one at most this often.
 */
const WORKERS_AI_INTERVAL_MS = 250;
const REQUEST_TIMEOUT_MS = 20_000;
/** A sweep starts no batch after this long; the Mailbox's alarm carries on (Mailbox.endCategorySweep). */
const SWEEP_BUDGET_MS = 45_000;
/** Most mail one sweep asks about. */
const SWEEP_LIMIT = 1000;

/** The classifier can't be asked right now (down, unreachable, refusing us): the sweep stops. */
export class ClassifierUnavailable extends Error {}

export type SweepOutcome = { ok: true; model: string } | { ok: false; model: string; error: string };

/** One message's answer, and what asking cost in input tokens. */
export interface SweepAnswer {
  id: string;
  answer: CategoryAnswer | null;
  tokens: number;
}

/** What a sweep needs of the Mailbox: its stub, from the Worker, or the Mailbox itself, from its alarm. */
export interface SweepMailbox {
  classifierRetryAt(): number | null | Promise<number | null>;
  categoryWork(owner: string, limit: number, budget: ClassifierBudget | null, now?: number): CategoryWork | null | Promise<CategoryWork | null>;
  applyCategories(owner: string, generation: number, answers: SweepAnswer[], now?: number): number | Promise<number>;
  endCategorySweep(owner: string, outcome: SweepOutcome | null, more?: boolean, wakeAt?: number | null): Promise<void>;
}

export interface SweepOptions {
  budgetMs?: number;
  limit?: number;
  fetcher?: typeof fetch;
  /** Ignore the wait after failures (the user asked for a sweep). */
  force?: boolean;
  /** The Mailbox to work on; its stub by default. */
  mailbox?: SweepMailbox;
  /** The time the Mailbox goes by: which mail is new, the day's allowance (tests). */
  now?: number;
}

export interface SweepResult {
  /** Mail the classifier was asked about. */
  asked: number;
  /** Of that, how much changed category. */
  changed: number;
  /** Why it didn't start: no classifier configured, waiting after failures, or another sweep has the queue. */
  skipped?: "unconfigured" | "backoff" | "busy";
  /** Why it stopped early: the classifier couldn't be asked. */
  error?: string;
}

/**
 * One sweep: asks the classifier about the Inbox mail waiting for it, newest first, a batch at a
 * time, until none is left or the time is up (budgetMs) or, with an allowance, today's is spent.
 * Runs after new mail (index.ts), when the categories change (http/admin.ts), when the backlog's
 * hour starts (the backlog cron, index.ts), and from the Mailbox's alarm while mail still waits or
 * new mail waits for the allowance to reset; with nothing waiting the Mailbox sleeps.
 */
export async function categorizeInbox(env: Env, options: SweepOptions = {}): Promise<SweepResult> {
  const config = classifierConfig(env);
  if (!config) return { asked: 0, changed: 0, skipped: "unconfigured" };
  const mailbox = options.mailbox ?? (env.MAILBOX.getByName(env.MAILBOX_NAME) as unknown as SweepMailbox);
  if (!options.force) {
    const retryAt = await mailbox.classifierRetryAt();
    if (retryAt !== null && Date.now() < retryAt) return { asked: 0, changed: 0, skipped: "backoff" };
  }

  const owner = crypto.randomUUID();
  const budget = options.budgetMs ?? SWEEP_BUDGET_MS;
  const limit = options.limit ?? SWEEP_LIMIT;
  const started = Date.now();
  let asked = 0;
  let changed = 0;
  let outcome: SweepOutcome | null = null;
  let busy = false;
  // The last batch was full: there may be more waiting.
  let more = false;
  let wakeAt: number | null = null;
  const pace = pacer(config.kind === "workers-ai" ? WORKERS_AI_INTERVAL_MS : 0);
  try {
    while (asked < limit && Date.now() - started < budget) {
      const size = Math.min(BATCH, limit - asked);
      const work = await mailbox.categoryWork(owner, size, config.budget, options.now);
      if (!work) {
        busy = true;
        break;
      }
      more = work.messages.length === size;
      wakeAt = work.wakeAt;
      if (!work.messages.length) break;
      const refused: string[] = [];
      const answers = await mapLimit(work.messages, CONCURRENCY, async (m): Promise<SweepAnswer> => {
        const body = categoryRequest(config.model, m.state, work.options);
        await pace();
        let response: unknown;
        try {
          response = await askClassifier(config, body, options.fetcher);
        } catch (err) {
          if (err instanceof ClassifierUnavailable) throw err;
          // This message only, it seems: it keeps its guess. (Refused requests aren't billed.)
          refused.push(err instanceof Error ? err.message : String(err));
          console.warn("classifier refused the request", { id: m.id, error: String(err) });
          return { id: m.id, answer: null, tokens: 0 };
        }
        const usage = (response as { usage?: { input_tokens?: unknown } } | null)?.usage?.input_tokens;
        const tokens = typeof usage === "number" && usage >= 0 ? usage : estimateTokens(body);
        try {
          return { id: m.id, answer: categoryAnswer(response, work.options), tokens };
        } catch (err) {
          // A bad answer to this message: it keeps its guess.
          console.warn("classifier gave no answer", { id: m.id, error: String(err) });
          return { id: m.id, answer: null, tokens };
        }
      });
      // Every request refused is something wrong with all of them (a model it doesn't serve, a
      // request shape it no longer takes), not with these messages: stop, and keep them waiting.
      if (refused.length === answers.length) throw new ClassifierUnavailable(refused[0]!);
      changed += await mailbox.applyCategories(owner, work.generation, answers, options.now);
      asked += answers.length;
      outcome = { ok: true, model: config.model };
    }
  } catch (err) {
    outcome = { ok: false, model: config.model, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (!busy) await mailbox.endCategorySweep(owner, outcome, more, wakeAt);
  }
  const result: SweepResult = {
    asked,
    changed,
    ...(busy ? { skipped: "busy" as const } : {}),
    ...(outcome?.ok === false ? { error: outcome.error } : {}),
  };
  if (asked || result.error) console.log("categories", result);
  return result;
}

/** categorizeInbox for waitUntil: never rejects. */
export async function sweepInBackground(env: Env, options: SweepOptions = {}): Promise<void> {
  try {
    await categorizeInbox(env, options);
  } catch (err) {
    console.error("category sweep failed", { error: String(err) });
  }
}

/**
 * One SystemOne request. Anything that says the classifier as a whole can't be used throws
 * ClassifierUnavailable; a request refused as it stood throws a plain Error.
 */
export async function askClassifier(config: ClassifierConfig, body: unknown, fetcher: typeof fetch = fetch): Promise<unknown> {
  if (config.kind === "workers-ai") return askWorkersAi(config.ai, config.modelId, body);
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  if (config.accessClientId && config.accessClientSecret) {
    headers["CF-Access-Client-Id"] = config.accessClientId;
    headers["CF-Access-Client-Secret"] = config.accessClientSecret;
  }
  let response: Response;
  try {
    response = await fetcher(config.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // Access answers a missing or wrong token with a redirect to its login page.
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new ClassifierUnavailable(`couldn't reach the classifier: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = await response.text();
  if (response.status >= 300 && response.status < 400) {
    throw new ClassifierUnavailable(`the classifier redirected (HTTP ${response.status}): check its Access service token`);
  }
  if ([401, 403, 404, 408, 429].includes(response.status) || response.status >= 500) {
    // A tunnel with nothing behind it answers 502/530; Cloudflare's own pages aren't worth quoting.
    throw new ClassifierUnavailable(`the classifier answered HTTP ${response.status}${response.status < 500 ? `: ${text.slice(0, 200)}` : ""}`);
  }
  if (!response.ok) throw new Error(`the classifier refused the request (HTTP ${response.status}): ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new ClassifierUnavailable("the classifier's answer isn't JSON");
  }
}

/** One request to Workers AI through the AI binding. */
async function askWorkersAi(ai: AiRunner, modelId: string, body: unknown): Promise<unknown> {
  try {
    return await ai.run(modelId, body);
  } catch (err) {
    // The binding throws "AiError: 5006: ...", the code first.
    const message = err instanceof Error ? err.message : String(err);
    const code = /^(?:AiError:\s*)?(\d{4}):/.exec(message)?.[1];
    if (code && REFUSED_REQUEST_CODES.has(code)) throw new Error(`Workers AI refused the request: ${message.slice(0, 300)}`);
    throw new ClassifierUnavailable(`Workers AI: ${message.slice(0, 300)}`);
  }
}

/** Spaces out the calls of a sweep: each returns when the next request may start. */
function pacer(intervalMs: number): () => Promise<void> {
  let next = 0;
  return async () => {
    if (!intervalMs) return;
    const now = Date.now();
    const wait = next - now;
    next = Math.max(now, next) + intervalMs;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  };
}

/** `fn` over `items`, at most `limit` at a time, in order. The first rejection rejects the whole. */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
