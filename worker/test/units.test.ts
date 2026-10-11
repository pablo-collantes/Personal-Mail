import { describe, expect, it } from "vitest";
import { aligned, domainOf, organizationalDomain } from "../src/address";
import { authVerdict, parseAuthenticationResults } from "../src/auth-results";
import { classify, tagOf, type Classifiable } from "../src/classify";
import { idFromRawKey, idTime, newId, rawKey } from "../src/ids";
import { highlight, snippet } from "../src/snippet";
import { spamVerdict } from "../src/spam";
import { htmlToText, makePreview, toFtsQuery } from "../src/text";
import { DEFAULT_SETTINGS, type AuthVerdict, type SortRule, type VipRule } from "../src/types";

const trusted = new Set(["mx.cloudflare.net"]);

describe("parseAuthenticationResults", () => {
  it("reads the authserv-id, methods and properties, ignoring comments", () => {
    const parsed = parseAuthenticationResults(
      'mx.cloudflare.net; dkim=pass (2048-bit key; unprotected) header.d=Example.com header.s=s1; ' +
        'spf=pass (mx.cloudflare.net: domain of bounce@mail.example.com designates 1.2.3.4) smtp.mailfrom="bounce@mail.example.com"; ' +
        "dmarc=pass (p=REJECT sp=REJECT) header.from=example.com",
    );
    expect(parsed?.authservId).toBe("mx.cloudflare.net");
    expect(parsed?.results).toEqual([
      { method: "dkim", result: "pass", props: { "header.d": "example.com", "header.s": "s1" } },
      { method: "spf", result: "pass", props: { "smtp.mailfrom": "bounce@mail.example.com" } },
      { method: "dmarc", result: "pass", props: { "header.from": "example.com" } },
    ]);
  });

  it("handles 'none' and junk", () => {
    expect(parseAuthenticationResults("mx.example.org 1; none")?.results).toEqual([]);
    expect(parseAuthenticationResults("")).toBeNull();
  });
});

describe("authVerdict", () => {
  it("passes on aligned DKIM, including a subdomain signer", () => {
    expect(authVerdict("mx.cloudflare.net; dkim=pass header.d=mail.example.com", trusted, "example.com")).toBe("pass");
  });

  it("passes on DMARC pass for the From domain", () => {
    expect(authVerdict("mx.cloudflare.net; dmarc=pass header.from=example.com", trusted, "example.com")).toBe("pass");
  });

  it("fails when only an unaligned domain passed (e.g. the forwarder's SPF)", () => {
    const value = "mx.cloudflare.net; spf=pass smtp.mailfrom=alex+caf_=x@gmail.example; dkim=fail header.d=example.com";
    expect(authVerdict(value, trusted, "example.com")).toBe("fail");
  });

  it("passes the header Email Routing actually added to a test message (2026-09-25)", () => {
    const captured =
      "mx.cloudflare.net;\tdkim=pass header.d=example.com header.s=cf-bounce header.b=fav/Uq46;\t" +
      "dkim=pass header.d=cloudflare-smtp.net header.s=cf2024-1 header.b=Ub+dGq5w;\t" +
      "dmarc=pass header.from=example.com policy.dmarc=reject;\t" +
      "spf=none (mx.cloudflare.net: no SPF records found for postmaster@bg-bag.cloudflare-smtp.net) smtp.helo=bg-bag.cloudflare-smtp.net;\t" +
      "spf=pass (mx.cloudflare.net: domain of bounces@cf-bounce.example.com designates 104.30.16.106 as permitted sender) smtp.mailfrom=bounces@cf-bounce.example.com;\t" +
      "arc=none smtp.remote-ip=104.30.16.106";
    expect(authVerdict(captured, trusted, "example.com")).toBe("pass");
    expect(authVerdict(captured, trusted, "bank.es")).toBe("fail");
  });

  it("ignores headers from receivers we don't trust", () => {
    expect(authVerdict("evil.example; dkim=pass header.d=example.com", trusted, "example.com")).toBe("none");
    expect(authVerdict(null, trusted, "example.com")).toBe("none");
  });
});

