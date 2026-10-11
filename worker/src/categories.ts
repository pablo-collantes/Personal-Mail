// Inbox categories, as Apple Mail sorts its Inbox: Primary, Transactions, Updates and Promotions,
// plus the user's own, each described in plain words.
//
// A message gets its category in two steps. At once, a quick guess from its headers and subject
// (guessCategory), so a new message never waits. Then, when a classifier is reachable, its answer:
// one SystemOne `choice` question whose options are the categories' descriptions, which Clef on
// Workers AI, Clef-Flash and Jev all answer in the same shape (see classifier.ts). A user's own category is
// nothing but another option with their description, so the classifier sorts into it unchanged.

/** The built-in categories, in the order the clients show them after "All". */
export const BUILTIN_CATEGORIES = [
  {
    id: "primary",
    name: "Primary",
    color: "blue",
    description:
      "Personal mail written by a person to me, mail from my VIP senders, and urgent or time-sensitive items: " +
      "flight changes, security alerts, sign-in codes, appointments, anything that needs action soon.",
  },
  {
    id: "transactions",
    name: "Transactions",
    color: "green",
    description:
      "Receipts, order confirmations, shipping and delivery notices, invoices, bills, statements, " +
      "payment and refund confirmations, bookings and reservations.",
  },
  {
    id: "updates",
    name: "Updates",
    color: "purple",
    description:
      "Newsletters, news roundups and digests, social media notifications, and product, account or community updates.",
  },
  {
    id: "promotions",
    name: "Promotions",
    color: "pink",
    description: "Sales, coupons, deals, discounts, marketing campaigns and advertisements.",
  },
] as const;

export type BuiltinCategoryId = (typeof BUILTIN_CATEGORIES)[number]["id"];

/** The colors a category can have, by name; the clients pick the shades. New ones take the first unused. */
export const CATEGORY_COLORS = ["blue", "green", "purple", "pink", "orange", "teal", "amber", "red", "indigo", "cyan"] as const;

/** The user's own categories, at most. Each is another option the classifier weighs, and another button. */
export const MAX_CUSTOM_CATEGORIES = 8;
export const MAX_CATEGORY_NAME = 40;
export const MAX_CATEGORY_DESCRIPTION = 500;

/** What the quick guess reads: headers, subject and preview only. */
export interface Guessable {
  fromAddress: string | null;
  subject: string;
  preview: string;
  listId: string | null;
  listUnsubscribe: string | null;
  /** From a VIP sender (whether or not it could be verified). */
  vip: boolean;
}

// The subject says it can't wait: Primary, whoever sent it (Apple's "time-sensitive").
const TIME_SENSITIVE =
  /\b(verification code|security (code|alert)|sign[- ]?in (code|attempt|alert)|new sign[- ]?in|log[- ]?in (code|attempt|alert)|password reset|reset your password|one[- ]time (code|pass(word|code))|two[- ]factor|2fa|passcode|flight (change|delay|cancel\w*)|gate change|schedule change|check[- ]in (is )?(now )?open|appointment|action required|payment failed|past due|overdue|suspicious)\b/i;
