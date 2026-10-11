/**
 * JMAP push over EventSource (RFC 8620 §7.3). The Worker holds the stream,
 * and the Mailbox tells it about changes over a hibernatable WebSocket
 * (Mailbox.fetch): nothing polls, so between changes the Durable Object
 * sleeps and an open stream costs it nothing.
 */

import { PUSH_PING } from "../mailbox";

export type TypeStates = Record<string, string>;

const MIN_PING_S = 15;
const MAX_PING_S = 300;
/** Streams end after this long; EventSource clients reconnect on their own. */
const MAX_STREAM_MS = 30 * 60_000;
/** The push socket's keep-alive, answered by the runtime without waking the Mailbox. */
const KEEPALIVE_MS = 60_000;

export interface EventSourceOptions {
  accountId: string;
  /** Opens a push socket to the Mailbox: its first message is the current states, then one per change. */
  connect: () => Promise<WebSocket>;
  maxStreamMs?: number;
  keepAliveMs?: number;
}

export function eventSourceResponse(request: Request, options: EventSourceOptions): Response {
  const url = new URL(request.url);
  const typesParam = url.searchParams.get("types") ?? "*";
  const types = typesParam === "*" ? null : new Set(typesParam.split(",").map((t) => t.trim()));
  const closeAfterState = url.searchParams.get("closeafter") === "state";
  const pingParam = Number(url.searchParams.get("ping") ?? "0");
  const ping = Number.isFinite(pingParam) && pingParam > 0 ? Math.min(Math.max(pingParam, MIN_PING_S), MAX_PING_S) : 0;
  const maxStreamMs = options.maxStreamMs ?? MAX_STREAM_MS;
  const keepAliveMs = options.keepAliveMs ?? KEEPALIVE_MS;

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const send = (event: string, data: unknown) => writer.write(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));

  const filter = (states: TypeStates): TypeStates =>
    types ? Object.fromEntries(Object.entries(states).filter(([t]) => types.has(t))) : states;

  const run = async () => {
    let socket: WebSocket | null = null;
    let pingTimer: ReturnType<typeof setTimeout> | null = null;
    let endTimer: ReturnType<typeof setTimeout> | null = null;
    let keepAlive: ReturnType<typeof setInterval> | null = null;
    try {
      socket = await options.connect();
      socket.accept();
      const open = socket;
      await new Promise<void>((end) => {
        let last: TypeStates | null = null;
        // A ping goes out when `ping` seconds pass without any event.
        const schedulePing = () => {
          if (!ping) return;
          clearTimeout(pingTimer);
          pingTimer = setTimeout(() => write("ping", { "@type": "Ping", interval: ping }), ping * 1000);
        };
        const write = (event: string, data: unknown) => {
          schedulePing();
          // A failed write is the client gone.
          send(event, data).catch(() => end());
        };
        schedulePing();
        open.addEventListener("message", (event) => {
          let states: TypeStates;
          try {
            states = filter(JSON.parse(String(event.data)) as TypeStates);
          } catch {
            return;
          }
          // The first message is the current state. A normal stream opens with it so the client
          // can catch up; with closeafter=state the client polls by reconnecting, so it only sets
          // what a real change is measured against.
          const first = last === null;
          const changed = first || Object.entries(states).some(([t, s]) => last![t] !== s);
          last = states;
          if (first && closeAfterState) return;
          if (!changed) return;
          write("state", { "@type": "StateChange", changed: { [options.accountId]: states } });
          if (closeAfterState && Object.keys(states).length) end();
        });
        open.addEventListener("close", () => end());
        open.addEventListener("error", () => end());
        endTimer = setTimeout(end, maxStreamMs);
        keepAlive = setInterval(() => {
          try {
            open.send(PUSH_PING);
          } catch {
            end();
          }
        }, keepAliveMs);
      });
    } catch {
      // The Mailbox couldn't be reached; the client reconnects.
    }
    clearTimeout(pingTimer);
    clearTimeout(endTimer);
    clearInterval(keepAlive);
    try {
      socket?.close(1000, "stream ended");
    } catch {
      // Already closed.
    }
    await writer.close().catch(() => {});
  };
  void run();

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