describe("domains", () => {
  it("finds organizational domains, including two-level suffixes", () => {
    expect(organizationalDomain("mail.example.co.uk")).toBe("example.co.uk");
    expect(organizationalDomain("a.b.example.com")).toBe("example.com");
    expect(aligned("news.example.co.uk", "example.co.uk")).toBe(true);
    expect(aligned("example.co.uk", "other.co.uk")).toBe(false);
  });

  it("extracts domains from addresses and rejects junk", () => {
    expect(domainOf("Alice@Example.COM")).toBe("example.com");
    expect(domainOf("@example.com")).toBe("example.com");
    expect(domainOf("not a domain")).toBeNull();
  });
});

describe("classify", () => {
  const vips: VipRule[] = [
    { id: 1, kind: "address", value: "mom@example.com", label: null, createdAt: 0 },
    { id: 2, kind: "domain", value: "bank.es", label: null, createdAt: 0 },
  ];
  const rules: SortRule[] = [
    { id: 10, kind: "domain", value: "payload.example", folder: "f1", createdAt: 0 },
    { id: 11, kind: "address", value: "boss@payload.example", folder: "inbox", createdAt: 0 },
    { id: 12, kind: "domain", value: "news.payload.example", folder: "f2", createdAt: 0 },
    { id: 13, kind: "alias", value: "shop@example.com", folder: "f3", createdAt: 0 },
    { id: 14, kind: "address", value: "spammer@bad.example", folder: "junk", createdAt: 0 },
  ];
  const msg = (fromAddress: string | null, auth: AuthVerdict = "pass", extra: Partial<Classifiable> = {}): Classifiable => ({
    fromAddress,
    alias: "alex@example.net",
    recipients: [],
    auth,
    upstreamSpam: false,
    ...extra,
  });

  it("sends verified VIPs to VIP", () => {
    expect(classify(msg("Mom@Example.com"), vips, rules, DEFAULT_SETTINGS)).toEqual({
      folder: "vip",
      vipRuleId: 1,
      sortRuleId: null,
    });
    expect(classify(msg("alerts@secure.bank.es"), vips, rules, DEFAULT_SETTINGS)).toMatchObject({ folder: "vip", vipRuleId: 2 });
  });

  it("sends everyone else to the Inbox", () => {
    expect(classify(msg("shop@store.com"), vips, rules, DEFAULT_SETTINGS)).toEqual({
      folder: "inbox",
      vipRuleId: null,
      sortRuleId: null,
    });
    expect(classify(msg("x@notbank.es"), vips, rules, DEFAULT_SETTINGS).folder).toBe("inbox");
  });

  it("sorts an unverified VIP like anyone else, unless auth is switched off", () => {
    expect(classify(msg("mom@example.com", "none"), vips, rules, DEFAULT_SETTINGS)).toEqual({
      folder: "inbox",
      vipRuleId: 1,
      sortRuleId: null,
    });
    expect(classify(msg("mom@example.com", "fail"), vips, rules, DEFAULT_SETTINGS).folder).toBe("inbox");
    expect(classify(msg("mom@example.com", "none"), vips, rules, { ...DEFAULT_SETTINGS, vipRequireAuth: false }).folder).toBe("vip");
  });

  it("files by rule: address beats the most specific domain, which beats the alias", () => {
    const folder = (from: string | null, alias = "alex@example.net") =>
      classify(msg(from, "pass", { alias }), vips, rules, DEFAULT_SETTINGS).folder;
    expect(folder("billing@payload.example")).toBe("f1");
    expect(folder("x@eu.payload.example")).toBe("f1");
    expect(folder("Boss@Payload.example")).toBe("inbox");
    expect(folder("weekly@news.payload.example")).toBe("f2");
    expect(folder("x@notpayload.example")).toBe("inbox");
    expect(folder("orders@shop.example", "shop@example.com")).toBe("f3");
    expect(folder("billing@payload.example", "shop@example.com")).toBe("f1");
    expect(folder(null, "shop@example.com")).toBe("f3");
    expect(classify(msg("billing@payload.example"), vips, rules, DEFAULT_SETTINGS).sortRuleId).toBe(10);
  });

  it("files by who mail was sent to: the address, then its +tag, then its domain; the sender still wins", () => {
    const sentTo: SortRule[] = [
      ...rules,
      { id: 20, kind: "alias", value: "claude@redirect.example", folder: "f4", createdAt: 0 },
      { id: 21, kind: "tag", value: "chatgpt", folder: "f5", createdAt: 0 },
      { id: 22, kind: "to_domain", value: "redirect.example", folder: "f6", createdAt: 0 },
      { id: 23, kind: "to_domain", value: "eu.redirect.example", folder: "f7", createdAt: 0 },
    ];
    const folder = (from: string, recipients: string[], alias = "alex@example.net") =>
      classify(msg(from, "pass", { alias, recipients }), vips, sentTo, DEFAULT_SETTINGS).folder;
    // Redirected mail: it arrived at the usual alias, only To says where it was sent.
    expect(folder("a@openai.example", ["Claude@Redirect.example"])).toBe("f4");
    expect(folder("a@openai.example", ["cursor@redirect.example"])).toBe("f6");
    expect(folder("a@openai.example", ["x@mail.eu.redirect.example"])).toBe("f7");
    expect(folder("a@openai.example", [], "alex+chatgpt@example.net")).toBe("f5");
    expect(folder("a@openai.example", ["someone@else.example", "alex+ChatGPT@example.com"])).toBe("f5");
    expect(folder("a@openai.example", ["alex+chatgpt-2@example.net"])).toBe("inbox");
    // A tag beats the domain it's at; the exact address beats both.
    expect(folder("a@openai.example", ["me+chatgpt@redirect.example"])).toBe("f5");
    expect(folder("a@openai.example", ["me+chatgpt@redirect.example", "claude@redirect.example"])).toBe("f4");
    // Who sent it wins over who it was sent to, so Report spam works on a tag.
    expect(folder("spammer@bad.example", [], "alex+chatgpt@example.net")).toBe("junk");
    expect(folder("billing@payload.example", ["claude@redirect.example"])).toBe("f1");
  });

  it("reads +tags", () => {
    expect(tagOf("alex+chatgpt@example.net")).toBe("chatgpt");
    expect(tagOf("Alex+A+B@x.example")).toBe("a+b");
    expect(tagOf("alex@example.net")).toBeNull();
    expect(tagOf("alex+@example.net")).toBeNull();
  });

  it("sends upstream spam and reported senders to Spam; a rule overrides the spam filter", () => {
    expect(classify(msg("x@store.com", "pass", { upstreamSpam: true }), vips, rules, DEFAULT_SETTINGS).folder).toBe("junk");
    expect(classify(msg("spammer@bad.example"), vips, rules, DEFAULT_SETTINGS).folder).toBe("junk");
    expect(classify(msg("boss@payload.example", "pass", { upstreamSpam: true }), vips, rules, DEFAULT_SETTINGS).folder).toBe("inbox");
    // A verified VIP is never Spam.
    expect(classify(msg("mom@example.com", "pass", { upstreamSpam: true }), vips, rules, DEFAULT_SETTINGS).folder).toBe("vip");
  });
});

