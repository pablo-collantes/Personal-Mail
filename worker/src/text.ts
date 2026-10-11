/** Cap on body text kept for search and the plain-text view. */
export const TEXT_LIMIT = 200_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const hex = entity[1] === "x" || entity[1] === "X";
      const cp = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

/** Rough HTML → text for search and previews. Never used for rendering. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return decodeEntities(text)
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim();
}

export function makePreview(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A run of the characters FTS5's unicode61 tokenizer keeps together as one token. */
export const TOKEN = /[\p{L}\p{N}\p{M}\p{Co}]+/gu;

/** The words of a search, quotes removed (they would end the FTS5 string), at most 16. */
export function searchWords(input: string): string[] {
  return input
    .normalize("NFKC")
    .split(/\s+/)
    .map((t) => t.replace(/"/g, ""))
    .filter(Boolean)
    .slice(0, 16);
}

/**
 * Whether a search word matches as a prefix ("inv" finds "invoice"). One that
 * ends in a single letter or digit matches only whole: "a"* reaches nearly
 * every word in the index, and expanding it is seconds of CPU per use.
 */
export function isPrefixWord(word: string): boolean {
  const last = word.match(TOKEN)?.at(-1) ?? "";
  return [...last].length >= 2;
}

/** One search word as a quoted FTS5 term; the quotes neutralise FTS5 operators. */
export function ftsTerm(word: string): string {
  return isPrefixWord(word) ? `"${word}"*` : `"${word}"`;
}

/** Turns user input into a safe FTS5 query: every word must match. */
export function toFtsQuery(input: string): string | null {
  const words = searchWords(input);
  return words.length ? words.map(ftsTerm).join(" ") : null;
}
