import { blobHeaders, blobKey, parseBlobId } from "../jmap/blobs";
import { PUSH_PATH, type Mailbox } from "../mailbox";
import { SESSION_STATE } from "../jmap/mail";
import { LIMITS, RequestError, parseRequest, type JmapRequest, type JmapResponse } from "../jmap/protocol";
import { sessionObject } from "../jmap/session";
import { AccessDenied, accessConfig, verifyAccess, type Caller } from "./access";
import { adminApi } from "./admin";
import { serveApp } from "./app";
import { eventSourceResponse } from "./eventsource";
import { IMAGE_PROXY_PATH, imageProxy } from "./image-proxy";

/**
 * Everything on the mail hostname. Cloudflare Access guards the hostname;
 * this checks Access's JWT again and refuses everything until Access is
 * configured (ACCESS_TEAM_DOMAIN and ACCESS_AUD in wrangler.jsonc).
 *
 *   /.well-known/jmap, /jmap/session   JMAP session
 *   /jmap/api                          JMAP method calls
 *   /jmap/download/...                 blobs (attachments, bodies, raw messages)
 *   /jmap/eventsource                  push (StateChange events)
 *   /api/image?url=...                 a remote image the user asked to see (image-proxy.ts)
 *   /api/...                           VIP and sorting rules, aliases, settings (admin.ts)
 *   anything else                      the web client's static files
 */

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
};

export interface HttpDeps {
  /** Outbound requests: Access's signing keys and remote images (tests replace it). */
  fetcher?: typeof fetch;
  /** Work that may finish after the response (ctx.waitUntil). Without it (tests) that work isn't started. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export async function handleHttp(request: Request, env: Env, deps: HttpDeps = {}): Promise<Response> {
  return withHeaders(await route(request, env, deps));
}

function withHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!out.headers.has(k)) out.headers.set(k, v);
  return out;
}

/**
 * `wrangler dev` only: DEV_ACCESS_EMAIL in .dev.vars (never uploaded) signs
 * in requests to localhost as that person. Requests through Cloudflare never
 * have a localhost hostname, so this can't apply in production.
 */
function devCaller(url: URL, env: Env): Caller | null {
  const email = (env as unknown as Record<string, unknown>).DEV_ACCESS_EMAIL;
  if (typeof email !== "string" || !email) return null;
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" ? { kind: "user", email } : null;
}

async function route(request: Request, env: Env, deps: HttpDeps): Promise<Response> {
  const url = new URL(request.url);
  const config = accessConfig(env);
  let caller: Caller | null = devCaller(url, env);
  if (!caller) {
    if (!config) return text("Not found", 404);
    try {
      caller = await verifyAccess(request, config, deps.fetcher ? { fetcher: deps.fetcher } : {});
    } catch (err) {
      if (!(err instanceof AccessDenied)) throw err;
      console.warn("access denied", { path: url.pathname, reason: err.message });
      return text("Forbidden", 403);
    }
  }

  // Browsers attach the Access cookie to cross-site requests too; refuse
  // changes that come from another site. Native apps send no Origin.
  const origin = request.headers.get("Origin");
  if (!["GET", "HEAD"].includes(request.method) && origin !== null && origin !== url.origin) {
    return text("Forbidden", 403);
  }

  const accountId = env.MAILBOX_NAME;
  const mailbox = env.MAILBOX.getByName(env.MAILBOX_NAME);
  const path = url.pathname;

  if (path === "/.well-known/jmap" || path === "/jmap/session") {
    if (request.method !== "GET") return text("Method not allowed", 405);
    const username = caller.kind === "user" ? caller.email : ([...(config?.emails ?? [])][0] ?? accountId);
    return Response.json(sessionObject(url.origin, accountId, username), { headers: { "Cache-Control": "no-store" } });
  }

  if (path === "/jmap/api") {
    if (request.method !== "POST") return text("Method not allowed", 405);
    try {
      const length = Number(request.headers.get("Content-Length") ?? "0");
      if (length > LIMITS.maxSizeRequest) throw new RequestError("limit", "The request is too large.", "maxSizeRequest");
      const body = await request.text();
      if (body.length > LIMITS.maxSizeRequest) throw new RequestError("limit", "The request is too large.", "maxSizeRequest");
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new RequestError("notJSON", "The request body is not JSON.");
      }
      const jmapRequest = parseRequest(parsed);
      const response = echoOnly(jmapRequest) ?? (await mailbox.jmap(jmapRequest, accountId));
      return Response.json(response, { headers: { "Cache-Control": "no-store" } });
    } catch (err) {
      if (err instanceof RequestError) return err.toResponse();
      throw err;
    }
  }