describe("spamVerdict", () => {
  it("reads the short Yes (score/required) form and stock SpamAssassin's", () => {
    expect(spamVerdict("No (0.5/5.0)", null)).toEqual({ isSpam: false, score: 0.5 });
    expect(spamVerdict(" Yes (7.1/5.0)\r\n", null)).toEqual({ isSpam: true, score: 7.1 });
    expect(spamVerdict("No (-1.9/5.0)", null)).toEqual({ isSpam: false, score: -1.9 });
    expect(spamVerdict("Yes, score=12.3 required=5.0 tests=BAYES_99,URIBL_BLACK\n\tautolearn=no version=3.4.6", null)).toEqual({
      isSpam: true,
      score: 12.3,
    });
  });

  it("falls back to X-Spam-Flag, and returns null when no filter ran", () => {
    expect(spamVerdict(null, "YES")).toEqual({ isSpam: true, score: null });
    expect(spamVerdict(null, null)).toBeNull();
    expect(spamVerdict("garbage", null)).toBeNull();
  });
});

describe("text", () => {
  it("turns HTML into searchable text", () => {
    const html = "<html><head><style>p{color:red}</style></head><body><p>Tom &amp; Jerry&#39;s</p><script>x()</script>next<br>line</body></html>";
    expect(htmlToText(html)).toBe("Tom & Jerry's\nnext\nline");
  });

  it("builds safe FTS queries", () => {
    expect(toFtsQuery('invoice "march" OR NEAR(')).toBe('"invoice"* "march"* "OR"* "NEAR("*');
    expect(toFtsQuery("   ")).toBeNull();
  });

  it("matches a word ending in one letter or digit whole, not as a prefix", () => {
    expect(toFtsQuery("a")).toBe('"a"');
    expect(toFtsQuery("é 7 ab")).toBe('"é" "7" "ab"*');
    expect(toFtsQuery("a. x-y")).toBe('"a." "x-y"');
    expect(toFtsQuery("x-yz")).toBe('"x-yz"*');
  });

  it("highlights matches the way the index matches them", () => {
    expect(highlight("Your Invoice for March", ["inv", "march"])).toBe("Your \u0002Invoice\u0003 for \u0002March\u0003");
    expect(highlight("Café crème", ["cafe", "CREME"])).toBe("\u0002Café\u0003 \u0002crème\u0003");
    // One letter is a whole word, as in toFtsQuery.
    expect(highlight("a cat ate", ["a"])).toBe("\u0002a\u0003 cat ate");
    expect(highlight("Nothing here", ["invoice"])).toBeNull();
    expect(highlight("Anything", [])).toBeNull();
  });

  it("cuts a passage around the matches", () => {
    const words = Array.from({ length: 100 }, (_, i) => `w${i}`);
    const text = words.join(" ");
    const found = snippet(text, ["w50"], 5)!;
    expect(found).toBe("…w48 w49 \u0002w50\u0003 w51 w52…");
    // The window with the most distinct terms wins over an earlier lone hit.
    expect(snippet(`${text} invoice march`, ["invoice", "march"], 4)).toBe("…w98 w99 \u0002invoice\u0003 \u0002march\u0003");
    expect(snippet("short invoice text", ["invoice"], 24)).toBe("short \u0002invoice\u0003 text");
    expect(snippet("short invoice text", ["invoice"], 24, true)).toBe("short \u0002invoice\u0003 text…");
    expect(snippet(text, ["nope"])).toBeNull();
  });

  it("finds a passage in a long body without re-running the index", () => {
    const body = `${"lorem ipsum dolor ".repeat(3000)}apple banana ${"sit amet ".repeat(3000)}`;
    const started = performance.now();
    for (let i = 0; i < 200; i++) snippet(body, ["a"]);
    expect(snippet(body, ["ban"])).toContain("\u0002banana\u0003");
    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("makes short previews", () => {
    expect(makePreview("a\n\n  b", 10)).toBe("a b");
    expect(makePreview("x".repeat(20), 10)).toBe(`${"x".repeat(9)}…`);
  });
});

describe("ids", () => {
  it("sort by time and round-trip through R2 keys", () => {
    const a = newId(1_700_000_000_000);
    const b = newId(1_700_000_000_001);
    expect(a < b).toBe(true);
    expect(idTime(a)).toBe(1_700_000_000_000);
    expect(idFromRawKey(rawKey(a))).toBe(a);
    expect(idFromRawKey("raw/nope.eml")).toBeNull();
  });
});
