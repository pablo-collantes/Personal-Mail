/**
 * The JMAP request envelope (RFC 8620 §3): method calls, result references
 * and errors. The mail methods themselves are in mail.ts.
 */

export const CORE = "urn:ietf:params:jmap:core";
export const MAIL = "urn:ietf:params:jmap:mail";
/**
 * Ours: Email has a `category` property (its Inbox category, categories.ts) and Email/query a
 * `category` filter. Advertised so a client asks for the property only here: any other server
 * fails an Email/get naming a property it doesn't know.
 */
export const CATEGORIES = "urn:io.github.pablocollantes:jmap:categories";

export const LIMITS = {
  maxSizeUpload: 0,
  maxConcurrentUpload: 1,
  maxSizeRequest: 10_000_000,
  maxConcurrentRequests: 8,
  maxCallsInRequest: 64,
  maxObjectsInGet: 1000,
  maxObjectsInSet: 1000,
  collationAlgorithms: ["i;ascii-casemap", "i;unicode-casemap"],
} as const;

export type Args = Record<string, unknown>;
export type Invocation = [name: string, args: Args, callId: string];

export interface JmapRequest {
  using: string[];
  methodCalls: Invocation[];
  createdIds?: Record<string, string>;
}

export interface JmapResponse {
  methodResponses: Invocation[];
  sessionState: string;
  createdIds?: Record<string, string>;
}

/** A method-level error (RFC 8620 §3.6.2). */
export class MethodError extends Error {
  constructor(
    readonly type: string,
    description?: string,
    readonly extra: Args = {},
  ) {
    super(description ?? type);
  }
}

/** A request-level error (RFC 8620 §3.6.1), answered as application/problem+json. */
export class RequestError extends Error {
  constructor(
    readonly type: "notJSON" | "notRequest" | "limit" | "unknownCapability",
    readonly detail: string,
    readonly limit?: string,
  ) {
    super(detail);
  }

  toResponse(): Response {
    return Response.json(
      {
        type: `urn:ietf:params:jmap:error:${this.type}`,
        status: 400,
        detail: this.detail,
        ...(this.limit ? { limit: this.limit } : {}),
      },
      { status: 400, headers: { "content-type": "application/problem+json" } },
    );
  }
}

/** Checks the shape of a parsed request body. */
export function parseRequest(body: unknown): JmapRequest {
  if (!body || typeof body !== "object") throw new RequestError("notRequest", "The request is not a JSON object.");
  const { using, methodCalls, createdIds } = body as Record<string, unknown>;
  if (!Array.isArray(using) || !using.every((u) => typeof u === "string")) {
    throw new RequestError("notRequest", "'using' must be an array of strings.");
  }
  if (!Array.isArray(methodCalls)) throw new RequestError("notRequest", "'methodCalls' must be an array.");
  for (const call of methodCalls) {
    if (
      !Array.isArray(call) ||
      call.length !== 3 ||
      typeof call[0] !== "string" ||
      !call[1] ||
      typeof call[1] !== "object" ||
      Array.isArray(call[1]) ||
      typeof call[2] !== "string"
    ) {
      throw new RequestError("notRequest", "Each method call must be [name, arguments, callId].");
    }
  }
  if (methodCalls.length > LIMITS.maxCallsInRequest) {
    throw new RequestError("limit", `At most ${LIMITS.maxCallsInRequest} method calls per request.`, "maxCallsInRequest");
  }
  if (createdIds !== undefined && (typeof createdIds !== "object" || createdIds === null)) {
    throw new RequestError("notRequest", "'createdIds' must be an object.");
  }
  return {
    using: using as string[],
    methodCalls: methodCalls as Invocation[],
    ...(createdIds ? { createdIds: createdIds as Record<string, string> } : {}),
  };
}

export type Handler = (args: Args) => Promise<Args> | Args;
export interface Method {
  capability: string;
  run: Handler;
}

/**
 * Runs method calls in order. A failed call produces an error response and
 * the rest still run, as RFC 8620 §3.6.2 requires.
 */
