import { aligned, domainOf } from "./address";
import type { AuthVerdict } from "./types";

// Authentication-Results (RFC 8601) parsing, and the verdict used to decide
// whether a VIP's From address can be trusted.
//
// Only the topmost Authentication-Results header counts, and only when its
// authserv-id is one we trust. The receiving MTA prepends its own header, so
// anything below it came from the sender and may be forged.

export interface AuthMethodResult {
  method: string;
  result: string;
  props: Record<string, string>;
}

export interface AuthenticationResults {
  authservId: string;
  results: AuthMethodResult[];
}

export function parseAuthenticationResults(value: string): AuthenticationResults | null {
  const parts = split(stripComments(value), (ch) => ch === ";")
    .map((p) => p.trim())
    .filter(Boolean);
  const authservId = parts[0]?.split(/\s+/)[0]?.toLowerCase();
  if (!authservId) return null;

  const results: AuthMethodResult[] = [];
  for (const part of parts.slice(1)) {
    const [first = "", ...rest] = split(part, (ch) => /\s/.test(ch)).filter(Boolean);
    const m = /^([a-z0-9_-]+)(?:\/\d+)?=([a-z0-9_-]+)$/i.exec(first);
    if (!m) continue;
    const props: Record<string, string> = {};
    for (const token of rest) {
      const eq = token.indexOf("=");
      if (eq > 0) props[token.slice(0, eq).toLowerCase()] = unquote(token.slice(eq + 1)).toLowerCase();
    }
    results.push({ method: m[1]!.toLowerCase(), result: m[2]!.toLowerCase(), props });
  }
  return { authservId, results };
}

/**
 * "pass" when a trusted receiver saw DMARC, DKIM or SPF pass for a domain
 * aligned with the From domain; "fail" when it checked and nothing aligned
 * passed; "none" when there is no trusted result to go on.
 */
export function authVerdict(
  topmostAuthResults: string | null,
  trustedAuthservIds: ReadonlySet<string>,
  fromDomain: string | null,
): AuthVerdict {
  const parsed = topmostAuthResults ? parseAuthenticationResults(topmostAuthResults) : null;
  if (!parsed || !trustedAuthservIds.has(parsed.authservId)) return "none";
  if (!fromDomain) return "fail";

  for (const r of parsed.results) {
    if (r.result !== "pass") continue;
    const domain =
      r.method === "dmarc"
        ? domainOf(r.props["header.from"])
        : r.method === "dkim"
          ? domainOf(r.props["header.d"] ?? r.props["header.i"])
          : r.method === "spf"
            ? domainOf(r.props["smtp.mailfrom"])
            : null;
    if (domain && aligned(fromDomain, domain)) return "pass";
  }
  return "fail";
}

export function parseTrustedIds(value: string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Removes RFC 5322 comments `( ... )`, which may nest and may contain `;`. */
function stripComments(input: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (ch === "\\" && i + 1 < input.length) {
      if (depth === 0) out += ch + input[i + 1];
      i++;
    } else if (depth === 0 && ch === '"') {
      quoted = !quoted;
      out += ch;
    } else if (!quoted && ch === "(") {
      depth++;
    } else if (!quoted && ch === ")" && depth > 0) {
      depth--;
      if (depth === 0) out += " ";
    } else if (depth === 0) {
      out += ch;
    }
  }
  return out;
}

function split(input: string, isSeparator: (ch: string) => boolean): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted && ch === "\\" && i + 1 < input.length) {
      current += ch + input[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (!quoted && isSeparator(ch)) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1).replace(/\\(.)/g, "$1")
    : value;
}
