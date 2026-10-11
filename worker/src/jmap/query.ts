import { ftsTerm, searchWords } from "../text";
import { MethodError } from "./protocol";

/**
 * Email/query filters and sorts compiled to SQL over `messages m`. Text
 * conditions go through the FTS5 index (columns: subject, sender,
 * recipients, body, attachments).
 */

const FTS_COLUMNS = {
  text: null,
  from: "sender",
  to: "recipients",
  cc: "recipients",
  subject: "subject",
  body: "body",
} as const;

/** Words of user input as quoted FTS5 terms, optionally limited to one column. */
export function ftsTerms(input: string, column: string | null): string | null {
  const words = searchWords(input);
  if (!words.length) return null;
  return words.map((w) => (column ? `${column} : ${ftsTerm(w)}` : ftsTerm(w))).join(" AND ");
}

function keywordColumn(keyword: unknown): string | null {
  if (typeof keyword !== "string") throw new MethodError("invalidArguments", "Keywords must be strings.");
  const k = keyword.toLowerCase();
  return k === "$seen" ? "m.seen" : k === "$flagged" ? "m.flagged" : null;
}

function utc(value: unknown, key: string): number {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (Number.isNaN(time)) throw new MethodError("invalidArguments", `${key} must be a UTCDate.`);
  return time;
}

const REAL_ATTACHMENT = `EXISTS (SELECT 1 FROM attachments a WHERE a.message_seq = m.seq
  AND NOT (a.disposition = 'inline' AND a.content_id IS NOT NULL))`;

/** Returns a SQL boolean expression and pushes its parameters. */
export function compileFilter(filter: unknown, params: SqlStorageValue[]): string {
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw new MethodError("invalidArguments", "filter must be an object.");
  }
  const f = filter as Record<string, unknown>;
  if ("operator" in f) {
    const conditions = f.conditions;
    if (!Array.isArray(conditions)) throw new MethodError("invalidArguments", "conditions must be an array.");
    const parts = conditions.map((c) => `(${compileFilter(c, params)})`);
    switch (f.operator) {
      case "AND":
        return parts.length ? parts.join(" AND ") : "1";
      case "OR":
        return parts.length ? parts.join(" OR ") : "0";
      case "NOT":
        return parts.length ? `NOT (${parts.join(" OR ")})` : "1";
      default:
        throw new MethodError("unsupportedFilter", `Unknown operator ${String(f.operator)}.`);
    }
  }

  const clauses: string[] = [];
  for (const [key, value] of Object.entries(f)) {
    switch (key) {
      case "inMailbox":
        if (typeof value !== "string") throw new MethodError("invalidArguments", "inMailbox must be an id.");
        clauses.push("m.folder = ?");
        params.push(value);
        break;
      case "inMailboxOtherThan": {
        if (!Array.isArray(value)) throw new MethodError("invalidArguments", "inMailboxOtherThan must be a list.");
        const ids = value.filter((v): v is string => typeof v === "string");
        if (ids.length) {
          clauses.push(`m.folder NOT IN (${ids.map(() => "?").join(", ")})`);
          params.push(...ids);
        }
        break;
      }
      case "before":
        clauses.push("m.received_at < ?");
        params.push(utc(value, key));
        break;
      case "after":
        clauses.push("m.received_at >= ?");
        params.push(utc(value, key));
        break;
      case "minSize":
      case "maxSize":
        if (typeof value !== "number") throw new MethodError("invalidArguments", `${key} must be a number.`);
        clauses.push(key === "minSize" ? "m.size >= ?" : "m.size < ?");
        params.push(value);
        break;
      case "hasKeyword":
      case "allInThreadHaveKeyword":
      case "someInThreadHaveKeyword": {
        const column = keywordColumn(value);
        clauses.push(column ? `${column} = 1` : "0");
        break;
      }
      case "notKeyword":
      case "noneInThreadHaveKeyword": {
        const column = keywordColumn(value);
        clauses.push(column ? `${column} = 0` : "1");
        break;
      }
      case "category":
        // Ours (categories.ts): the Inbox category.
        if (typeof value !== "string") throw new MethodError("invalidArguments", "category must be a category id.");
        clauses.push("m.category = ?");
        params.push(value);
        break;
      case "hasAttachment":
        if (typeof value !== "boolean") throw new MethodError("invalidArguments", "hasAttachment must be a boolean.");
        clauses.push(value ? REAL_ATTACHMENT : `NOT ${REAL_ATTACHMENT}`);
        break;
      case "text":
      case "from":
      case "to":
      case "cc":
      case "subject":
      case "body": {
        if (typeof value !== "string") throw new MethodError("invalidArguments", `${key} must be a string.`);
        const match = ftsTerms(value, FTS_COLUMNS[key]);
        if (!match) break;
        clauses.push("m.seq IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)");
        params.push(match);
        break;
      }
      case "bcc":
        // Received mail doesn't keep Bcc.
        clauses.push("0");
        break;
      case "header": {
        if (!Array.isArray(value) || typeof value[0] !== "string") {
          throw new MethodError("invalidArguments", "header must be [name] or [name, value].");
        }
        const name = value[0].toLowerCase();
        const column = name === "list-id" ? "m.list_id" : name === "message-id" ? "m.message_id" : null;
        if (!column) throw new MethodError("unsupportedFilter", `Filtering on the ${value[0]} header isn't supported.`);
        if (typeof value[1] === "string") {
          clauses.push(`instr(lower(coalesce(${column}, '')), lower(?)) > 0`);
          params.push(value[1]);
        } else clauses.push(`${column} IS NOT NULL`);
        break;
      }
      default:
        throw new MethodError("unsupportedFilter", `The ${key} filter isn't supported.`);
    }
  }
  return clauses.length ? clauses.join(" AND ") : "1";
}

