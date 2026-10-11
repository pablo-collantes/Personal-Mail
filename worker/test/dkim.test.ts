import { describe, expect, it } from "vitest";
import { type DkimCheck, SIGNATURE_MISMATCH, type TxtResolver, dkimVerdict, formatDkimResults, joinTxtStrings, verifyDkim } from "../src/dkim";
import { dkimKeys, dkimMessages } from "./fixtures/dkim";

const NOW = Date.parse("2026-09-30T12:00:00Z");
const enc = new TextEncoder();

function resolver(keys: Record<string, string> = dkimKeys): TxtResolver {
  return async (name) => (keys[name] === undefined ? null : [keys[name]!]);
}

function check(message: string, keys?: Record<string, string> | TxtResolver): Promise<DkimCheck> {
  const resolveTxt = typeof keys === "function" ? keys : resolver(keys);
  return verifyDkim(enc.encode(message), { resolveTxt, now: NOW });
}

async function statuses(message: string, keys?: Record<string, string> | TxtResolver) {
  return (await check(message, keys)).signatures.map((s) => [s.status, s.reason]);
}

/** Swaps the first occurrence of `from` in the body (after the blank line). */
function editBody(message: string, from: string, to: string): string {
  const split = message.indexOf("\r\n\r\n");
  return message.slice(0, split) + message.slice(split).replace(from, to);
}

describe("dkim verification", () => {
  it.each([
    "relaxed",
    "simple",
    "relaxedSimple",
    "emptyBodyRelaxed",
    "emptyBodySimple",
    "lengthLimited",
    "pkcs1Key",
    "ed25519",
  ] as const)("verifies the %s message signed by dkimpy", async (name) => {
    const result = await check(dkimMessages[name]);
    expect(result.signatures.map((s) => [s.status, s.reason])).toEqual([["pass", null]]);
    expect(dkimVerdict(result, "example.org", false)).toBe("pass");
  });

  it("verifies RFC 8463's example (an Ed25519 and an RSA signature)", async () => {
    const result = await check(dkimMessages.rfc8463);
    expect(result.signatures.map((s) => [s.algorithm, s.status])).toEqual([
      ["ed25519-sha256", "pass"],
      ["rsa-sha256", "pass"],
    ]);
  });

  it("accepts bare LF line endings", async () => {
    for (const name of ["relaxed", "simple"] as const) {
      expect(await statuses(dkimMessages[name].replace(/\r\n/g, "\n"))).toEqual([["pass", null]]);
    }
  });

  it("fails a changed body, even on old mail", async () => {
    const result = await check(editBody(dkimMessages.relaxed, "domingo", "lunes"));
    expect(result.signatures.map((s) => [s.status, s.reason])).toEqual([["fail", "body hash did not verify"]]);
    expect(dkimVerdict(result, "example.org", false)).toBe("fail");
    expect(dkimVerdict(result, "example.org", true)).toBe("fail");
  });

  it("fails a changed header, unless the mail is old enough for the key to have changed", async () => {
    for (const name of ["relaxed", "simple"] as const) {
      const result = await check(dkimMessages[name].replace("Ana Rivera", "Ana Riviera"));
      expect(result.signatures.map((s) => [s.status, s.reason])).toEqual([["fail", SIGNATURE_MISMATCH]]);
      expect(dkimVerdict(result, "example.org", false)).toBe("fail");
      expect(dkimVerdict(result, "example.org", true)).toBe("none");
    }
  });

  it("treats a second From field as a forgery", async () => {
    const result = await check(`From: Ana <ana@example.org>\r\n${dkimMessages.relaxed}`);
    expect(dkimVerdict(result, "example.org", false)).toBe("fail");
    expect(formatDkimResults(result)).toContain("x-from-fields=2");
  });

  it("only counts signatures from the From domain's organization", async () => {
    const result = await check(dkimMessages.relaxed);
    expect(dkimVerdict(result, "mail.example.org", false)).toBe("pass");
    expect(dkimVerdict(result, "example.com", false)).toBe("none");
    expect(dkimVerdict(result, null, false)).toBe("none");
  });

  it("doesn't pass a signature that leaves part of the body unsigned", async () => {
    const appended = `${dkimMessages.lengthLimited.replace(/(\r\n)+$/, "")}\r\nP.S. Click here.\r\n`;
    const result = await check(appended);
    expect(result.signatures.map((s) => [s.status, s.reason])).toEqual([["neutral", "l= doesn't cover the whole body"]]);
    expect(dkimVerdict(result, "example.org", false)).toBe("none");
  });

  it("refuses rsa-sha1 and expired signatures", async () => {
    expect(await statuses(dkimMessages.sha1)).toEqual([["neutral", "rsa-sha1 is no longer accepted"]]);
    const expired = dkimMessages.relaxed.replace("DKIM-Signature: v=1;", `DKIM-Signature: v=1; x=${NOW / 1000 - 60};`);
    expect(await statuses(expired)).toEqual([["neutral", "signature expired"]]);
  });

  it("reports missing, revoked, testing and unreachable keys without passing", async () => {
    const name = "rsa._domainkey.example.org";
    const key = dkimKeys[name]!;
    const cases: [Record<string, string> | TxtResolver, [string, string]][] = [
      [{}, ["permerror", "no key published"]],
      [{ [name]: "v=DKIM1; k=rsa; p=" }, ["permerror", "key revoked"]],
      [{ [name]: key.replace("k=rsa", "k=ed25519") }, ["permerror", "key type doesn't match"]],
      [{ [name]: `${key}; t=y` }, ["neutral", "key is in testing mode"]],
      [{ [name]: `${key}; h=sha1` }, ["permerror", "key doesn't allow sha256"]],
      [() => Promise.reject(new Error("SERVFAIL")), ["temperror", "key lookup failed"]],
    ];
    for (const [keys, expected] of cases) {
      const result = await check(dkimMessages.relaxed, keys);
      expect(result.signatures.map((s) => [s.status, s.reason])).toEqual([expected]);
      expect(dkimVerdict(result, "example.org", false)).toBe("none");
    }
  });

  it("rejects signatures that don't sign From, or whose i= is outside d=", async () => {
    const sig = dkimMessages.relaxed;
    expect(await statuses(sig.replace("h=from : to :", "h=to :"))).toEqual([
      ["permerror", "From is not signed"],
    ]);
    expect(await statuses(sig.replace("i=@example.org", "i=@example.com"))).toEqual([["permerror", "i= is outside d="]]);
  });

  it("formats the results as an Authentication-Results value", async () => {
    expect(formatDkimResults(await check(dkimMessages.relaxed))).toBe(
      "personal-mail; dkim=pass header.d=example.org header.s=rsa header.a=rsa-sha256",
    );
    const unsigned = await check("From: a@example.org\r\nSubject: hi\r\n\r\nhello\r\n");
    expect(unsigned.signatures).toEqual([]);
    expect(formatDkimResults(unsigned)).toBe("personal-mail; dkim=none");
    expect(dkimVerdict(unsigned, "example.org", false)).toBe("none");
  });

  it("joins the strings of a TXT record", () => {
    expect(joinTxtStrings('"v=DKIM1; k=rsa; " "p=ab\\"c\\059"')).toBe('v=DKIM1; k=rsa; p=ab"c;');
    expect(joinTxtStrings("v=DKIM1; p=abc")).toBe("v=DKIM1; p=abc");
  });
});
