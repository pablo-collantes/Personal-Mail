#!/usr/bin/env python3
"""Can Clef-Flash (or Clef, the 27B), on this machine, sort the Inbox into categories? How many tokens does it take?

    node requests.mts > requests.jsonl                       # the Worker's own requests for mail.jsonl
    $VENV/bin/python mailbench.py --quant bf16               # one run per model and quantization
    $VENV/bin/python mailbench.py --quant nf4
    $VENV/bin/python mailbench.py --model clef --quant nf4   # the 27B; bf16 (55 GB) does not fit this GPU
    python3 mailbench.py --report                            # compare results/*.json (no GPU needed)

$VENV is clef-bench's environment (ROCm torch for gfx1151, transformers 5.10.2, bitsandbytes), and
the model is loaded through clef-bench's loader, which carries this machine's fixes (streaming load,
attention kernels). clef-bench is a separate local harness, not part of this repository: point
CLEF_BENCH at its directory. --report needs neither.

Every message is asked twice: with the four built-in categories, and with two of the user's own
(School, Travel) added, exactly as a sweep would ask (worker/src/categories.ts, categoryRequest).
Tokens are the model's input tokens, which is what Workers AI bills both models by (no output tokens).
The two share a tokenizer, so a message costs the same tokens on either.
"""

from __future__ import annotations

import argparse
import collections
import importlib.util
import json
import os
import statistics
import sys
import threading
import time
from glob import glob
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESULTS = HERE / "results"
CLEF_BENCH = Path(os.environ.get("CLEF_BENCH", "clef-bench"))

# Workers AI (developers.cloudflare.com/workers-ai/platform/pricing, 2026-10-02): per million input tokens,
# no output tokens; 10,000 neurons a day free.
PRICES = {  # model: ($ per M, neurons per M)
    "clef-flash": (0.09, 8182),
    "clef": (0.24, 21818),
}
FREE_NEURONS_PER_DAY = 10_000
BUILTIN = ("primary", "transactions", "updates", "promotions")
NAMES = {"primary": "Primary", "transactions": "Transactions", "updates": "Updates", "promotions": "Promotions", "c1": "School", "c2": "Travel"}


def clef_bench():
    spec = importlib.util.spec_from_file_location("clef_bench", CLEF_BENCH / "bench.py")
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(CLEF_BENCH))
    spec.loader.exec_module(module)
    return module


class Power:
    """The APU's package power (amdgpu's PPT: CPU and GPU together), sampled every 50 ms."""

    def __init__(self) -> None:
        paths = glob("/sys/class/drm/card*/device/hwmon/hwmon*/power1_average")
        self.path = Path(paths[0]) if paths else None
        self.samples: list[tuple[float, float]] = []
        self._stop = threading.Event()
        if self.path:
            threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self) -> None:
        while not self._stop.is_set():
            self.samples.append((time.monotonic(), int(self.path.read_text()) / 1e6))
            time.sleep(0.05)

    def mean(self, start: float, end: float) -> float | None:
        watts = [w for t, w in self.samples if start <= t <= end]
        return round(statistics.mean(watts), 1) if watts else None


