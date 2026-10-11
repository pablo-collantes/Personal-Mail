// The same requests as mailbench.py, sent to Workers AI's hosted Clef-Flash (or Clef) instead of a model on
// this machine, through the passthrough Worker in workers-ai/ running under `wrangler dev`. Writes
// results/workers-ai-<model>.json in mailbench's format, so `python3 mailbench.py --report` compares them.
//
//   (cd workers-ai && ../../../../worker/node_modules/.bin/wrangler dev --port 8790)
//   node workersai.mts [--model clef] [--limit N]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    model: { type: "string", default: "clef-flash" },
    limit: { type: "string" },
    url: { type: "string", default: "http://127.0.0.1:8790/" },
    concurrency: { type: "string", default: "4" },
  },
});
const here = new URL(".", import.meta.url).pathname;
let rows = readFileSync(`${here}requests.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
if (args.limit) rows = rows.slice(0, Number(args.limit));
const tag = `workers-ai-${args.model}`;

interface Answer {
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
  tokens: number;
  ms: number;
  worker_ms: number;
}

async function ask(body: Record<string, unknown>): Promise<Answer> {
  for (let attempt = 1; ; attempt++) {
    const started = performance.now();
    const res = await fetch(`${args.url}?model=${args.model}`, { method: "POST", body: JSON.stringify({ ...body, model: args.model }) });
    const out = await res.json() as { ms: number; result?: { answers: { category: Answer }; usage: { input_tokens: number } }; error?: string };
    const ms = Math.round((performance.now() - started) * 10) / 10;
    if (out.result) {
      const a = out.result.answers.category;
      return {
        choice: a.choice,
        confidence: a.confidence,
        probabilities: a.probabilities,
        tokens: out.result.usage.input_tokens,
        ms,
        worker_ms: out.ms,
      };
    }
    if (attempt >= 4) throw new Error(`${res.status}: ${out.error}`);
    console.error(`  retry ${attempt}: ${res.status} ${out.error}`);
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
}

const out: Record<string, unknown>[] = new Array(rows.length);
let next = 0;
let done = 0;
const started = performance.now();
async function worker() {
  while (next < rows.length) {
    const i = next++;
    const row = rows[i];
    const record: Record<string, unknown> = {
      id: row.id, gold: row.gold, accept: row.accept, gold_custom: row.gold_custom, guess: row.guess, text_chars: row.text_chars,
    };
    for (const kind of ["builtin", "custom"]) record[kind] = await ask(row[kind]);
    out[i] = record;
    const b = record.builtin as Answer;
    const ok = [row.gold, ...row.accept].includes(b.choice);
    console.log(`  ${String(++done).padStart(3)}/${rows.length} ${ok ? "ok " : "BAD"} ${row.id.padEnd(5)} gold ${row.gold.padEnd(12)} got ${b.choice.padEnd(12)} `
      + `${b.confidence.toFixed(2)}  ${b.tokens} tok  ${b.ms} ms`);
  }
}
await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));
const result = {
  model: args.model,
  quant: "workers-ai",
  where: "workers-ai",
  concurrency: Number(args.concurrency),
  wall_s: Math.round((performance.now() - started) / 100) / 10,
  rows: out,
};
mkdirSync(`${here}results`, { recursive: true });
writeFileSync(`${here}results/${tag}.json`, JSON.stringify(result, null, 1));
console.log(`[${tag}] ${out.length} messages in ${result.wall_s} s; wrote results/${tag}.json`);
