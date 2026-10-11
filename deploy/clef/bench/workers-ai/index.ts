// Passes a SystemOne request body to Workers AI's Clef, unchanged, and answers with what came back
// and how long the call took. ?model=clef for the 27B; Clef-Flash otherwise.
interface Env {
  AI: Ai;
}

export default {
  async fetch(request, env): Promise<Response> {
    if (request.method !== "POST") return new Response("POST a SystemOne request body", { status: 405 });
    const model = new URL(request.url).searchParams.get("model") === "clef" ? "@cf/cloudflare/clef" : "@cf/cloudflare/clef-flash";
    const body = await request.json();
    const started = Date.now();
    try {
      const result = await env.AI.run(model as Parameters<Ai["run"]>[0], body as never);
      return Response.json({ model, ms: Date.now() - started, result });
    } catch (e) {
      return Response.json({ model, ms: Date.now() - started, error: String(e), name: (e as Error)?.name }, { status: 502 });
    }
  },
} satisfies ExportedHandler<Env>;