def run(args) -> None:
    cb = clef_bench()
    import torch

    rows = [json.loads(line) for line in open(HERE / "requests.jsonl")]
    if args.limit:
        rows = rows[: args.limit]
    tag = args.tag or f"{args.model}-{args.quant}"
    memory = cb.GpuMemory()
    power = Power()
    result = {"model": args.model, "quant": args.quant, "torch": torch.__version__, "device": torch.cuda.get_device_name(0)}

    time.sleep(5)
    result["power_idle_before_load_w"] = power.mean(time.monotonic() - 5, time.monotonic())
    t = time.perf_counter()
    jsm, model, processor = cb.load(args.model, args.quant)
    torch.cuda.synchronize()
    result["load_s"] = round(time.perf_counter() - t, 1)
    result["memory_after_load"] = memory.snapshot()
    print(f"[{tag}] loaded in {result['load_s']} s; {result['memory_after_load']}", flush=True)

    runner = cb.Runner(jsm, model, processor, 16384)
    for _ in range(3):  # warm-up: kernels, allocator
        runner(rows[0]["builtin"])
    memory.reset_peak()
    # What the token count is before any message: the system prompt, the schema and the wrapping.
    empty = {"from": None, "to": "", "subject": "", "text": "", "sent_to_a_mailing_list": False,
             "has_unsubscribe_link": False, "from_a_vip_sender": False}
    result["fixed_tokens"] = {
        kind: len(jsm.encode_record(processor.tokenizer, {**rows[0][kind], "state": {"email": empty}}).input_ids)
        for kind in ("builtin", "custom")
    }
    # The GPU's clocks take a moment to fall after the warm-up.
    time.sleep(5)
    t = time.monotonic()
    time.sleep(5)
    result["power_idle_loaded_w"] = power.mean(t, time.monotonic())

    out = []
    started = time.monotonic()
    for i, row in enumerate(rows):
        record = {"id": row["id"], "gold": row["gold"], "accept": row["accept"], "gold_custom": row["gold_custom"],
                  "guess": row["guess"], "text_chars": row["text_chars"]}
        for kind in args.runs.split(","):
            answers, timing = runner(row[kind])
            a = answers["category"]
            record[kind] = {"choice": a["choice"], "confidence": round(a["confidence"], 4),
                            "probabilities": {k: round(v, 4) for k, v in a["probabilities"].items()},
                            "tokens": timing["tokens"], "ms": timing["total_ms"]}
        out.append(record)
        b = record.get("builtin", {})
        mark = "ok " if b.get("choice") in (row["gold"], *row["accept"]) else "BAD"
        print(f"  {i + 1:>3}/{len(rows)} {mark} {row['id']:<5} gold {row['gold']:<12} got {b.get('choice', ''):<12} "
              f"{b.get('confidence', 0):.2f}  {b.get('tokens', '')} tok  {b.get('ms', '')} ms", flush=True)
    ended = time.monotonic()
    result["wall_s"] = round(ended - started, 1)
    result["power_running_w"] = power.mean(started, ended)
    result["memory_peak_gib"] = round((memory.peak - memory.baseline) / cb.GiB, 2)
    result["rows"] = out
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / f"{tag}.json").write_text(json.dumps(result, indent=1))
    print(f"[{tag}] {len(out)} messages in {result['wall_s']} s; wrote results/{tag}.json", flush=True)


# ---- Report ----

def pct(n: int, d: int) -> str:
    return f"{100 * n / d:.1f}%" if d else "-"


def accuracy(rows, pick, gold, accept=lambda r: ()) -> tuple[int, int, int]:
    """(strict right, lenient right, total): lenient also takes the line's other acceptable labels."""
    strict = sum(pick(r) == gold(r) for r in rows)
    lenient = sum(pick(r) == gold(r) or pick(r) in accept(r) for r in rows)
    return strict, lenient, len(rows)


def confusion(rows, pick, gold, labels) -> list[str]:
    counts = collections.Counter((gold(r), pick(r)) for r in rows)
    lines = ["| gold \\ answer | " + " | ".join(NAMES[l] for l in labels) + " | recall |", "|---" * (len(labels) + 2) + "|"]
    for g in labels:
        n = sum(counts[(g, p)] for p in labels)
        cells = [f"**{counts[(g, p)]}**" if g == p else str(counts[(g, p)] or "·") for p in labels]
        lines.append(f"| {NAMES[g]} | " + " | ".join(cells) + f" | {pct(counts[(g, g)], n)} |")
    precision = []
    for p in labels:
        n = sum(counts[(g, p)] for g in labels)
        precision.append(pct(counts[(p, p)], n))
    lines.append("| precision | " + " | ".join(precision) + " | |")
    return lines


def token_stats(values: list[int]) -> dict:
    s = sorted(values)
    return {"mean": round(statistics.mean(s)), "median": int(statistics.median(s)), "p95": s[min(len(s) - 1, int(0.95 * len(s)))],
            "min": s[0], "max": s[-1]}


