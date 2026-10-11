import type { SpamVerdict } from "./types";

// The receiving server's spam filter verdict. Some providers run SpamAssassin
// on everything they deliver and write a short "Yes (7.1/5.0)" or
// "No (0.5/5.0)"; stock SpamAssassin writes "Yes, score=7.1 required=5.0 ...".
//
// Only the topmost header is read: the receiving server prepends its own. A
// sender can forge one further down, or forge the topmost one when no filter
// ran, but the only thing that buys them is a trip to Spam: "No" counts for
// nothing, it just means the filter didn't object.

export function spamVerdict(status: string | null, flag: string | null): SpamVerdict | null {
  const value = status?.replace(/\s+/g, " ").trim() ?? "";
  const word = /^(yes|no)\b/i.exec(value)?.[1]?.toLowerCase();
  const flagged = flag?.trim().toLowerCase();
  if (!word && flagged !== "yes" && flagged !== "no") return null;
  const score = /\bscore=(-?\d+(?:\.\d+)?)/i.exec(value) ?? /\((-?\d+(?:\.\d+)?)\s*\/\s*-?\d+(?:\.\d+)?\)/.exec(value);
  return {
    isSpam: word === "yes" || flagged === "yes",
    score: score ? Number(score[1]) : null,
  };
}
