import { sweepInBackground } from "./classifier";
import { handleHttp } from "./http/router";
import { logUnconfiguredSources, startImapPolling } from "./imap/source";
import { indexMessage, receiveEmail, runMaintenance } from "./ingest";
import type { IngestJob } from "./types";

export { ImapSource } from "./imap/source";
export { Mailbox } from "./mailbox";

/** Must match the daily entry in wrangler.jsonc, at BACKLOG_FROM_UTC_HOUR (category-store.ts). */
const BACKLOG_CRON = "0 23 * * *";

export default {
  async email(message, env) {
    await receiveEmail(message, env);
  },

  async queue(batch, env, ctx) {
    let fresh = false;
    for (const msg of batch.messages) {
      try {
        const result = await indexMessage(env, msg.body);
        fresh ||= result.status === "stored" && !msg.body.quiet;
        const notify = result.status === "stored" && result.notify && !msg.body.quiet;
        console.log("indexed", { id: msg.body.id, source: msg.body.source ?? "routing", ...result, notify });
        msg.ack();
      } catch (err) {
        console.error("index failed", { id: msg.body.id, attempt: msg.attempts, error: String(err) });
        msg.retry({ delaySeconds: Math.min(30 * msg.attempts, 600) });
      }
    }
    // New mail: ask the classifier about it now rather than at the next minute's sweep.
    if (fresh) ctx.waitUntil(sweepInBackground(env, { budgetMs: 15_000 }));
  },

  async scheduled(controller, env) {
    if (controller.cron === BACKLOG_CRON) {
      // The day's last hour: older mail gets what's left of the classifier's allowance before it
      // resets; the Mailbox's alarm carries on after this sweep's time is up.
      await sweepInBackground(env);
    } else {
      // Hourly. Each IMAP account polls on its own alarm (ImapSource); this makes sure it does.
      await startImapPolling(env);
      logUnconfiguredSources(env);
      await runMaintenance(env);
    }
  },

  // JMAP API and web client on the mail hostname, behind Cloudflare Access.
  async fetch(request, env, ctx) {
    return handleHttp(request, env, { waitUntil: (promise) => ctx.waitUntil(promise) });
  },
} satisfies ExportedHandler<Env, IngestJob>;