def dollars(tokens: float, model: str = "clef-flash") -> str:
    cost = tokens / 1e6 * PRICES[model][0]
    return f"${cost:,.4f}" if cost < 1 else f"${cost:,.2f}"


def report() -> None:
    runs = {p.stem: json.loads(p.read_text()) for p in sorted(RESULTS.glob("*.json"))}
    if not runs:
        raise SystemExit("no results/*.json yet")
    out: list[str] = []
    first = next(iter(runs.values()))
    rows0 = first["rows"]
    n = len(rows0)
    gold_counts = collections.Counter(r["gold"] for r in rows0)
    custom_counts = collections.Counter(r["gold_custom"] for r in rows0 if r["gold_custom"] in ("c1", "c2"))
    out.append("# Inbox categories: Clef benchmark")
    out.append("")
    out.append("How accurately Clef sorts the Inbox into categories, how fast, and what it costs. Every model was "
               "sent the requests the Worker itself sends: [`requests.mts`](../requests.mts) builds them from "
               "[`mail.jsonl`](../mail.jsonl) with the Worker's own code.")
    out.append("")
    out.append("The messages are synthetic: written by an AI model to resemble a typical personal inbox, each with "
               "the category it belongs in. None of them is real mail. Names, email addresses and an IP address in them were "
               "replaced with placeholders after the runs, so a few messages are now slightly longer than when "
               "they were measured.")
    out.append("")
    out.append(f"{n} messages: " + ", ".join(f"{NAMES[k]} {gold_counts[k]}" for k in BUILTIN)
               + f"; with the user's own categories, School {custom_counts['c1']} and Travel {custom_counts['c2']} of them move there.")
    out.append("")

    # Accuracy, every run against the quick guess.
    out.append("## Accuracy")
    out.append("")
    out.append("| | Four built-in categories | lenient | + School, Travel | lenient | School: found / wrongly put there | Travel: found / wrongly |")
    out.append("|---|---|---|---|---|---|---|")
    s, l, t = accuracy(rows0, lambda r: r["guess"], lambda r: r["gold"], lambda r: r["accept"])
    out.append(f"| Quick guess (headers + subject, at ingest) | {pct(s, t)} | {pct(l, t)} | n/a | | | |")
    for tag, res in runs.items():
        rows = res["rows"]
        s, l, t = accuracy(rows, lambda r: r["builtin"]["choice"], lambda r: r["gold"], lambda r: r["accept"])
        cells = [pct(s, t), pct(l, t)]
        if all("custom" in r for r in rows):
            # A line whose `accept` names its own built-in label also takes that in place of the user's category.
            cs, cl, ct = accuracy(rows, lambda r: r["custom"]["choice"], lambda r: r["gold_custom"],
                                  lambda r: r["accept"] if r["gold_custom"] == r["gold"] else [r["gold"]] if r["gold"] in r["accept"] else ())
            cells += [pct(cs, ct), pct(cl, ct)]
            for cid in ("c1", "c2"):
                found = sum(r["custom"]["choice"] == cid for r in rows if r["gold_custom"] == cid)
                total = sum(r["gold_custom"] == cid for r in rows)
                wrong = sum(r["custom"]["choice"] == cid for r in rows if r["gold_custom"] != cid)
                cells.append(f"{found}/{total} / {wrong}")
        out.append(f"| {tag} | " + " | ".join(cells) + " |")
    out.append("")
    out.append("Lenient also counts the second label a line allows where the mail is genuinely ambiguous.")
    out.append("")

    for tag, res in runs.items():
        rows = res["rows"]
        out.append(f"### {tag}: where the built-in answers went")
        out.append("")
        out += confusion(rows, lambda r: r["builtin"]["choice"], lambda r: r["gold"], BUILTIN)
        out.append("")
        # What a threshold would keep. On the top probability, not `confidence`: the open-source code reports
        # that as the confidence, but Workers AI reports a normalized Gini, (K·Σp² − 1)/(K − 1), which runs lower.
        out.append("| top probability ≥ | answers kept | right among kept |")
        out.append("|---|---|---|")
        for th in (0.0, 0.5, 0.7, 0.9):
            kept = [r for r in rows if max(r["builtin"]["probabilities"].values()) >= th]
            right = sum(r["builtin"]["choice"] in (r["gold"], *r["accept"]) for r in kept)
            out.append(f"| {th} | {pct(len(kept), len(rows))} | {pct(right, len(kept))} |")
        out.append("")
    out.append("### The quick guess")
    out.append("")
    out += confusion(rows0, lambda r: r["guess"], lambda r: r["gold"], BUILTIN)
    out.append("")

    tags = list(runs)
    for i, x in enumerate(tags):
        for y in tags[i + 1:]:
            a, b = runs[x]["rows"], runs[y]["rows"]
            same = sum(p["builtin"]["choice"] == q["builtin"]["choice"] for p, q in zip(a, b))
            out.append(f"{x} and {y} give the same built-in answer for {same} of {len(a)} messages.")
    if len(tags) > 1:
        out.append("")

    # Mistakes, for reading.
    for tag, res in runs.items():
        wrong = [r for r in res["rows"] if r["builtin"]["choice"] not in (r["gold"], *r["accept"])]
        out.append(f"### {tag}: wrong built-in answers ({len(wrong)})")
        out.append("")
        out.append("| id | gold | answer | top probability |")
        out.append("|---|---|---|---|")
        for r in wrong:
            out.append(f"| {r['id']} | {NAMES[r['gold']]} | {NAMES[r['builtin']['choice']]} | {max(r['builtin']['probabilities'].values()):.2f} |")
        out.append("")

    # Speed, memory, power.
    out.append("## On this machine")
    out.append("")
    out.append("| | GPU memory, loaded / peak | per message, median / p95 | messages a minute | package power, idle / running | energy per message |")
    out.append("|---|---|---|---|---|---|")
    for tag, res in runs.items():
        if "memory_after_load" not in res:
            continue
        ms = sorted(r["builtin"]["ms"] for r in res["rows"])
        calls = sum(len([k for k in ("builtin", "custom") if k in r]) for r in res["rows"])
        per_call_s = res["wall_s"] / calls
        idle, running = res.get("power_idle_loaded_w"), res.get("power_running_w")
        energy = f"{running * per_call_s:.0f} J ({(running - idle) * per_call_s:.0f} J above idle)" if idle and running else "-"
        out.append(f"| {tag} | {res['memory_after_load']['used_gib']} / {res['memory_peak_gib']} GiB | "
                   f"{statistics.median(ms) / 1e3:.2f} / {ms[int(0.95 * (len(ms) - 1))] / 1e3:.2f} s | {60 / per_call_s:.0f} | "
                   f"{idle} / {running} W | {energy} |")
    out.append("")

    hosted = {tag: res for tag, res in runs.items() if res.get("where") == "workers-ai"}
    if hosted:
        out.append("## On Workers AI")
        out.append("")
        out.append("| | per message in the Worker, median / p95 | round trip from here, median | wall time, all requests |")
        out.append("|---|---|---|---|")
        for tag, res in hosted.items():
            worker = sorted(r[k]["worker_ms"] for r in res["rows"] for k in ("builtin", "custom") if k in r)
            trip = sorted(r[k]["ms"] for r in res["rows"] for k in ("builtin", "custom") if k in r)
            out.append(f"| {tag} | {statistics.median(worker) / 1e3:.2f} / {worker[int(0.95 * (len(worker) - 1))] / 1e3:.2f} s | "
                       f"{statistics.median(trip) / 1e3:.2f} s | {res['wall_s']} s for {len(trip)}, {res.get('concurrency', 1)} at a time |")
        out.append("")
        for tag, res in hosted.items():
            local = next((r for t, r in runs.items() if r.get("model") == res["model"] and r.get("quant") == "bf16"), None)
            if not local:
                continue
            pairs = [(a[k], b[k]) for a, b in zip(local["rows"], res["rows"]) for k in ("builtin", "custom") if k in a and k in b]
            same_tokens = sum(x["tokens"] == y["tokens"] for x, y in pairs)
            same_choice = sum(x["choice"] == y["choice"] for x, y in pairs)
            drift = max(abs(x["probabilities"][o] - y["probabilities"][o]) for x, y in pairs for o in x["probabilities"])
            out.append(f"{tag} against {res['model']} bf16 here: billed tokens equal the local count for {same_tokens} of "
                       f"{len(pairs)} requests; the same answer for {same_choice}; no probability differs by more than {drift:.3f}.")
            out.append("")

    # Tokens and what they would cost.
    res = first
    out.append("## Tokens per message, and what Workers AI would charge")
    out.append("")
    out.append("Workers AI bills input tokens only, and nothing for output: "
               + "; ".join(f"{m} ${price} per million, its 10,000 free neurons a day being {FREE_NEURONS_PER_DAY / neurons:.2f} M tokens"
                           for m, (price, neurons) in PRICES.items()) + ". Both models count the same tokens.")
    out.append("")
    out.append("| request | fixed part | per message: mean | median | p95 | max | $ per 1,000 messages (mean): Clef-Flash | Clef |")
    out.append("|---|---|---|---|---|---|---|---|")
    stats = {}
    for kind, label in (("builtin", "four built-in categories"), ("custom", "+ two of the user's own")):
        if not all(kind in r for r in res["rows"]):
            continue
        st = token_stats([r[kind]["tokens"] for r in res["rows"]])
        stats[kind] = st
        out.append(f"| {label} | {res['fixed_tokens'][kind]} | {st['mean']} | {st['median']} | {st['p95']} | {st['max']} | "
                   f"{dollars(st['mean'] * 1000)} | {dollars(st['mean'] * 1000, 'clef')} |")
    out.append("")
    capped = sum(r["text_chars"] > 1500 for r in res["rows"])
    out.append(f"{capped} of {len(res['rows'])} messages are longer than the 1,500 characters a request carries, so the "
               "longest requests are close to the most any message can cost.")
    out.append("")
    kind = "custom" if "custom" in stats else "builtin"
    per = stats[kind]["mean"]
    # Real newsletters and promotions mostly run past the cut; a message at it is the most any can cost.
    at_cap = [r[kind]["tokens"] for r in res["rows"] if r["text_chars"] > 1500]
    cap = round(statistics.mean(at_cap)) if at_cap else stats[kind]["max"]
    out.append(f"A mailbox, with two own categories: at this set's mean of {per} tokens a message, and, more cautiously, "
               f"with every message as long as the cut lets one be ({cap} tokens, the mean of those that reach it).")
    out.append("")
    for m in PRICES:
        out.append(f"### {m}")
        out.append("")
        out.append("| mail a day | tokens a month | $ a month | the 180-day window (the first sweep, or after a category change) | $ for it | the free daily allowance used |")
        out.append("|---|---|---|---|---|---|")
        free_tokens = FREE_NEURONS_PER_DAY / PRICES[m][1] * 1e6
        for daily in (20, 50, 150, 500):
            cells = []
            for column in (lambda t: f"{daily * 30 * t / 1e6:.2f} M", lambda t: dollars(daily * 30 * t, m),
                           lambda t: f"{daily * 180 * t / 1e6:.2f} M", lambda t: dollars(daily * 180 * t, m),
                           lambda t: pct(daily * t, free_tokens)):
                cells.append(f"{column(per)} – {column(cap)}")
            out.append(f"| {daily} | " + " | ".join(cells) + " |")
        out.append("")
    text = "\n".join(out)
    (RESULTS / "REPORT.md").write_text(text + "\n")
    print(text)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", default="clef-flash", choices=list(PRICES))
    parser.add_argument("--quant", default="bf16", choices=["bf16", "nf4"])
    parser.add_argument("--runs", default="builtin,custom")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--tag")
    parser.add_argument("--report", action="store_true")
    args = parser.parse_args()
    if args.report:
        return report()
    run(args)


if __name__ == "__main__":
    main()
