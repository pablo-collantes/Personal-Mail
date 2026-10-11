// The classifier's requests for every message in mail.jsonl, built by the Worker's own code
// (worker/src/categories.ts), so the bench measures exactly what a sweep would send: the same
// state, instructions, options and 1,500-character cut. Also the quick guess each message gets
// at ingest, as the baseline the classifier has to beat.
//
//   node requests.mts [mail.jsonl] > requests.jsonl
import { readFileSync } from "node:fs";
import { BUILTIN_CATEGORIES, categoryRequest, guessCategory, type CategoryOption } from "../../../worker/src/categories.ts";
import { makePreview } from "../../../worker/src/text.ts";

const MODEL = "clef-flash";

const builtin: CategoryOption[] = BUILTIN_CATEGORIES.map((c) => ({ id: c.id, name: c.name, description: c.description, builtin: true }));
// Two of the user's own, with the ids the Mailbox gives them (c1, c2, ...), after the built-in ones
// as CategoryStore.options() orders them.
const own: CategoryOption[] = [
  { id: "c1", name: "School", description: "Mail about my kids' school: teachers, the school office, the PTA, class trips, the school portal, lunch accounts.", builtin: false },
  { id: "c2", name: "Travel", description: "Trips: flights, boarding passes, hotels, rental cars, itineraries and travel changes.", builtin: false },
];
const CUSTOM_ID: Record<string, string> = { school: "c1", travel: "c2" };

interface Mail {
  id: string;
  from: string;
  to: string;
  subject: string;
  text: string;
  list_id: boolean;
  list_unsubscribe: boolean;
  vip: boolean;
  gold: string;
  accept: string[];
  custom: string | null;
  why: string;
}

const address = (from: string) => (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();

const path = process.argv[2] ?? new URL("mail.jsonl", import.meta.url).pathname;
for (const line of readFileSync(path, "utf8").split("\n")) {
  if (!line.trim()) continue;
  const m = JSON.parse(line) as Mail;
  // As ingest stores it: the body trimmed; the state's text is its start.
  const text = m.text.trim();
  const state = {
    from: m.from,
    to: m.to,
    subject: m.subject,
    text,
    mailingList: m.list_id,
    unsubscribeLink: m.list_unsubscribe,
    vipSender: m.vip,
  };
  const guess = guessCategory({
    fromAddress: address(m.from),
    subject: m.subject,
    preview: makePreview(text),
    listId: m.list_id ? "<list>" : null,
    listUnsubscribe: m.list_unsubscribe ? "<unsubscribe>" : null,
    vip: m.vip,
  });
  console.log(
    JSON.stringify({
      id: m.id,
      gold: m.gold,
      accept: m.accept ?? [],
      // With the user's own categories: theirs when one fits, else the same as without.
      gold_custom: m.custom ? CUSTOM_ID[m.custom] : m.gold,
      guess,
      text_chars: text.length,
      builtin: categoryRequest(MODEL, state, builtin),
      custom: categoryRequest(MODEL, state, [...builtin, ...own]),
    }),
  );
}
