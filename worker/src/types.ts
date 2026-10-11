/**
 * A mailbox id: one of the built-in "vip", "inbox", "sent", "junk" (Spam),
 * "archive" and "trash", or a folder the user created ("f1", "f2", ...).
 */
export type Folder = string;

/** Whether the From domain was authenticated by a receiver we trust. */
export type AuthVerdict = "pass" | "fail" | "none";

export type AliasMode = "open" | "locked";

export interface Settings {
  /** open: any address at the domain is accepted and becomes an alias on first use. locked: unknown addresses are rejected. */
  aliasMode: AliasMode;
  /** Only treat a VIP match as VIP when the From domain is authenticated (see auth-results.ts). */
  vipRequireAuth: boolean;
  /** Delete the raw message and attachments after this many days (headers, text and search stay). null keeps them forever. */
  attachmentRetentionDays: number | null;
}

export const DEFAULT_SETTINGS: Settings = {
  aliasMode: "open",
  vipRequireAuth: true,
  attachmentRetentionDays: null,
};

/** Queue payload: everything needed to index a raw message already stored in R2. */
export interface IngestJob {
  id: string;
  receivedAt: number;
  envelopeFrom: string;
  envelopeTo: string;
  size: number;
  /** IMAP source name (see imap/config.ts); absent for mail from Email Routing. */
  source?: string;
  /** Imported history: index it, never notify. */
  quiet?: boolean;
  /** The account's own sent mail (its IMAP Sent folder): filed into Sent, already read. */
  sent?: boolean;
}

export interface AddressEntry {
  name: string;
  address: string;
}

export interface AttachmentMeta {
  idx: number;
  filename: string | null;
  mimeType: string;
  size: number;
  disposition: string | null;
  contentId: string | null;
}

/** A parsed message, ready to be indexed by the Mailbox. Blobs are already in R2. */
export interface IngestRecord {
  id: string;
  receivedAt: number;
  envelopeFrom: string;
  alias: string;
  size: number;
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  subject: string;
  from: AddressEntry | null;
  to: AddressEntry[];
  cc: AddressEntry[];
  replyTo: AddressEntry[];
  sentAt: number | null;
  text: string;
  preview: string;
  hasHtml: boolean;
  attachments: AttachmentMeta[];
  auth: AuthVerdict;
  authResults: string | null;
  /** The receiving server's spam filter verdict (X-Spam-Status / X-Spam-Flag), when there is one. */
  spam: SpamVerdict | null;
  listId: string | null;
  listUnsubscribe: string | null;
  parseError: string | null;
  /** The account's own sent mail: goes to Sent, read, and no rule or VIP check applies. */
  sent?: boolean;
}

export interface SpamVerdict {
  isSpam: boolean;
  score: number | null;
}

export type IngestResult =
  | { status: "stored"; folder: Folder; notify: boolean; auth: AuthVerdict }
  | { status: "duplicate" }
  | { status: "dropped"; reason: "alias-blocked" | "deleted" };

export type VipRuleKind = "address" | "domain";

export interface VipRule {
  id: number;
  kind: VipRuleKind;
  value: string;
  label: string | null;
  createdAt: number;
}

/**
 * What a sorting rule matches. Sender: the From address, or the From domain (and its subdomains).
 * Recipient (the address mail arrived at, or any To/Cc address, so redirected mail sorts by the
 * address it was sent to): one address ("alias"), a +tag on any address ("tag", stored without
 * the "+"), or any address at a domain and its subdomains ("to_domain").
 */
export type SortRuleKind = "address" | "domain" | "alias" | "tag" | "to_domain";

/** "Mail matching this always goes to that folder." The user's own filing, and their spam/not-spam lists. */
export interface SortRule {
  id: number;
  kind: SortRuleKind;
  value: string;
  folder: Folder;
  createdAt: number;
}

/** A rule as a client asks for it, before it exists. */
export interface RuleDraft<K extends string = SortRuleKind> {
  kind: K;
  value: string;
}

/** A rule of a batch that couldn't be added, and why. */
export interface RuleFailure {
  kind: string;
  value: string;
  error: string;
}

