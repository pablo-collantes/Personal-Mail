/**
 * The web client (a static export of the jmap-webmail fork in
 * clients/jmap-webmail, copied to worker/web by `npm run build:web`).
 *
 * Pages get a per-request nonce on every <script> and a CSP that allows
 * images only from this origin, data: and blob: (cid images), so a message
 * can't load a tracking pixel even if the sanitiser misses one.
 */

export const DEFAULT_LOCALE_PATH = "/en/";

export function appCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "media-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

export async function serveApp(request: Request, assets: Fetcher): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/") return Response.redirect(`${url.origin}${DEFAULT_LOCALE_PATH}`, 302);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const response = await assets.fetch(request);
  const type = response.headers.get("Content-Type") ?? "";
  if (!type.startsWith("text/html")) {
    const out = new Response(response.body, response);
    // Next.js puts a content hash in every file name under /_next/static/.
    if (url.pathname.startsWith("/_next/static/") && response.ok) {
      out.headers.set("Cache-Control", "private, max-age=31536000, immutable");
    }
    return out;
  }

  const nonce = newNonce();
  const page = new HTMLRewriter()
    .on("script", {
      element(e) {
        e.setAttribute("nonce", nonce);
      },
    })
    .transform(response);
  const out = new Response(page.body, page);
  out.headers.set("Content-Security-Policy", appCsp(nonce));
  out.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  out.headers.set("Cache-Control", "no-store");
  return out;
}