  const download = /^\/jmap\/download\/([^/]+)\/([^/]+)\/([^/]*)$/.exec(path);
  if (download) {
    if (request.method !== "GET") return text("Method not allowed", 405);
    const [, account, blobId, rawName] = download as unknown as [string, string, string, string];
    const ref = parseBlobId(decodeURIComponent(blobId));
    if (decodeURIComponent(account) !== accountId || !ref) return text("Not found", 404);
    const name = decodeURIComponent(rawName) || "download";
    const type = url.searchParams.get("type");
    const key = blobKey(ref);
    if (key === null) {
      const body = await mailbox.bodyText(ref.id);
      if (body === null) return text("Not found", 404);
      return new Response(body, { headers: blobHeaders(ref, name, type, undefined) });
    }
    const object = await env.MAIL_BUCKET.get(key);
    if (!object) return text("Not found", 404);
    const headers = blobHeaders(ref, name, type, object.httpMetadata?.contentType);
    headers.set("Content-Length", String(object.size));
    return new Response(object.body, { headers });
  }

  if (/^\/jmap\/upload\//.test(path)) {
    return Response.json(
      { type: "urn:ietf:params:jmap:error:forbidden", status: 403, detail: "This mailbox is receive-only." },
      { status: 403, headers: { "content-type": "application/problem+json" } },
    );
  }

  if (path === "/jmap/eventsource") {
    if (request.method !== "GET") return text("Method not allowed", 405);
    return eventSourceResponse(request, { accountId, connect: () => pushSocket(mailbox) });
  }

  if (path === IMAGE_PROXY_PATH) return imageProxy(request, url, deps.fetcher ?? ((input, init) => fetch(input, init)));

  if (path.startsWith("/api/")) {
    const { waitUntil } = deps;
    return adminApi(request, url, mailbox, {
      env,
      fetcher: deps.fetcher,
      background: (task) => waitUntil?.(task()),
    });
  }

  if (env.ASSETS) return serveApp(request, env.ASSETS);
  return text("Not found", 404);
}

/**
 * A request of nothing but Core/echo, the web client's keep-alive, answered
 * here so it doesn't wake the Mailbox. Null for anything else.
 */
function echoOnly(request: JmapRequest): JmapResponse | null {
  const calls = request.methodCalls;
  if (!calls.length || !calls.every(([name, args]) => name === "Core/echo" && !Object.keys(args).some((k) => k.startsWith("#")))) {
    return null;
  }
  return {
    methodResponses: calls.map(([name, args, id]) => [name, args, id]),
    sessionState: SESSION_STATE,
    ...(request.createdIds ? { createdIds: request.createdIds } : {}),
  };
}

/** A push socket to the Mailbox (Mailbox.fetch), which sleeps until something changes. */
async function pushSocket(mailbox: DurableObjectStub<Mailbox>): Promise<WebSocket> {
  const response = await mailbox.fetch(`https://mailbox${PUSH_PATH}`, { headers: { Upgrade: "websocket" } });
  if (!response.webSocket) throw new Error(`the Mailbox refused a push socket (HTTP ${response.status})`);
  return response.webSocket;
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
