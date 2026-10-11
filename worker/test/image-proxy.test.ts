import { describe, expect, it } from "vitest";
import { imageProxy, imageType, refusedHost } from "../src/http/image-proxy";

const SELF = "https://mail.example.com";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

/** A fake internet: URL → response, recording what was asked and how. */
function internet(pages: Record<string, () => Response>) {
  const asked: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    asked.push({ url, init });
    const page = pages[url];
    return page ? page() : new Response("nope", { status: 404 });
  }) as typeof fetch;
  return { fetcher, asked };
}

function get(target: string, headers: Record<string, string> = {}): [Request, URL] {
  const url = new URL(`${SELF}/api/image?url=${encodeURIComponent(target)}`);
  return [new Request(url, { headers }), url];
}

describe("image proxy", () => {
  it("fetches an image without the browser's headers and serves it locked down", async () => {
    const net = internet({ "https://img.example/a.png": () => new Response(PNG, { headers: { "Content-Type": "image/png", "Set-Cookie": "t=1" } }) });
    const res = await imageProxy(...get("https://img.example/a.png", { Cookie: "CF_Authorization=secret", "Sec-Fetch-Site": "same-origin" }), net.fetcher);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(res.headers.get("Cross-Origin-Resource-Policy")).toBe("same-origin");
    expect(res.headers.get("Set-Cookie")).toBeNull();
    // The sender's server sees none of the browser's request: no cookie, no referrer.
    const sent = new Headers(net.asked[0]!.init?.headers);
    expect(sent.get("Cookie")).toBeNull();
    expect(sent.get("Referer")).toBeNull();
    expect(sent.get("Accept")).toMatch(/^image\//);
  });

  it("follows redirects, checking every hop", async () => {
    const net = internet({
      "http://img.example/a.png": () => new Response(null, { status: 301, headers: { Location: "https://cdn.example/a.png" } }),
      "https://cdn.example/a.png": () => new Response(PNG, { headers: { "Content-Type": "image/png" } }),
      "https://img.example/sneaky.png": () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/admin" } }),
    });
    expect((await imageProxy(...get("http://img.example/a.png"), net.fetcher)).status).toBe(200);
    expect(net.asked.map((a) => a.url)).toEqual(["http://img.example/a.png", "https://cdn.example/a.png"]);
    expect((await imageProxy(...get("https://img.example/sneaky.png"), net.fetcher)).status).toBe(403);
    expect(net.asked.map((a) => a.url)).not.toContain("http://127.0.0.1/admin");
  });

  it("serves images only", async () => {
    const net = internet({
      "https://img.example/page": () => new Response("<html>", { headers: { "Content-Type": "text/html" } }),
      "https://img.example/octet": () => new Response(PNG, { headers: { "Content-Type": "application/octet-stream" } }),
      "https://img.example/gone": () => new Response("no", { status: 404 }),
      "https://img.example/huge": () => new Response("x", { headers: { "Content-Type": "image/png", "Content-Length": String(16 * 1024 * 1024) } }),
    });
    expect((await imageProxy(...get("https://img.example/page"), net.fetcher)).status).toBe(415);
    const sniffed = await imageProxy(...get("https://img.example/octet"), net.fetcher);
    expect(sniffed.status).toBe(200);
    expect(sniffed.headers.get("Content-Type")).toBe("image/png");
    expect((await imageProxy(...get("https://img.example/gone"), net.fetcher)).status).toBe(502);
    expect((await imageProxy(...get("https://img.example/huge"), net.fetcher)).status).toBe(413);
  });

  it("refuses what isn't a public http(s) image URL, and other sites' pages", async () => {
    const net = internet({});
    for (const target of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pw@img.example/a.png", "not a url"]) {
      expect((await imageProxy(...get(target), net.fetcher)).status).toBe(400);
    }
    for (const target of [`${SELF}/api/vips`, "http://localhost:8787/", "http://10.0.0.1/a.png", "http://2130706433/a.png", "http://[::1]/a.png"]) {
      expect((await imageProxy(...get(target), net.fetcher)).status).toBe(403);
    }
    expect((await imageProxy(...get("https://img.example/a.png", { "Sec-Fetch-Site": "cross-site" }), net.fetcher)).status).toBe(403);
    expect((await imageProxy(new Request(`${SELF}/api/image?url=x`, { method: "POST" }), new URL(`${SELF}/api/image?url=x`), net.fetcher)).status).toBe(405);
    expect(net.asked).toEqual([]);
  });
});

describe("refusedHost", () => {
  it("lets public names and addresses through", () => {
    for (const u of ["https://img.example/a.png", "http://93.184.215.14/a.png", "https://172.32.0.1/", "https://100.128.0.1/"]) {
      expect(refusedHost(new URL(u), "mail.example.com")).toBe(false);
    }
  });

  it("refuses this site, local names and private ranges", () => {
    for (const u of [
      "https://MAIL.example.com/x",
      "http://localhost/",
      "http://printer.local/",
      "http://router.home.arpa/",
      "http://127.0.0.1/",
      "http://0.0.0.0/",
      "http://169.254.169.254/",
      "http://172.16.0.1/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://[fd00::1]/",
    ]) {
      expect(refusedHost(new URL(u), "mail.example.com"), u).toBe(true);
    }
  });
});

describe("imageType", () => {
  it("trusts a declared image type and sniffs generic ones", () => {
    expect(imageType("image/webp; charset=binary", new Uint8Array())).toBe("image/webp");
    expect(imageType("application/octet-stream", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageType(null, new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(imageType("text/html", new TextEncoder().encode("<html>"))).toBeNull();
  });
});
