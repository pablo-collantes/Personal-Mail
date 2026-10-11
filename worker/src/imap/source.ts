import { DurableObject } from "cloudflare:workers";
import { saveFetched } from "../ingest";
import { tlsDial } from "./client";
import { imapPassword, imapSources } from "./config";
import { type SyncReport, syncSource } from "./sync";

/** The next poll starts this long after the last one ended (the object's own alarm). */
export const POLL_INTERVAL_MS = 15_000;
/** After a poll that failed (server down, network), wait a little longer, so an outage isn't hammered. */
export const ERROR_RETRY_MS = 60_000;
/** Stop starting new downloads after this long; the next poll carries on. */
const RUN_BUDGET_MS = 40_000;
/** Above this, only the header is imported (the queue consumer has 128 MB to parse in). */
const MAX_MESSAGE_BYTES = 30 * 1024 * 1024;
/** Which account this object polls, remembered for its alarm. */
const NAME_KEY = "name";

export type PollResult = SyncReport | { status: "busy" } | { status: "not-configured" } | { status: "error"; error: string };

/**
 * One per IMAP account: keeps its sync cursors, makes sure only one poll runs at a time, and is
 * its own clock. Each poll sets the alarm for the next, so between polls nothing holds the
 * object in memory and it costs no duration.
 */
export class ImapSource extends DurableObject<Env> {
  private running = false;

  async poll(name: string): Promise<PollResult> {
    if (this.running) return { status: "busy" };
    const source = imapSources(this.env).find((s) => s.name === name);
    const password = source ? imapPassword(this.env, source) : null;
    if (!source || !password) return { status: "not-configured" };

    this.running = true;
    let result: PollResult;
    try {
      result = await syncSource(source, password, {
        dial: tlsDial,
        state: this.ctx.storage,
        save: async (m) => void (await saveFetched(this.env, m)),
        now: () => Date.now(),
        deadline: Date.now() + RUN_BUDGET_MS,
        maxMessageBytes: MAX_MESSAGE_BYTES,
        dailyBackfillBytes: source.dailyBackfillMB * 1024 * 1024,
      });
    } catch (err) {
      result = { status: "error", error: String(err) };
    } finally {
      this.running = false;
    }
    await this.ctx.storage.put("lastRun", { at: Date.now(), ...result });
    return result;
  }

  /** Starts polling this account unless it already is: true when it had to (startImapPolling). */
  async startPolling(name: string): Promise<boolean> {
    await this.ctx.storage.put(NAME_KEY, name);
    if (this.running || (await this.ctx.storage.getAlarm()) !== null) return false;
    await this.ctx.storage.setAlarm(Date.now());
    return true;
  }

  /**
   * Polls, then sets the alarm for the next poll. It never throws, since the runtime gives up on
   * an alarm after six failed retries. An account whose password secret is gone stops here, until
   * startImapPolling sees the secret again.
   */
  override async alarm(): Promise<void> {
    const name = await this.ctx.storage.get<string>(NAME_KEY);
    if (!name) return;
    let result: PollResult;
    try {
      result = await this.poll(name);
    } catch (err) {
      result = { status: "error", error: String(err) };
    }
    logPoll(name, result);
    if (result.status === "not-configured") return;
    await this.ctx.storage.setAlarm(Date.now() + (result.status === "error" ? ERROR_RETRY_MS : POLL_INTERVAL_MS));
  }
}

/** Logs a poll only when something happened. */
function logPoll(name: string, result: PollResult): void {
  if (result.status === "busy" || result.status === "auth-backoff") return;
  if (result.status === "ok" && !result.imported && !result.backfilled) return;
  console.log("imap poll", { source: name, ...result });
}

/**
 * Hourly: makes sure each account that has its password secret set is polling. Each one keeps
 * itself going on its alarm, so this only starts one: the first time, or if its alarms ever stop.
 */
export async function startImapPolling(env: Env): Promise<void> {
  await Promise.all(
    imapSources(env)
      .filter((s) => imapPassword(env, s))
      .map(async (s) => {
        if (await env.IMAP_SOURCE.getByName(s.name).startPolling(s.name)) console.log("imap polling started", { source: s.name });
      }),
  );
}

/** Hourly reminder for accounts that are configured but can't be polled yet. */
export function logUnconfiguredSources(env: Env): void {
  for (const s of imapSources(env)) {
    if (!imapPassword(env, s)) console.log("imap source waiting for its password secret", { source: s.name, secret: s.passwordSecret });
  }
}
