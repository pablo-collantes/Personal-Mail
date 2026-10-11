const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Encodes a ms timestamp as the 10-char, lexicographically sortable time prefix of an id. */
export function idTimePrefix(time: number): string {
  let out = "";
  let t = Math.max(0, Math.floor(time));
  for (let i = 0; i < TIME_LEN; i++) {
    out = CROCKFORD[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

export function idTime(id: string): number {
  let t = 0;
  for (const ch of id.slice(0, TIME_LEN)) t = t * 32 + CROCKFORD.indexOf(ch);
  return t;
}

/** ULID-shaped id: sorts by receive time, so R2 keys list chronologically. */
export function newId(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(RANDOM_LEN));
  let rand = "";
  for (const b of bytes) rand += CROCKFORD[b % 32];
  return idTimePrefix(now) + rand;
}

/**
 * Same shape as newId, but the random part is derived from `key`, so fetching
 * the same message again yields the same id (and the Mailbox sees a duplicate).
 */
export async function stableId(time: number, key: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  let rand = "";
  for (const b of digest.subarray(0, RANDOM_LEN)) rand += CROCKFORD[b % 32];
  return idTimePrefix(time) + rand;
}

export const rawKey = (id: string) => `raw/${id}.eml`;
export const htmlKey = (id: string) => `html/${id}.html`;
export const attachmentKey = (id: string, idx: number) => `att/${id}/${idx}`;

export function attachmentKeys(id: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => attachmentKey(id, i));
}

/** Every R2 object a message can own. */
export function blobKeys(id: string, attachmentCount: number): string[] {
  return [rawKey(id), htmlKey(id), ...attachmentKeys(id, attachmentCount)];
}

export function idFromRawKey(key: string): string | null {
  const m = /^raw\/([0-9A-Z]{26})\.eml$/.exec(key);
  return m ? m[1]! : null;
}