export async function runCalls(
  request: JmapRequest,
  methods: Record<string, Method>,
  sessionState: string,
): Promise<JmapResponse> {
  // Unknown capabilities in `using` are ignored rather than failing the whole
  // request: clients list what they would like, and the methods below still
  // refuse anything we don't implement.
  const using = new Set([...request.using, CORE]);
  const responses: Invocation[] = [];
  for (const [name, rawArgs, callId] of request.methodCalls) {
    try {
      const method = Object.hasOwn(methods, name) ? methods[name] : undefined;
      if (!method || !using.has(method.capability)) throw new MethodError("unknownMethod", `Unknown method ${name}.`);
      const args = resolveReferences(rawArgs, responses);
      responses.push([name, await method.run(args), callId]);
    } catch (err) {
      responses.push(["error", errorArgs(err, name), callId]);
    }
  }
  return {
    methodResponses: responses,
    sessionState,
    ...(request.createdIds ? { createdIds: request.createdIds } : {}),
  };
}

function errorArgs(err: unknown, name: string): Args {
  if (err instanceof MethodError) return { type: err.type, description: err.message, ...err.extra };
  console.error("jmap method failed", { method: name, error: String(err), stack: (err as Error)?.stack });
  return { type: "serverFail", description: "The server hit an unexpected error." };
}

/** Replaces `#name` arguments with the value they point to (RFC 8620 §3.7). */
export function resolveReferences(args: Args, previous: Invocation[]): Args {
  const out: Args = {};
  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("#")) {
      out[key] = value;
      continue;
    }
    const plain = key.slice(1);
    if (Object.hasOwn(args, plain)) throw new MethodError("invalidArguments", `Both ${plain} and #${plain} were given.`);
    const ref = value as { resultOf?: unknown; name?: unknown; path?: unknown } | null;
    if (!ref || typeof ref.resultOf !== "string" || typeof ref.name !== "string" || typeof ref.path !== "string") {
      throw new MethodError("invalidResultReference", `#${plain} is not a ResultReference.`);
    }
    const source = previous.find(([n, , id]) => id === ref.resultOf && n === ref.name);
    if (!source) throw new MethodError("invalidResultReference", `No ${ref.name} response with id ${ref.resultOf}.`);
    out[plain] = evaluatePointer(source[1], ref.path);
  }
  return out;
}

/** JSON Pointer with JMAP's `*` extension: `*` maps over an array and flattens array results. */
export function evaluatePointer(value: unknown, path: string): unknown {
  if (path === "" || path === "/") return value;
  if (!path.startsWith("/")) throw new MethodError("invalidResultReference", `Bad path ${path}.`);
  const tokens = path
    .slice(1)
    .split("/")
    .map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
  return walk(value, tokens, path);
}

function walk(value: unknown, tokens: string[], path: string): unknown {
  if (!tokens.length) return value;
  const [token, ...rest] = tokens as [string, ...string[]];
  if (Array.isArray(value)) {
    if (token === "*") {
      return value.flatMap((item) => {
        const r = walk(item, rest, path);
        return Array.isArray(r) ? r : [r];
      });
    }
    const index = Number(token);
    if (!/^\d+$/.test(token) || index >= value.length) {
      throw new MethodError("invalidResultReference", `Path ${path} does not exist.`);
    }
    return walk(value[index], rest, path);
  }
  if (value && typeof value === "object" && Object.hasOwn(value, token)) {
    return walk((value as Record<string, unknown>)[token], rest, path);
  }
  throw new MethodError("invalidResultReference", `Path ${path} does not exist.`);
}

// ---- Argument helpers ----

export function optionalString(args: Args, key: string): string | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new MethodError("invalidArguments", `${key} must be a string.`);
  return v;
}

export function optionalInt(args: Args, key: string, fallback: number, min = 0): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
    throw new MethodError("invalidArguments", `${key} must be an integer of at least ${min}.`);
  }
  return v;
}

export function optionalBool(args: Args, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new MethodError("invalidArguments", `${key} must be a boolean.`);
  return v;
}

export function optionalStringList(args: Args, key: string): string[] | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new MethodError("invalidArguments", `${key} must be an array of strings.`);
  }
  return v as string[];
}
