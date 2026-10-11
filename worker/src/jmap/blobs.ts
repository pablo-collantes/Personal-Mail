import { attachmentKey, htmlKey, rawKey } from "../ids";

/**
 * Blob ids name what they point at, so a download needs no lookup:
 *   R<id>       the raw message (message/rfc822)
 *   H<id>       the HTML body
 *   P<id>       the plain-text body (from the search index)
 *   A<id>_<n>   attachment n
 */
export const blobIdFor = {
  raw: (id: string) => `R${id}`,
  html: (id: string) => `H${id}`,
  text: (id: string) => `P${id}`,
  attachment: (id: string, idx: number) => `A${id}_${idx}`,
};

export type BlobRef =
  | { kind: "raw" | "html" | "text"; id: string }
  | { kind: "attachment"; id: string; idx: number };

const MESSAGE_ID = "[0-9A-HJKMNP-TV-Z]{26}";
const BLOB_ID = new RegExp(`^(?:([RHP])(${MESSAGE_ID})|A(${MESSAGE_ID})_(\\d{1,4}))$`);

export function parseBlobId(blobId: string): BlobRef | null {
  const m = BLOB_ID.exec(blobId);
  if (!m) return null;
  if (m[3]) return { kind: "attachment", id: m[3], idx: Number(m[4]) };
  const kind = m[1] === "R" ? "raw" : m[1] === "H" ? "html" : "text";
  return { kind, id: m[2]! };
}

/** The R2 key of a stored blob (the text body lives in the Mailbox instead). */
export function blobKey(ref: BlobRef): string | null {
  switch (ref.kind) {
    case "raw":
      return rawKey(ref.id);
    case "html":
      return htmlKey(ref.id);
    case "attachment":
      return attachmentKey(ref.id, ref.idx);
    case "text":
      return null;
  }
}

const DEFAULT_TYPES: Record<BlobRef["kind"], string> = {
  raw: "message/rfc822",
  html: "text/html; charset=utf-8",
  text: "text/plain; charset=utf-8",
  attachment: "application/octet-stream",
};

function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Headers for any blob served from this origin. Mail content is hostile: an
 * HTML attachment opened from the mail hostname must not run as the app, so
 * every blob is a download, sandboxed, and never sniffed.
 */
export function blobHeaders(ref: BlobRef, name: string, type: string | null, stored: string | undefined): Headers {
  const headers = new Headers();
  const valid = type && /^[\w.+-]+\/[\w.+-]+(\s*;.*)?$/.test(type) ? type : null;
  headers.set("Content-Type", valid ?? stored ?? DEFAULT_TYPES[ref.kind]);
  headers.set("Content-Disposition", contentDisposition(name));
  headers.set("Content-Security-Policy", "default-src 'none'; sandbox");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  // A blob id always names the same bytes.
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  return headers;
}
