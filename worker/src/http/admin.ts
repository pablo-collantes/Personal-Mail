import { categorizeInbox, classifierConfig, sweepInBackground } from "../classifier";
import type { Mailbox } from "../mailbox";
import type { VipDraft } from "../sorting";
import type { AliasInfo, RuleDraft, Settings, SortRuleKind, StayedPut, VipRuleKind } from "../types";

/**
 * Small REST endpoints for what JMAP has no words for: VIP and sorting rules,
 * aliases and settings. Behind the same Access check as the
 * JMAP API.
 * (Folders themselves are JMAP mailboxes: create them with Mailbox/set.)
 *
 *   GET    /api/vips                  list VIP rules
 *   POST   /api/vips                  {kind: "address"|"domain", value, label?}
 *                                     → {vip, moved, stayed}: the sender's verified mail moves to VIP
 *          or                        {vips: [{kind, value, label?}, ...]} → {vips, moved, failed, stayed}:
 *                                     several at once, one re-sort and one push
 *   DELETE /api/vips/<id>             → {moved}: the mail it filed is sorted again
 *   GET    /api/rules                 list sorting rules
 *   POST   /api/rules                 {kind, value, folder} → {rule, moved, stayed}: matching mail
 *                                     filed earlier moves now. kind: "address" | "domain" (From),
 *                                     "alias" (sent to this address: arrival, To or Cc),
 *                                     "tag" (a +tag, without the "+"), "to_domain" (sent to that domain)
 *          or                        {rules: [{kind, value}, ...], folder} → {rules, moved, failed, stayed}:
 *                                     several into one folder, one re-sort and one push
 *                                     `stayed` counts the matching mail left where it was, by why
 *                                     (filed by hand, VIP, a more specific rule): see StayedPut
 *   DELETE /api/rules/<id>            → {moved}
 *   GET    /api/folders               {folders: [{id, name, role, showInInbox}]}
 *   PATCH  /api/folders/<id>          {showInInbox} → {folder}: list this folder's mail in the
 *                                     clients' Inbox view too (VIP and the user's own folders)
 *   GET    /api/aliases               list aliases with message counts
 *   PATCH  /api/aliases/<address>     {label?, status?: "active"|"blocked"}
 *   POST   /api/aliases/<address>/purge   block it and delete everything it received
 *   GET    /api/settings
 *   PATCH  /api/settings              {aliasMode?, vipRequireAuth?, attachmentRetentionDays?}
 *
 * Inbox categories (categories.ts): the built-in four and the user's own, each described in plain
 * words for the classifier. Every received message has one (the JMAP Email property `category`).
 *   GET    /api/categories            {categories: [{id, name, description, color, builtin, total,
 *                                     unread}], classifier: {configured, model, lastOkAt,
 *                                     lastErrorAt, lastError, pending, backlog, usedTokens,
 *                                     budget: {dailyTokens, resetsAt, backlogFrom} | null}}
 *   POST   /api/categories            {name, description, color?} → {category}: the classifier
 *                                     looks at the Inbox again with it among the choices
 *   PATCH  /api/categories/<id>       {name?, description?, color?} → {category} (the user's own only)
 *   DELETE /api/categories/<id>       → {moved}: its mail gets a quick guess again
 *   POST   /api/categories/sort       ask the classifier now, for up to 20 s → {asked, changed,
 *                                     skipped?, error?}; the Mailbox's alarm carries on after.
 *                                     With an allowance, the backlog still waits for its hour
 *   GET    /api/category-senders      {senders: [{address, category, createdAt}]}
 *   POST   /api/category-senders      {address, category} → {sender, moved}: "categorize sender",
 *                                     its mail so far and from now on
 *   DELETE /api/category-senders/<address>   → {moved}: its mail gets a quick guess again
 */
