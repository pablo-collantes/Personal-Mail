/**
 * Cloudflare Access sits in front of the whole hostname. The Worker still
 * checks the JWT Access attaches to every request it lets through, so a
 * misconfigured Access app (or a route that bypasses it) can't expose mail.
 *
 * https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
 */

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

const CERTS_TTL_MS = 60 * 60 * 1000;
const CLOCK_SKEW_S = 60;

export interface AccessConfig {
  /** `<team>.cloudflareaccess.com` */
  teamDomain: string;
  /** The Access application's AUD tag. */
  audience: string;
  /** People allowed in, by the email their identity provider reports. */
  emails: ReadonlySet<string>;
  /** Service tokens allowed in (the phone app), by client id. */
  serviceTokens: ReadonlySet<string>;
}

export type Caller = { kind: "user"; email: string } | { kind: "service"; clientId: string };

export class AccessDenied extends Error {}

/** null when Access isn't configured yet: the API then refuses everything. */
export function accessConfig(env: Env): AccessConfig | null {
  const teamDomain = env.ACCESS_TEAM_DOMAIN.trim();
  const audience = env.ACCESS_AUD.trim();
  if (!teamDomain || !audience) return null;
  return {
    teamDomain,
    audience,
    emails: commaSet(env.ACCESS_ALLOWED_EMAILS, (s) => s.toLowerCase()),
    serviceTokens: commaSet(env.ACCESS_SERVICE_TOKENS, (s) => s),
  };
}

function commaSet(value: string, normalize: (s: string) => string): Set<string> {
  return new Set(
    value
      .split(",")
      .map((s) => normalize(s.trim()))
      .filter(Boolean),
  );
}

type Jwk = JsonWebKey & { kid?: string };
type Certs = { keys: Map<string, CryptoKey>; fetchedAt: number };
const certsCache = new Map<string, Certs>();

async function signingKey(teamDomain: string, kid: string, fetcher: typeof fetch): Promise<CryptoKey | null> {
  const cached = certsCache.get(teamDomain);
  if (cached && Date.now() - cached.fetchedAt < CERTS_TTL_MS && cached.keys.has(kid)) return cached.keys.get(kid)!;
  // Unknown kid: Access may have rotated its keys, so fetch again (but not more than once a minute).
  if (cached && Date.now() - cached.fetchedAt < 60_000) return cached.keys.get(kid) ?? null;
  const res = await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
    );
  }
  certsCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys.get(kid) ?? null;
}

function base64UrlDecode(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function decodePart(s: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(base64UrlDecode(s))) as Record<string, unknown>;
}

/** Verifies the Access JWT on a request and returns who sent it. Throws AccessDenied. */
export async function verifyAccess(
  request: Request,
  config: AccessConfig,
  { fetcher = fetch, now = Date.now() }: { fetcher?: typeof fetch; now?: number } = {},
): Promise<Caller> {
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (!token) throw new AccessDenied("no Access token");
  const parts = token.split(".");
  if (parts.length !== 3) throw new AccessDenied("malformed token");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodePart(headerPart);
    payload = decodePart(payloadPart);
  } catch {
    throw new AccessDenied("malformed token");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AccessDenied("unexpected algorithm");

  const key = await signingKey(config.teamDomain, header.kid, fetcher);
  if (!key) throw new AccessDenied("unknown signing key");
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64UrlDecode(signaturePart), signed);
  if (!valid) throw new AccessDenied("bad signature");

  const seconds = now / 1000;
  if (payload.iss !== `https://${config.teamDomain}`) throw new AccessDenied("wrong issuer");
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(config.audience)) throw new AccessDenied("wrong audience");
  if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < seconds) throw new AccessDenied("expired");
  if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_S > seconds) throw new AccessDenied("not yet valid");

  // Service tokens carry common_name (the client id) and no email.
  if (typeof payload.email === "string" && payload.email) {
    const email = payload.email.toLowerCase();
    if (config.emails.has(email)) return { kind: "user", email };
    throw new AccessDenied("email not allowed");
  }
  if (typeof payload.common_name === "string" && config.serviceTokens.has(payload.common_name)) {
    return { kind: "service", clientId: payload.common_name };
  }
  throw new AccessDenied("identity not allowed");
}

/** Test hook: forget cached signing keys. */
export function clearAccessCache(): void {
  certsCache.clear();
}