/** The words of a filter's text conditions, by the column they highlight in, for SearchSnippet/get. */
export function snippetWords(filter: unknown): { subject: string[]; body: string[] } {
  const words = { subject: [] as string[], body: [] as string[] };
  const collect = (f: unknown) => {
    if (!f || typeof f !== "object") return;
    const o = f as Record<string, unknown>;
    if (Array.isArray(o.conditions) && o.operator !== "NOT") o.conditions.forEach(collect);
    for (const key of ["text", "subject", "body"] as const) {
      const value = o[key];
      if (typeof value !== "string") continue;
      if (key !== "body") words.subject.push(...searchWords(value));
      if (key !== "subject") words.body.push(...searchWords(value));
    }
  };
  collect(filter);
  return words;
}

const SORT_COLUMNS: Record<string, string> = {
  receivedAt: "m.received_at",
  sentAt: "coalesce(m.sent_at, m.received_at)",
  size: "m.size",
  from: "lower(coalesce(nullif(m.from_name, ''), m.from_address, ''))",
  subject: "lower(m.subject)",
};

/** An ORDER BY clause. Newest first when the client doesn't say. Ties break on insertion order. */
export function compileSort(sort: unknown): string {
  if (sort === undefined || sort === null) return "m.received_at DESC, m.seq DESC";
  if (!Array.isArray(sort)) throw new MethodError("invalidArguments", "sort must be a list.");
  const terms: string[] = [];
  let lastDirection = "DESC";
  for (const s of sort) {
    const c = s as { property?: unknown; isAscending?: unknown; keyword?: unknown };
    const direction = c.isAscending === false ? "DESC" : "ASC";
    lastDirection = direction;
    if (typeof c.property === "string" && c.property in SORT_COLUMNS) {
      terms.push(`${SORT_COLUMNS[c.property]} ${direction}`);
    } else if (
      c.property === "hasKeyword" ||
      c.property === "allInThreadHaveKeyword" ||
      c.property === "someInThreadHaveKeyword"
    ) {
      const column = keywordColumn(c.keyword);
      if (column) terms.push(`${column} ${direction}`);
    } else {
      throw new MethodError("unsupportedSort", `Sorting by ${String(c.property)} isn't supported.`);
    }
  }
  terms.push(`m.seq ${lastDirection}`);
  return terms.join(", ");
}
