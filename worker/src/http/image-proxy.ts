/**
 * Remote images the user asked to see ("Load images" in the web client).
 *
 * The app's CSP only lets images load from this origin, data: and blob:, so
 * a message's own image URLs never load in the browser, whatever the
 * sanitiser lets through. Once the user asks, the client points those images
 * here instead (clients/jmap-webmail/lib/remote-images.ts) and the Worker
 * fetches them itself: the sender sees a Cloudflare address, never the
 * browser's address, headers or cookies, and nothing loads unasked.
 *
 *   GET /api/image?url=<http(s) URL>   the image, or an error status
 *
 * Only images come back (by Content-Type, or by their first bytes when the
 * server sends a generic type), at most MAX_BYTES, under a CSP that runs
 * nothing even when the response is opened on its own.
 */

export const IMAGE_PROXY_PATH = "/api/image";

const MAX_BYTES = 15 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const ACCEPT = "image/avif,image/webp,image/apng,image/*;q=0.8";
const USER_AGENT = "Mozilla/5.0 (compatible; PersonalMailImageProxy)";

export async function imageProxy(request: Request, url: URL, fetcher: typeof fetch): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return text("Method not allowed", 405);
  // The web client's own pages only: another site can't use the user's session to fetch through here.
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null && site !== "same-origin" && site !== "none") return text("Forbidden", 403);

  let target = remoteUrl(url.searchParams.get("url"));
  if (!target) return text("Not an http(s) URL", 400);

  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    for (let hop = 0; ; hop++) {
      if (refusedHost(target, url.hostname)) return text("Forbidden", 403);
      const upstream = await fetcher(target.toString(), {
        headers: { Accept: ACCEPT, "User-Agent": USER_AGENT },
        redirect: "manual",
        signal,
        // Opened again later, the sender isn't asked again for a day.
        cf: { cacheEverything: true, cacheTtl: 86_400 },
      } as RequestInit);
      if (upstream.status >= 300 && upstream.status < 400 && upstream.headers.has("Location")) {
        await upstream.body?.cancel();
        if (hop === MAX_REDIRECTS) return text("Too many redirects", 502);
        target = remoteUrl(new URL(upstream.headers.get("Location")!, target).toString());
        if (!target) return text("Redirected to a non-http(s) URL", 502);
        continue;
      }
      if (!upstream.ok) {
        await upstream.body?.cancel();
        return text(`The image's server answered ${upstream.status}`, 502);
      }
      const declared = Number(upstream.headers.get("Content-Length") ?? "0");
      if (declared > MAX_BYTES) {
        await upstream.body?.cancel();
        return text("Image too large", 413);
      }
      const bytes = await readCapped(upstream.body, MAX_BYTES);
      if (!bytes) return text("Image too large", 413);
      const type = imageType(upstream.headers.get("Content-Type"), bytes);
      if (!type) return text("Not an image", 415);
      return new Response(request.method === "HEAD" ? null : bytes, {
        headers: {
          "Content-Type": type,
          "Content-Length": String(bytes.byteLength),
          "Cache-Control": "private, max-age=86400",
          "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          "Cross-Origin-Resource-Policy": "same-origin",
        },
      });
    }
  } catch (err) {
    if (signal.aborted) return text("The image's server took too long", 504);
    console.warn("image proxy: fetch failed", { host: target?.hostname, error: err instanceof Error ? err.message : String(err) });
    return text("Couldn't fetch the image", 502);
  }
}

/** An absolute http(s) URL without credentials in it, or null. */
function remoteUrl(raw: string | null): URL | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  return u;
}

/**
 * This site itself (no loops through Access) and names or addresses that
 * aren't on the public internet. URL parsing has already turned numeric
 * forms like http://2130706433/ into dotted ones.
 */
export function refusedHost(u: URL, self: string): boolean {
  const host = u.hostname.toLowerCase();
  if (host === self.toLowerCase()) return true;
  if (host === "localhost" || /\.(localhost|local|internal|home\.arpa)$/.test(host)) return true;
  // IPv6 literals: mail images have no business using them, and private ranges hide among them.
  if (host.startsWith("[")) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

/** The whole body, or null past `max` bytes. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * The type to serve: the server's when it says image/..., else what the
 * first bytes show for the common formats (some hosts send every file as
 * application/octet-stream). Null when it isn't an image.
 */
export function imageType(declared: string | null, bytes: Uint8Array): string | null {
  const type = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  if (/^image\/[a-z0-9.+-]+$/.test(type)) return type;
  const starts = (...sig: number[]) => sig.every((v, i) => bytes[i] === v);
  const ascii = (from: number, s: string) => [...s].every((c, i) => bytes[from + i] === c.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, "GIF8")) return "image/gif";
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (ascii(4, "ftypavif")) return "image/avif";
  if (ascii(0, "BM")) return "image/bmp";
  if (starts(0, 0, 1, 0)) return "image/x-icon";
  return null;
}

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
