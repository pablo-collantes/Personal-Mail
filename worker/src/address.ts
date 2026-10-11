export function normalizeAddress(address: string): string {
  return address.trim().replace(/^<|>$/g, "").toLowerCase();
}

/** Domain part of an address (`a@b.com` → `b.com`); a bare domain is returned as-is. */
export function domainOf(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase().replace(/\.$/, "");
  const at = v.lastIndexOf("@");
  const domain = at >= 0 ? v.slice(at + 1) : v;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}

// Common second-level public suffixes (co.uk, com.es, gob.es, ...). A cheap
// stand-in for the Public Suffix List: good enough to gate notifications, not
// to enforce DMARC policy.
const SECOND_LEVEL_SUFFIXES = new Set(["ac", "co", "com", "edu", "gob", "gov", "net", "nom", "org"]);

export function organizationalDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".");
  const tld = labels.at(-1) ?? "";
  const sld = labels.at(-2) ?? "";
  const take = tld.length === 2 && SECOND_LEVEL_SUFFIXES.has(sld) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** DMARC relaxed alignment: both domains share an organizational domain. */
export function aligned(a: string, b: string): boolean {
  return organizationalDomain(a) === organizationalDomain(b);
}
