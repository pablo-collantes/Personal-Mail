import { env } from "cloudflare:test";
import { indexMessage, receiveEmail } from "../src/ingest";
import type { IngestJob } from "../src/types";

export interface MimeOptions {
  from?: string;
  to?: string;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: { filename: string; mimeType: string; content: string }[];
  /** Headers placed above everything else, as a receiving MTA would add them. */
  topHeaders?: [string, string][];
  headers?: [string, string][];
}

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export function buildMime(o: MimeOptions = {}): string {
  const lines: string[] = [
    ...(o.topHeaders ?? []).map(([k, v]) => `${k}: ${v}`),
    `From: ${o.from ?? "Alice Example <alice@example.com>"}`,
    `To: ${o.to ?? "Alex <alex@example.net>"}`,
    `Subject: ${o.subject ?? "Hello"}`,
    "Date: Thu, 24 Sep 2026 10:00:00 +0000",
    `Message-ID: <${crypto.randomUUID()}@example.com>`,
    ...(o.headers ?? []).map(([k, v]) => `${k}: ${v}`),
    "MIME-Version: 1.0",
  ];
  const text = o.text ?? (o.html ? undefined : "Hi Alex");
  const bodyParts: string[] = [];
  if (text !== undefined) bodyParts.push(`Content-Type: text/plain; charset=utf-8\r\n\r\n${text}`);
  if (o.html !== undefined) bodyParts.push(`Content-Type: text/html; charset=utf-8\r\n\r\n${o.html}`);
  const body =
    bodyParts.length === 1
      ? bodyParts[0]!
      : `Content-Type: multipart/alternative; boundary="alt"\r\n\r\n${bodyParts.map((p) => `--alt\r\n${p}\r\n`).join("")}--alt--`;

  if (!o.attachments?.length) return `${lines.join("\r\n")}\r\n${body}\r\n`;
  const parts = [
    body,
    ...o.attachments.map(
      (a) =>
        `Content-Type: ${a.mimeType}; name="${a.filename}"\r\n` +
        `Content-Disposition: attachment; filename="${a.filename}"\r\n` +
        `Content-Transfer-Encoding: base64\r\n\r\n${b64(a.content)}`,
    ),
  ];
  return (
    `${lines.join("\r\n")}\r\nContent-Type: multipart/mixed; boundary="mix"\r\n\r\n` +
    `${parts.map((p) => `--mix\r\n${p}\r\n`).join("")}--mix--\r\n`
  );
}

export function fakeEmail(raw: string, envelope: { from?: string; to: string }) {
  const bytes = new TextEncoder().encode(raw);
  const state = { rejected: null as string | null };
  const message = {
    from: envelope.from ?? "bounce@example.com",
    to: envelope.to,
    headers: new Headers(),
    raw: new Response(bytes).body,
    rawSize: bytes.byteLength,
    canBeForwarded: true,
    setReject(reason: string) {
      state.rejected = reason;
    },
    forward: () => Promise.reject(new Error("forward not expected")),
    reply: () => Promise.reject(new Error("reply not expected")),
  };
  return { message: message as unknown as ForwardableEmailMessage, state };
}

/** A copy of the test env with its own mailbox, so tests don't share state. */
export function freshEnv(overrides: { [K in keyof Env]?: unknown } = {}): Env {
  return { ...env, MAILBOX_NAME: crypto.randomUUID(), ...overrides } as Env;
}

export function mailboxOf(testEnv: Env) {
  return testEnv.MAILBOX.getByName(testEnv.MAILBOX_NAME);
}

/** Runs a message through receive + index, with the queue replaced by a direct call. */
export async function deliver(testEnv: Env, raw: string, envelope: { from?: string; to: string }) {
  const jobs: IngestJob[] = [];
  const { message, state } = fakeEmail(raw, envelope);
  const job = await receiveEmail(message, testEnv, async (queued) => void jobs.push(...queued));
  const result = job ? await indexMessage(testEnv, job) : null;
  return { job, result, rejected: state.rejected, queued: jobs };
}