export async function adminApi(
  request: Request,
  url: URL,
  mailbox: DurableObjectStub<Mailbox>,
  {
    env,
    fetcher,
    background,
  }: {
    env: Env;
    /** The classifier's fetch (tests replace it). */
    fetcher?: typeof fetch;
    /** Starts work that may finish after the response. */
    background: (task: () => Promise<unknown>) => void;
  },
): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  // The categories changed: the classifier looks at the Inbox again, starting now.
  const resort = () => background(() => sweepInBackground(env, { budgetMs: 25_000, ...(fetcher ? { fetcher } : {}) }));
  try {
    if (path === "/api/vips") {
      if (method === "GET") return json({ vips: await mailbox.listVipRules() });
      if (method === "POST") {
        const body = await jsonBody<{ kind: VipRuleKind; value: string; label?: string | null; vips?: unknown }>(request);
        if (body.vips !== undefined) {
          const result = await mailbox.addVips(draftList(body.vips) as VipDraft[]);
          console.log("vips added", { asked: result.vips.length + result.failed.length, moved: result.moved, stayed: stayedLog(result.stayed) });
          return json(result, 201);
        }
        return json(await mailbox.addVip(body.kind, String(body.value ?? ""), body.label ?? null), 201);
      }
    }
    const vip = /^\/api\/vips\/(\d+)$/.exec(path);
    if (vip && method === "DELETE") {
      const { removed, moved } = await mailbox.removeVip(Number(vip[1]));
      return removed ? json({ ok: true, moved }) : json({ error: "No such VIP rule." }, 404);
    }

    if (path === "/api/rules") {
      if (method === "GET") return json({ rules: await mailbox.listSortRules() });
      if (method === "POST") {
        const body = await jsonBody<{ kind: SortRuleKind; value: string; folder: string; rules?: unknown }>(request);
        if (body.rules !== undefined) {
          const result = await mailbox.addSortRules(draftList(body.rules) as RuleDraft[], String(body.folder ?? ""));
          console.log("rules added", {
            folder: body.folder,
            asked: result.rules.length + result.failed.length,
            moved: result.moved,
            stayed: stayedLog(result.stayed),
          });
          return json(result, 201);
        }
        return json(await mailbox.addSortRule(body.kind, String(body.value ?? ""), String(body.folder ?? "")), 201);
      }
    }
    const rule = /^\/api\/rules\/(\d+)$/.exec(path);
    if (rule && method === "DELETE") {
      const { removed, moved } = await mailbox.removeSortRule(Number(rule[1]));
      return removed ? json({ ok: true, moved }) : json({ error: "No such rule." }, 404);
    }

    if (path === "/api/folders" && method === "GET") return json({ folders: await mailbox.listFolders() });
    const folder = /^\/api\/folders\/([^/]+)$/.exec(path);
    if (folder && method === "PATCH") {
      const body = await jsonBody<{ showInInbox?: boolean }>(request);
      return json({ folder: await mailbox.setShowInInbox(decodeURIComponent(folder[1]!), body.showInInbox as boolean) });
    }

    if (path === "/api/aliases" && method === "GET") return json({ aliases: await mailbox.listAliases() });
    const purge = /^\/api\/aliases\/([^/]+)\/purge$/.exec(path);
    if (purge && method === "POST") {
      return json({ deleted: await mailbox.purgeAlias(decodeURIComponent(purge[1]!)) });
    }
    const alias = /^\/api\/aliases\/([^/]+)$/.exec(path);
    if (alias && method === "PATCH") {
      const address = decodeURIComponent(alias[1]!);
      const body = await jsonBody<{ label?: string | null; status?: AliasInfo["status"] }>(request);
      await mailbox.setAlias(address, {
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.status !== undefined ? { status: body.status } : {}),
      });
      return json({ ok: true });
    }

    if (path === "/api/categories") {
      if (method === "GET") {
        const config = classifierConfig(env);
        const [categories, classifier] = await Promise.all([
          mailbox.listCategories(),
          mailbox.classifierStatus(config !== null, config?.budget ?? null),
        ]);
        return json({ categories, classifier });
      }
      if (method === "POST") {
        const category = await mailbox.addCategory(await jsonBody<Record<string, unknown>>(request));
        resort();
        return json({ category }, 201);
      }
    }
    if (path === "/api/categories/sort" && method === "POST") {
      return json(await categorizeInbox(env, { budgetMs: 20_000, force: true, ...(fetcher ? { fetcher } : {}) }));
    }
    const category = /^\/api\/categories\/([^/]+)$/.exec(path);
    if (category && method === "PATCH") {
      const updated = await mailbox.updateCategory(decodeURIComponent(category[1]!), await jsonBody<Record<string, unknown>>(request));
      resort();
      return json({ category: updated });
    }
    if (category && method === "DELETE") {
      const { removed, moved } = await mailbox.removeCategory(decodeURIComponent(category[1]!));
      if (!removed) return json({ error: "No such category." }, 404);
      resort();
      return json({ ok: true, moved });
    }

    if (path === "/api/category-senders") {
      if (method === "GET") return json({ senders: await mailbox.listCategorySenders() });
      if (method === "POST") {
        const body = await jsonBody<{ address?: unknown; category?: unknown }>(request);
        return json(await mailbox.setCategorySender(String(body.address ?? ""), String(body.category ?? "")), 201);
      }
    }
    const sender = /^\/api\/category-senders\/([^/]+)$/.exec(path);
    if (sender && method === "DELETE") {
      const { removed, moved } = await mailbox.removeCategorySender(decodeURIComponent(sender[1]!));
      if (!removed) return json({ error: "That sender has no category of its own." }, 404);
      resort();
      return json({ ok: true, moved });
    }

    if (path === "/api/settings") {
      if (method === "GET") return json({ settings: await mailbox.getSettings() });
      if (method === "PATCH") {
        return json({ settings: await mailbox.updateSettings(await jsonBody<Partial<Settings>>(request)) });
      }
    }

  } catch (err) {
    // Validation errors from the Mailbox carry a message meant for the user.
    return json({ error: err instanceof Error ? err.message : String(err) }, 400);
  }
  return json({ error: "Not found." }, 404);
}

/** Rules asked for in a batch: at most this many in one request. */
const MAX_DRAFTS = 500;

/** A batch's `rules` or `vips`: a list of {kind, value, label?} objects. */
function draftList(value: unknown): { kind: string; value: string; label?: string | null }[] {
  if (!Array.isArray(value) || !value.length) throw new Error("Give a non-empty list of rules.");
  if (value.length > MAX_DRAFTS) throw new Error(`At most ${MAX_DRAFTS} rules at once.`);
  return value.map((d) => {
    if (!d || typeof d !== "object") throw new Error("Each rule must be an object with a kind and a value.");
    const { kind, value: v, label } = d as Record<string, unknown>;
    return { kind: String(kind ?? ""), value: String(v ?? ""), ...(typeof label === "string" ? { label } : {}) };
  });
}

/** What a log line keeps of a StayedPut: counts, no addresses. */
function stayedLog(s: StayedPut) {
  return { byHand: s.byHand, vip: s.vip, unverified: s.unverified, otherRules: s.otherRules.reduce((n, r) => n + r.count, 0) };
}

async function jsonBody<T>(request: Request): Promise<T> {
  const body = (await request.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("The body must be a JSON object.");
  return body as T;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
