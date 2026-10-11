import { addressParser, decodeWords, type Address } from "postal-mime";
import { MethodError } from "./protocol";

/**
 * Header fields of a stored message and the parsed forms of RFC 8621 §4.1.2,
 * for the `headers` and `header:<name>:as<Form>[:all]` Email properties.
 */

export interface HeaderField {
  name: string;
  /** Everything after the colon, folding kept (the Raw form). */
  value: string;
}

const MAX_HEADER_BYTES = 256 * 1024;

/** Splits a raw header section into fields. Stops at the blank line. */
export function parseHeaderBlock(block: string): HeaderField[] {
  const fields: HeaderField[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line === "") break;
    if ((line[0] === " " || line[0] === "\t") && fields.length) {
      fields[fields.length - 1]!.value += `\r\n${line}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    fields.push({ name: line.slice(0, colon).trimEnd(), value: line.slice(colon + 1) });
  }
  return fields;
}

/** Reads just the header section of a raw message from R2. null if the raw message is gone. */
export async function readHeaderFields(bucket: R2Bucket, key: string): Promise<HeaderField[] | null> {
  const object = await bucket.get(key, { range: { offset: 0, length: MAX_HEADER_BYTES } });
  if (!object) return null;
  const text = new TextDecoder().decode(await object.arrayBuffer());
  const end = text.search(/\r?\n\r?\n/);
  return parseHeaderBlock(end === -1 ? text : text.slice(0, end));
}

export type HeaderForm = "Raw" | "Text" | "Addresses" | "GroupedAddresses" | "MessageIds" | "Date" | "URLs";

export interface HeaderProperty {
  property: string;
  name: string;
  form: HeaderForm;
  all: boolean;
}

const FORMS = new Set<string>(["Raw", "Text", "Addresses", "GroupedAddresses", "MessageIds", "Date", "URLs"]);

/** Parses `header:List-Unsubscribe:asURLs:all`. null if the property isn't a header property. */
export function parseHeaderProperty(property: string): HeaderProperty | null {
  if (!property.startsWith("header:")) return null;
  const parts = property.slice("header:".length).split(":");
  const name = parts.shift();
  if (!name) throw new MethodError("invalidArguments", `Bad property ${property}.`);
  let form: HeaderForm = "Raw";
  let all = false;
  for (const part of parts) {
    if (part === "all" && !all) all = true;
    else if (part.startsWith("as") && FORMS.has(part.slice(2)) && form === "Raw" && !all) form = part.slice(2) as HeaderForm;
    else throw new MethodError("invalidArguments", `Bad property ${property}.`);
  }
  return { property, name, form, all };
}

export interface EmailAddress {
  name: string | null;
  email: string;
}

function unfold(value: string): string {
  return value.replace(/\r?\n(?=[ \t])/g, "");
}

export function asText(raw: string): string {
  return decodeWords(unfold(raw)).trim().normalize("NFC");
}

function addressesOf(list: Address[]): EmailAddress[] {
  return list.flatMap((a) =>
    "group" in a && a.group
      ? addressesOf(a.group)
      : [{ name: a.name ? a.name : null, email: "address" in a ? (a.address ?? "") : "" }],
  );
}

export function asAddresses(raw: string): EmailAddress[] {
  return addressesOf(addressParser(unfold(raw)));
}

export function asGroupedAddresses(raw: string): { name: string | null; addresses: EmailAddress[] }[] {
  const ungrouped: EmailAddress[] = [];
  const groups: { name: string | null; addresses: EmailAddress[] }[] = [];
  for (const a of addressParser(unfold(raw))) {
    if ("group" in a && a.group) groups.push({ name: a.name || null, addresses: addressesOf(a.group) });
    else ungrouped.push(...addressesOf([a]));
  }
  return ungrouped.length ? [{ name: null, addresses: ungrouped }, ...groups] : groups;
}

/** `<a@b> <c@d>` → ["a@b", "c@d"]. null when nothing parses. */
export function asMessageIds(raw: string | null): string[] | null {
  if (raw === null) return null;
  const ids = [...unfold(raw).matchAll(/<([^<>\s]+)>/g)].map((m) => m[1]!);
  if (ids.length) return ids;
  const bare = unfold(raw)
    .split(/\s+/)
    .filter((t) => t.includes("@"));
  return bare.length ? bare : null;
}

export function asDate(raw: string): string | null {
  const time = Date.parse(unfold(raw).replace(/\([^)]*\)/g, " ").trim());
  return Number.isNaN(time) ? null : new Date(time).toISOString().replace(/\.000Z$/, "Z");
}

export function asUrls(raw: string): string[] | null {
  const urls = [...unfold(raw).matchAll(/<([^<>]+)>/g)].map((m) => m[1]!.trim());
  return urls.length ? urls : null;
}

export function parseForm(raw: string, form: HeaderForm): unknown {
  switch (form) {
    case "Raw":
      return raw;
    case "Text":
      return asText(raw);
    case "Addresses":
      return asAddresses(raw);
    case "GroupedAddresses":
      return asGroupedAddresses(raw);
    case "MessageIds":
      return asMessageIds(raw);
    case "Date":
      return asDate(raw);
    case "URLs":
      return asUrls(raw);
  }
}

/** The value of one header property: the last field with that name, or all of them with `:all`. */
export function headerPropertyValue(fields: HeaderField[], prop: HeaderProperty): unknown {
  const lower = prop.name.toLowerCase();
  const matching = fields.filter((f) => f.name.toLowerCase() === lower);
  if (prop.all) return matching.map((f) => parseForm(f.value, prop.form));
  const last = matching.at(-1);
  return last ? parseForm(last.value, prop.form) : null;
}
