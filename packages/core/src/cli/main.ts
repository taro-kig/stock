import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Judgment } from "../ai/judge.ts";
import { loadConfig } from "../config.ts";
import type { Scorecard } from "../eval/scorecard.ts";
import type { AccountState, Fill } from "../execution/paper.ts";
import { builtinRegistry } from "../nodes/index.ts";
import { Services } from "../services.ts";
import type { Proposal } from "../strategy/portfolio.ts";
import { assertIsoDate, weekdays } from "../util/dates.ts";
import { Engine, type RunResult } from "../workflow/engine.ts";
import type { NodeRunRow } from "../workflow/runStore.ts";
import { loadWorkflow, toGraph, validateWorkflow, WorkflowError, WorkflowSpec } from "../workflow/spec.ts";
import { c, money, num, pct, status, table } from "./format.ts";

const HELP = `stockai — mid-term AI trading workflows

Usage:
  stockai nodes [--json]                         list node types (ports, params)
  stockai validate <workflow.yaml>...            check workflows
  stockai graph <workflow.yaml>                  graph JSON (for the node UI)
  stockai run <workflow.yaml> [--as-of DATE]     run once (default: today)
  stockai run <workflow.yaml> --from D --to D [--step N]   replay past weekdays
  stockai resume <runId>                         continue a paused/failed run
  stockai approve <runId> <node> [--reject] [--note TEXT]
  stockai runs [--limit N] [--workflow NAME]     recent runs
  stockai show <runId> [--json]                  node table + key outputs
  stockai events <runId>                         run event log (JSON lines)

Options:
  --config PATH   default config/config.yaml (falls back to config/config.example.yaml)
  --fake          offline heuristic models: no API keys, no cost`;

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    config: { type: "string" },
    fake: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    "as-of": { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    step: { type: "string", default: "1" },
    reject: { type: "boolean", default: false },
    note: { type: "string", default: "" },
    limit: { type: "string", default: "20" },
    workflow: { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

function services(): Services {
  let path = opt.config ?? "config/config.yaml";
  if (!opt.config && !existsSync(path)) {
    path = "config/config.example.yaml";
    console.error(c.dim(`(using ${path}; copy it to config/config.yaml to customise)`));
  }
  return new Services(loadConfig(path), { fake: opt.fake });
}

const engineFor = (s: Services) => new Engine({ services: s, registry: builtinRegistry(), store: s.runStore });

function summaryText(summary: Record<string, unknown>): string {
  return Object.entries(summary)
    .map(([port, v]) => {
      const s = v as { kind?: string; length?: number; keys?: number; value?: unknown };
      return `${port}:${s.length ?? s.keys ?? String(s.value)}`;
    })
    .join(" ");
}

function metricsText(m: Record<string, number>): string {
  return Object.entries(m)
    .map(([k, v]) => `${k}=${Number.isInteger(v) ? v : v.toFixed(4)}`)
    .join(" ");
}

function nodeTable(nodes: NodeRunRow[]): string {
  return table(
    ["", "node", "type", "ms", "output", "metrics / error"],
    nodes.map((n) => [
      status(n.status),
      n.nodeId,
      c.dim(n.type),
      String(Math.round(n.durationMs)),
      summaryText(n.summary),
      n.error ? c.red(n.error.slice(0, 70)) : metricsText(n.metrics),
    ]),
    { right: [3] },
  );
}

type Outputs = Pick<RunResult, "output" | "nodes">;

function tryOutput<T>(r: Pick<RunResult, "output">, node: string, port: string): T | undefined {
  try {
    return r.output<T>(node, port);
  } catch {
    return undefined;
  }
}

const stanceText = (s: string) => (s === "bullish" ? c.green(s) : s === "bearish" ? c.red(s) : c.dim(s));

/** Prints the outputs a human cares about, chosen by port type. */
function printHighlights(spec: WorkflowSpec, r: Outputs): void {
  const reg = builtinRegistry();
  for (const [id, cfg] of Object.entries(spec.nodes)) {
    const def = reg.get(cfg.use);
    const st = r.nodes[id]?.status;
    if (!def || !st || !["ok", "cached", "fallback"].includes(st)) continue;
    for (const [port, decl] of Object.entries(def.outputs)) {
      const v = tryOutput<unknown>(r, id, port);
      if (v === undefined) continue;
      if (decl.type === "Judgments" && cfg.use === "decide.ai") printJudgments(id, v as Record<string, Judgment>);
      else if (decl.type === "Proposals" && cfg.use === "gate.approval") printOrders(id, v as Proposal[]);
      else if (decl.type === "Fills") printFills(id, v as Fill[]);
      else if (decl.type === "Account" && cfg.use === "broker.paper") printAccount(v as AccountState);
      else if (decl.type === "Scorecard") printScorecard(v as Scorecard);
    }
  }
}

function printJudgments(id: string, judgments: Record<string, Judgment>): void {
  const js = Object.values(judgments);
  if (!js.length) return;
  console.log(`\n${c.bold(`${id} — AI judgments`)}`);
  console.log(
    table(
      ["ticker", "stance", "conv", "status", "agree", "thesis / veto / rejected votes"],
      js.map((j) => {
        const rejected = j.votes.filter((x) => x.rejected).map((x) => `${x.provider}: ${x.rejected}`).join("; ");
        return [j.ticker, stanceText(j.stance), num(j.conviction), j.status, pct(j.agreement, 0), (j.vetoReason ?? rejected) || j.thesis].map((s) => s.slice(0, 90));
      }),
      { right: [2, 4] },
    ),
  );
}

function printOrders(id: string, ps: Proposal[]): void {
  console.log(`\n${c.bold(`${id} — orders`)} ${ps.length ? "" : c.dim("(none)")}`);
  if (!ps.length) return;
  console.log(
    table(
      ["side", "ticker", "shares", "price", "stop", "reason"],
      ps.map((p) => [p.action === "buy" ? c.green("BUY") : c.red("SELL"), p.ticker, String(p.shares), num(p.price, 1), num(p.stop, 1), p.reason]),
      { right: [2, 3, 4] },
    ),
  );
}

function printFills(id: string, fs: Fill[]): void {
  if (!fs.length) return;
  console.log(`\n${c.bold(`${id} — fills`)}`);
  console.log(table(["side", "ticker", "shares", "price", "fee"], fs.map((f) => [f.side, f.ticker, String(f.shares), num(f.price, 1), num(f.fee, 0)]), { right: [2, 3, 4] }));
}

function printAccount(a: AccountState): void {
  const held = Object.values(a.positions).map((p) => `${p.ticker}×${p.shares}`).join(", ") || "—";
  console.log(`\n${c.bold(`account ${a.account}`)}  equity ${money(a.equity)} ${a.currency}  cash ${money(a.cash)}  peak ${money(a.peakEquity)}  mode ${a.mode}  holdings ${held}`);
}

function printScorecard(s: Scorecard): void {
  const cards = Object.values(s.labels);
  if (!cards.length) return;
  console.log(`\n${c.bold(`scorecard — ${s.horizonDays}-day horizon, as of ${s.asOf}`)}`);
  console.log(
    table(
      ["label", "preds", "coverage", "graded", "hit", "nEff", "hit(eff)", "wilson↓", "excess bull", "excess bear", "promotion"],
      cards.map((k) => [
        k.label, String(k.total), pct(k.coverage, 0), String(k.graded), pct(k.hitRate), String(k.nEff), pct(k.hitRateEff), pct(k.wilsonLow),
        pct(k.meanExcessBullish, 2), pct(k.meanExcessBearish, 2), k.promotion.eligible ? c.green("eligible") : c.dim(k.promotion.reason),
      ]),
      { right: [1, 2, 3, 4, 5, 6, 7, 8, 9] },
    ),
  );
}

function printRun(r: Pick<RunResult, "workflow" | "asOf" | "status" | "runId">, nodes: NodeRunRow[]): void {
  console.log(`${c.bold(r.workflow)}  as of ${r.asOf}  ${status(r.status)}  ${c.dim(r.runId)}`);
  console.log(nodeTable(nodes));
}

async function cmdRun(file: string): Promise<void> {
  const spec = loadWorkflow(file);
  const s = services();
  const engine = engineFor(s);
  if (opt.from || opt.to) {
    if (!opt.from || !opt.to) throw new Error("--from and --to go together");
    if (!s.fake) console.error(c.yellow("warning: replaying the past with real LLMs is optimistic — models may know what happened (DESIGN §9)."));
    let last: RunResult | undefined;
    for (const d of weekdays(assertIsoDate(opt.from), assertIsoDate(opt.to), Number(opt.step))) {
      last = await engine.run(spec, { asOf: d });
      const acct = tryOutput<AccountState>(last, "execute", "account");
      const fills = tryOutput<Fill[]>(last, "execute", "fills") ?? [];
      console.log(`${d}  ${status(last.status).padEnd(12)}  fills ${String(fills.length).padStart(2)}  equity ${acct ? money(acct.equity) : "—"}  ${c.dim(last.runId)}`);
      if (last.status === "waiting") {
        console.log(c.magenta("paused at an approval gate — use gate mode auto for replays"));
        break;
      }
    }
    if (last) printHighlights(spec, last);
    return;
  }
  const r = await engine.run(spec, { asOf: opt["as-of"] ? assertIsoDate(opt["as-of"]) : undefined });
  if (opt.json) return void console.log(JSON.stringify({ runId: r.runId, status: r.status, nodes: r.nodes }, null, 2));
  printRun(r, Object.values(r.nodes));
  printHighlights(spec, r);
  for (const w of Object.values(r.nodes).filter((n) => n.status === "waiting")) {
    console.log(`\n${c.magenta("◌")} ${w.nodeId}: ${w.error}\n  stockai approve ${r.runId} ${w.nodeId}   (or --reject)\n  stockai resume ${r.runId}`);
  }
  if (r.status === "failed") process.exitCode = 1;
}

async function main(): Promise<void> {
  const [cmd, ...args] = positionals;
  if (!cmd || opt.help) return void console.log(HELP);
  switch (cmd) {
    case "nodes": {
      const d = builtinRegistry().describe();
      if (opt.json) return void console.log(JSON.stringify(d, null, 2));
      const ports = (p: Record<string, { type: string; optional?: boolean }>) =>
        Object.entries(p).map(([k, v]) => `${k}:${v.type}${v.optional ? "?" : ""}`).join(", ") || "—";
      return void console.log(table(["type", "category", "inputs", "outputs", "cache"], d.map((n) => [c.bold(n.type), n.category, ports(n.inputs), ports(n.outputs), n.cache])));
    }
    case "validate": {
      let bad = 0;
      for (const f of args) {
        try {
          const problems = validateWorkflow(loadWorkflow(f), builtinRegistry());
          console.log(problems.length ? `${c.red("✕")} ${f}\n  - ${problems.join("\n  - ")}` : `${c.green("✓")} ${f}`);
          if (problems.length) bad++;
        } catch (e) {
          console.log(`${c.red("✕")} ${f}\n  ${e instanceof Error ? e.message : String(e)}`);
          bad++;
        }
      }
      if (bad) process.exitCode = 1;
      return;
    }
    case "graph":
      return void console.log(JSON.stringify(toGraph(loadWorkflow(args[0] ?? ""), builtinRegistry()), null, 2));
    case "run":
      return cmdRun(args[0] ?? "");
    case "resume": {
      const s = services();
      const run = s.runStore.getRun(args[0] ?? "");
      if (!run) throw new Error(`unknown run ${args[0]}`);
      const r = await engineFor(s).resume(run.runId);
      printRun(r, Object.values(r.nodes));
      printHighlights(WorkflowSpec.parse(JSON.parse(run.specJson)), r);
      return;
    }
    case "approve": {
      const [runId, node] = args;
      if (!runId || !node) throw new Error("usage: stockai approve <runId> <node> [--reject]");
      const s = services();
      if (!s.runStore.getRun(runId)) throw new Error(`unknown run ${runId}`);
      s.runStore.setApproval(runId, node, opt.reject ? "reject" : "approve", opt.note);
      return void console.log(`${opt.reject ? c.red("rejected") : c.green("approved")} ${runId} ${node} — now: stockai resume ${runId}`);
    }
    case "runs": {
      const rows = services().runStore.listRuns(Number(opt.limit), opt.workflow);
      return void console.log(table(["run", "workflow", "as of", "status", "created"], rows.map((r) => [r.runId, r.workflow, r.asOf, status(r.status), r.createdAt.slice(0, 19)])));
    }
    case "show": {
      const s = services();
      const run = s.runStore.getRun(args[0] ?? "");
      if (!run) throw new Error(`unknown run ${args[0]}`);
      const nodes = s.runStore.nodeRuns(run.runId);
      if (opt.json) return void console.log(JSON.stringify({ run, nodes }, null, 2));
      printRun(run, nodes);
      const byId = Object.fromEntries(nodes.map((n) => [n.nodeId, n]));
      printHighlights(WorkflowSpec.parse(JSON.parse(run.specJson)), {
        nodes: byId,
        output: <T,>(id: string, port: string) => s.runStore.getArtifact(byId[id]?.outputs[port] ?? "") as T,
      });
      return;
    }
    case "events":
      for (const e of services().runStore.events(args[0] ?? "")) console.log(JSON.stringify(e));
      return;
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  console.error(c.red(e instanceof WorkflowError ? e.message : e instanceof Error ? (e.stack ?? e.message) : String(e)));
  process.exitCode = 1;
});
