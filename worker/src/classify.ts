import { domainOf } from "./address";
import type { AuthVerdict, Folder, Settings, SortRule, VipRule } from "./types";

export function findVipRule(fromAddress: string | null, rules: readonly VipRule[]): VipRule | null {
  if (!fromAddress) return null;
  const address = fromAddress.toLowerCase();
  const domain = domainOf(address);
  return (
    rules.find((rule) =>
      rule.kind === "address"
        ? rule.value === address
        : domain !== null && (domain === rule.value || domain.endsWith(`.${rule.value}`)),
    ) ?? null
  );
}

/** The +tag of an address's local part (`me+chatgpt@x` → `chatgpt`), or null. */
export function tagOf(address: string): string | null {
  const at = address.lastIndexOf("@");
  const local = at >= 0 ? address.slice(0, at) : address;
  const plus = local.indexOf("+");
  return plus >= 0 && plus < local.length - 1 ? local.slice(plus + 1).toLowerCase() : null;
}

/** `domain` is `rule` or one of its subdomains. */
function underDomain(domain: string | null, rule: string): boolean {
  return domain !== null && (domain === rule || domain.endsWith(`.${rule}`));
}

/** Of the rules of one kind whose domain covers one of `domains`, the most specific. */
function longestDomainRule(rules: readonly SortRule[], kind: "domain" | "to_domain", domains: readonly (string | null)[]) {
  return rules
    .filter((r) => r.kind === kind && domains.some((d) => underDomain(d, r.value)))
    .sort((a, b) => b.value.length - a.value.length)[0];
}

/**
 * The sorting rule for a message. Who sent it beats who it was sent to, so
 * "Report spam" (an address rule) still works on mail to a +tag; within each,
 * the more specific wins: From address, From domain (the most specific
 * domain), then the address it was sent to, its +tag, and its domain.
 * `recipients` are the address it arrived at plus its To and Cc addresses.
 */
export function findSortRule(
  fromAddress: string | null,
  recipients: readonly string[],
  rules: readonly SortRule[],
): SortRule | null {
  const address = fromAddress?.toLowerCase() ?? null;
  const byAddress = address ? rules.find((r) => r.kind === "address" && r.value === address) : undefined;
  if (byAddress) return byAddress;
  const byDomain = address ? longestDomainRule(rules, "domain", [domainOf(address)]) : undefined;
  if (byDomain) return byDomain;
  const to = [...new Set(recipients.map((r) => r.trim().toLowerCase()).filter(Boolean))];
  const byRecipient = rules.find((r) => r.kind === "alias" && to.includes(r.value));
  if (byRecipient) return byRecipient;
  const tags = to.map(tagOf).filter((t): t is string => t !== null);
  const byTag = rules.find((r) => r.kind === "tag" && tags.includes(r.value));
  if (byTag) return byTag;
  return longestDomainRule(rules, "to_domain", to.map(domainOf)) ?? null;
}

/** What classify needs to know about a message. */
export interface Classifiable {
  fromAddress: string | null;
  alias: string;
  /** To and Cc addresses. */
  recipients: readonly string[];
  auth: AuthVerdict;
  /** The receiving server's spam filter said spam. */
  upstreamSpam: boolean;
}

export interface Classification {
  folder: Folder;
  vipRuleId: number | null;
  sortRuleId: number | null;
}

/**
 * Where a new message goes, first match wins:
 * 1. a verified VIP sender → VIP;
 * 2. the user's sorting rules → their folder (this is also the spam / not-spam list);
 * 3. the receiving server's spam filter said spam → Spam;
 * 4. everything else → Inbox.
 * (What notifies is the clients' call: the Inbox and the folders shown in it.)
 */
export function classify(
  message: Classifiable,
  vips: readonly VipRule[],
  rules: readonly SortRule[],
  settings: Settings,
): Classification {
  const vip = findVipRule(message.fromAddress, vips);
  // Claims to be a VIP but we couldn't verify it: sorted like anyone else.
  if (vip && (!settings.vipRequireAuth || message.auth === "pass")) {
    return { folder: "vip", vipRuleId: vip.id, sortRuleId: null };
  }
  const vipRuleId = vip?.id ?? null;
  const rule = findSortRule(message.fromAddress, [message.alias, ...message.recipients], rules);
  if (rule) return { folder: rule.folder, vipRuleId, sortRuleId: rule.id };
  if (message.upstreamSpam) return { folder: "junk", vipRuleId, sortRuleId: null };
  return { folder: "inbox", vipRuleId, sortRuleId: null };
}