/**
 * Mail a new rule or VIP matches that it left where it was, by why. Rules only move mail they
 * filed themselves, and a VIP or a more specific rule beats them; without this a client could only
 * say "now goes to X" while the mail on screen stays put. (Mail in Sent and Trash isn't counted.)
 */
export interface StayedPut {
  /** Filed by the user by hand. */
  byHand: number;
  /** In VIP: a VIP sender beats any rule. */
  vip: number;
  /** VIP only: claims to be from the VIP but couldn't be verified (vipRequireAuth). */
  unverified: number;
  /** Filed by another rule that wins over this one (a sender's address beats its domain, a sender beats a recipient). */
  otherRules: { rule: SortRule; count: number }[];
}

/**
 * An Inbox category: the four built-in ones (Primary, Transactions, Updates, Promotions) or one of
 * the user's own ("c1", "c2", ...). Every message received gets one: a quick guess from its
 * headers at once, then the classifier's answer when it is reachable (see categories.ts).
 */
export interface CategoryInfo {
  id: string;
  name: string;
  /** What belongs here, in plain words: this is what the classifier reads. */
  description: string;
  /** A name from CATEGORY_COLORS; the clients pick the shades. */
  color: string;
  builtin: boolean;
  /** Mail in the Inbox view (the Inbox and the folders shown in it) in this category, and how much is unread. */
  total: number;
  unread: number;
}

/** Who gave a message its category: the quick guess, the classifier, or the user's "categorize sender". */
export type CategorySource = "guess" | "model" | "sender";

/** "Mail from this address always goes in that category" (the user's correction). */
export interface CategorySender {
  address: string;
  category: string;
  createdAt: number;
}

/** How the classifier is doing, for the clients' settings. */
export interface ClassifierStatus {
  /** A classifier is set up (classifier.ts). Without one every message keeps its quick guess. */
  configured: boolean;
  model: string | null;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
  /** New Inbox-view mail (the last 24 hours) it has yet to look at; it shows under its quick guess meanwhile. */
  pending: number;
  /** Older Inbox-view mail still on its quick guess, which it works through newest first: with an allowance, from `budget.backlogFrom` to the reset. */
  backlog: number;
  /** Input tokens it has been asked about today (UTC). */
  usedTokens: number;
  /** Its daily allowance, when it has one (Clef on Workers AI: the free neurons). */
  budget: {
    dailyTokens: number;
    /** 00:00 UTC, when the allowance starts again. */
    resetsAt: number;
    /** When today's backlog hour starts (UTC). */
    backlogFrom: number;
  } | null;
}

/** A folder as /api/folders shows it. */
export interface FolderInfo {
  id: Folder;
  name: string;
  role: string | null;
  /** Clients list this folder's mail in their Inbox view too (each message stays in one mailbox). */
  showInInbox: boolean;
}

export interface AliasInfo {
  address: string;
  label: string | null;
  status: "active" | "blocked";
  createdAt: number;
  firstSeenAt: number | null;
  lastSeenAt: number | null;
  messageCount: number;
}

export interface MessageSummary {
  id: string;
  receivedAt: number;
  sentAt: number | null;
  folder: Folder;
  seen: boolean;
  flagged: boolean;
  alias: string;
  from: AddressEntry | null;
  subject: string;
  preview: string;
  size: number;
  attachmentCount: number;
  /** A VIP rule matched the From address (even if auth failed and it didn't go to VIP). */
  vip: boolean;
  auth: AuthVerdict;
}

export interface MessageDetail extends MessageSummary {
  envelopeFrom: string;
  to: AddressEntry[];
  cc: AddressEntry[];
  replyTo: AddressEntry[];
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  text: string;
  hasHtml: boolean;
  attachments: AttachmentMeta[];
  blobsExpired: boolean;
  authResults: string | null;
  listId: string | null;
  listUnsubscribe: string | null;
  parseError: string | null;
}

export interface ListQuery {
  folder?: Folder;
  alias?: string;
  /** Free-text search over subject, sender, recipients, body and attachment names. */
  text?: string;
  limit?: number;
  /** Cursor: return messages older than this one. */
  before?: string;
}
