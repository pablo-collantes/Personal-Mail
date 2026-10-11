import { isPrefixWord, TOKEN } from "./text";

/**
 * Search highlights made from a message's own text, not by FTS5's highlight()
 * and snippet(). Those re-run the MATCH for every message, and a prefix term
 * expands to every indexed word sharing the prefix each time: a 200-message
 * SearchSnippet/get for "a" spent the Durable Object's 30 s of CPU and reset it
 * (2026-10-01 and 10-02). Matching follows the index's unicode61 tokenizer:
 * accents removed, case folded, the last token of a word as a prefix. Matches
 * are wrapped in \x02…\x03.
 */

const OPEN = "\u0002";
const CLOSE = "\u0003";

interface Term {
  text: string;
  prefix: boolean;
}

interface Token {
  start: number;
  end: number;
  /** Index of the term it matches, -1 for none. */
  term: number;
}

function fold(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Each token of each word; the last token of a word may be a prefix. */
function termsOf(words: string[]): Term[] {
  const terms: Term[] = [];
  for (const word of words) {
    const tokens = (word.match(TOKEN) ?? []).map(fold);
    tokens.forEach((text, i) => {
      if (text) terms.push({ text, prefix: i === tokens.length - 1 && isPrefixWord(word) });
    });
  }
  return terms;
}

function scan(text: string, terms: Term[]): Token[] {
  const tokens: Token[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const word = /^[\x00-\x7f]*$/.test(m[0]) ? m[0].toLowerCase() : fold(m[0]);
    const term = terms.findIndex((t) => (t.prefix ? word.startsWith(t.text) : word === t.text));
    tokens.push({ start: m.index, end: m.index + m[0].length, term });
  }
  return tokens;
}

/** Wraps the matching tokens of text[from, to) in markers. */
function mark(text: string, tokens: Token[], from: number, to: number): string {
  let out = "";
  let pos = from;
  for (const t of tokens) {
    if (t.term < 0 || t.start < from || t.end > to) continue;
    out += text.slice(pos, t.start) + OPEN + text.slice(t.start, t.end) + CLOSE;
    pos = t.end;
  }
  return out + text.slice(pos, to);
}

/** The whole text with every match marked, or null if nothing matches. */
export function highlight(text: string, words: string[]): string | null {
  const terms = termsOf(words);
  if (!terms.length) return null;
  const tokens = scan(text, terms);
  return tokens.some((t) => t.term >= 0) ? mark(text, tokens, 0, text.length) : null;
}

/**
 * A passage of about `size` tokens around the matches, with the most distinct
 * terms in it, or null if nothing matches. `more` says the text was cut short,
 * so a passage reaching its end still gets an ellipsis.
 */
export function snippet(text: string, words: string[], size = 24, more = false): string | null {
  const terms = termsOf(words);
  if (!terms.length) return null;
  const tokens = scan(text, terms);
  const hits = tokens.flatMap((t, i) => (t.term >= 0 ? [i] : []));
  if (!hits.length) return null;

  // Best window starting at a hit: most distinct terms, then most hits.
  let best = hits[0]!;
  let bestScore = -1;
  let bestLast = best;
  for (const h of hits) {
    const seen = new Set<number>();
    let count = 0;
    let last = h;
    for (let i = h; i < Math.min(h + size, tokens.length); i++) {
      const term = tokens[i]!.term;
      if (term < 0) continue;
      seen.add(term);
      count++;
      last = i;
    }
    const score = seen.size * size + count;
    if (score > bestScore) [best, bestScore, bestLast] = [h, score, last];
  }
  // Centre the hits in the window.
  const slack = size - (bestLast - best + 1);
  const start = Math.max(0, Math.min(best - Math.floor(slack / 2), tokens.length - size));
  const end = Math.min(start + size, tokens.length);

  // A passage reaching either end of the text keeps what's beyond its first/last token.
  const from = start > 0 ? tokens[start]!.start : 0;
  const to = end < tokens.length ? tokens[end - 1]!.end : text.length;
  return (start > 0 ? "…" : "") + mark(text, tokens, from, to) + (end < tokens.length || more ? "…" : "");
}