// The subject is about money changing hands or something bought.
const TRANSACTION =
  /\b(receipt|invoice|your order|order (confirm\w*|#|number|no\b|(has )?(been )?(shipped|delivered|placed|received))|has shipped|shipment|shipping (confirm\w*|update|notification)|out for delivery|(was|been|is) delivered|tracking (number|info)|payment (received|confirm\w*|successful|processed)|you paid|you sent|refund\w*|purchase|booking (confirm\w*|reference)|reservation (confirm\w*|is confirmed)|your (trip|booking|reservation|itinerary)|e-?ticket|statement (is )?(ready|available)|bill (is )?(ready|available)|subscription (renew\w*|confirm\w*)|renewal (confirm\w*|notice)|transaction|donation)\b/i;
const PROMOTION =
  /(\d+\s?% off|% off\b|\bsale\b|\bdeals?\b|coupon|promo code|\bdiscount|free shipping|limited[- ]time|\boffers?\b|\bsave (up to |\$|\d)|black friday|cyber monday|clearance|last chance|ends (tonight|today|soon|sunday|midnight)|\bexclusive\b|new arrivals|shop (now|the)|\bbogo\b|flash sale|members?[- ]only|special (offer|price))/i;
const TRANSACTIONAL_SENDER =
  /^(receipts?|orders?|order-updates?|billing|invoices?|payments?|auto-confirm|shipment-tracking|shipping|confirm(ation)?s?|bookings?|reservations?|tickets?)([-+._][^@]*)?@/i;
const BULK_SENDER =
  /^(no-?reply|do-?not-?reply|donotreply|notifications?|notify|news(letter)?s?|digest|updates?|mailer|marketing|promo(tions)?|offers|deals|hello|info|team|community|alerts?)([-+._][^@]*)?@/i;

/**
 * The quick guess, from what any mail client can see at once. Mail sent to a list (List-Id,
 * List-Unsubscribe) or from a no-reply-style address is bulk: Promotions when it reads like a sale,
 * Updates otherwise. Receipts and orders are Transactions; VIPs, anything urgent and everything
 * else (mail from people) is Primary. The classifier corrects it when it can.
 */
export function guessCategory(m: Guessable): BuiltinCategoryId {
  const address = m.fromAddress?.toLowerCase() ?? "";
  if (m.vip || TIME_SENSITIVE.test(m.subject)) return "primary";
  if (TRANSACTION.test(m.subject) || TRANSACTIONAL_SENDER.test(address)) return "transactions";
  const bulk = m.listId !== null || m.listUnsubscribe !== null || BULK_SENDER.test(address);
  if (!bulk) return "primary";
  return PROMOTION.test(`${m.subject}\n${m.preview}`) ? "promotions" : "updates";
}

// ---- The classifier's question ----

/** A category as the classifier is asked about it. */
export interface CategoryOption {
  id: string;
  name: string;
  description: string;
  builtin: boolean;
}

/** One message as the classifier sees it. */
export interface CategoryState {
  from: string | null;
  to: string;
  subject: string;
  /** The start of the plain-text body. */
  text: string;
  mailingList: boolean;
  unsubscribeLink: boolean;
  vipSender: boolean;
}

/**
 * Inbox mail received this recently is new: the classifier gets to it as it arrives. Older mail
 * still on its quick guess is the backlog, which a classifier with a daily allowance only works
 * through at the end of the UTC day, on what the day left over (category-store.ts, work).
 */
export const NEW_MAIL_MS = 24 * 3_600_000;

/** How much of the body the classifier reads: the start is what says what a message is. */
export const STATE_TEXT_CHARS = 1500;

export const CATEGORY_QUESTION = "category";

/** A SystemOne request (POST /v1/systemone) asking which category one message belongs in. */
export function categoryRequest(model: string, state: CategoryState, options: readonly CategoryOption[]) {
  const own = options.filter((o) => !o.builtin).map((o) => o.name);
  return {
    model,
    state: {
      email: {
        from: state.from,
        to: state.to,
        subject: state.subject,
        text: state.text.slice(0, STATE_TEXT_CHARS),
        sent_to_a_mailing_list: state.mailingList,
        has_unsubscribe_link: state.unsubscribeLink,
        from_a_vip_sender: state.vipSender,
      },
    },
    questions: {
      [CATEGORY_QUESTION]: {
        type: "choice",
        instructions:
          "Which category of my Inbox does this email belong in? Choose the one whose description fits it best." +
          (own.length ? ` My own categories (${own.join(", ")}) come before the general ones when the email fits them.` : ""),
        criteria: Object.fromEntries(options.map((o) => [o.id, `${o.name}: ${o.description}`])),
      },
    },
  };
}

/**
 * What a request will cost in input tokens, before it is sent, erring high: a token per 2.5 bytes
 * of its JSON. On the benchmark's 360 requests (deploy/clef/bench) that came to 1.11-1.51 times
 * what Workers AI billed; text in a script of three UTF-8 bytes a character runs near a token each.
 */
export function estimateTokens(body: unknown): number {
  return Math.ceil(new TextEncoder().encode(JSON.stringify(body)).length / 2.5);
}

/** The classifier's answer: the category it chose and how sure it is. */
export interface CategoryAnswer {
  category: string;
  confidence: number;
}

/**
 * The answer in a SystemOne response, checked: the choice must be one of the options asked about
 * and the confidence a probability. Anything else is an error, not a guess.
 */
export function categoryAnswer(response: unknown, options: readonly CategoryOption[]): CategoryAnswer {
  const answer = (response as { answers?: Record<string, unknown> } | null)?.answers?.[CATEGORY_QUESTION] as
    | { choice?: unknown; confidence?: unknown }
    | undefined;
  const choice = answer?.choice;
  if (typeof choice !== "string" || !options.some((o) => o.id === choice)) {
    throw new Error("the classifier's answer names no category it was asked about");
  }
  const confidence = typeof answer!.confidence === "number" && answer!.confidence >= 0 && answer!.confidence <= 1 ? answer!.confidence : 0;
  return { category: choice, confidence };
}
