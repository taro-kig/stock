import { existsSync, unlinkSync } from "node:fs";
import { runSmoke, smokeMarkdown } from "../smoke.ts";
import { buildReport } from "../report.ts";
import { parseArgs } from "node:util";
import type { Judgment } from "../ai/judge.ts";
import { loadConfig } from "../config.ts";
import type { Scorecard } from "../eval/scorecard.ts";
import type { OrderTicket } from "../execution/broker.ts";
import { WebullClient } from "../execution/webull.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EvalReport } from "../eval/promptEval.ts";
import { runPromptEval } from "../prompts/evaluate.ts";
import type { AccountState, Fill } from "../execution/paper.ts";
import { builtinRegistry } from "../nodes/index.ts";
import { Services } from "../services.ts";
import type { Proposal } from "../strategy/portfolio.ts";
import { assertIsoDate, weekdays } from "../util/dates.ts";
import { Engine, type RunResult } from "../workflow/engine.ts";
import type { NodeRunRow } from "../workflow/runStore.ts";
import { loadWorkflow, toGraph, validateWorkflow, WorkflowError, WorkflowSpec } from "../workflow/spec.ts";
import { loadDotEnv } from "../util/env.ts";
import { assertSettingName, SettingsStore, settingDefs } from "../util/settings.ts";
import { backupDir, listBackups, runBackup } from "../util/backup.ts";
import { runDoctor, STATUS_MARK } from "../doctor.ts";
import { usTradingDays } from "../util/marketCalendar.ts";
import { c, money, num, pct, status, table } from "./format.ts";
import { defaultMarketId, marketTradingDays } from "../markets.ts";
import { workflowMarket } from "../workflow/registry.ts";

const HELP = `stockai — mid-term AI trading workflows

Usage:
  stockai nodes [--json]                         list node types (ports, params)
  stockai validate <workflow.yaml>...            check workflows
  stockai graph <workflow.yaml>                  graph JSON (for the node UI)
  stockai run <workflow.yaml> [--as-of DATE]     run once (default: today)
  stockai run <workflow.yaml> --from D --to D [--step N]   replay past weekdays
  stockai resume <runId>                         continue a paused/failed run
  stockai disable <workflow> [--note TEXT]       stop a workflow from running (schedule, UI, CLI); name or .yaml path
  stockai enable <workflow>                      allow it again
  stockai approve <runId> <node> [--reject] [--note TEXT]
  stockai runs [--limit N] [--workflow NAME]     recent runs
  stockai show <runId> [--json]                  node table + key outputs
  stockai events <runId>                         run event log (JSON lines)
  stockai eval events [--versions event-us-v1] [--models a,b] [--ensemble] [--set PATH] [--budget USD]
                                                 (defaults follow the market: USD → events-us.yaml + event-us-*)
  stockai eval judge  [--versions judge-v1,judge-v2] [--models a,b] [--set PATH] [--budget USD]
                                                 score prompts/models on a golden set (report saved under data/evals)
  stockai webull auth [--wait SECONDS]           approve API access in the Webull app (2FA)
  stockai webull check                           read-only: accounts, cash, positions
  stockai doctor [--run WORKFLOW]                connection check: one small real request per service (keys, data, LLM, notify);
                                                 --run also runs that workflow for today and shows its nodes
  stockai smoke [--workflow PATH] [--skip workflow,screen,research]
                                                 end-to-end check with real data on a copy of the database
                                                 (connection check, today's AI workflow, a small screen, a small factor research);
                                                 writes a shareable report (keys masked) to <dataDir>/smoke/
  stockai report [--days 7]                      what happened over the last days (accounts, trades, judgments, accuracy,
                                                 failures with log lines, LLM spend) as Markdown on stdout, also saved to
                                                 <dataDir>/reports/ (keys and broker account numbers masked)
  stockai backup [--list]                        snapshot the database now (the web server also does it daily)
  stockai settings                               API keys and where each comes from (shell / settings / .env)
  stockai settings set NAME                      store a value (read from stdin, not echoed) in <dataDir>/settings.sqlite
  stockai settings clear NAME                    remove a stored value

Options:
  --config PATH   default config/config.yaml (falls back to config/config.example.yaml)
  --fake          offline heuristic models: no API keys, no cost`;

const dotenv = loadDotEnv();
for (const w of dotenv.warnings) console.error(`warning: ${w}`);

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
    wait: { type: "string", default: "300" },
    versions: { type: "string" },
    models: { type: "string" },
    ensemble: { type: "boolean", default: false },
    set: { type: "string" },
    budget: { type: "string", default: "0.5" },
    list: { type: "boolean", default: false },
    run: { type: "string" },
    skip: { type: "string" },
    days: { type: "string", default: "7" },
    help: { type: "boolean", short: "h", default: false },
  },
});

function services(): Services {
  let path = opt.config ?? "config/config.yaml";
  if (!opt.config && !existsSync(path)) {
    path = "config/config.example.yaml";
    console.error(c.dim(`(using ${path}; copy it to config/config.yaml to customise)`));
  }
  const config = loadConfig(path);
  // Keys saved from the web UI's settings screen (shell > settings > .env).
  const settings = new SettingsStore({ path: join(config.dataDir, "settings.sqlite"), shellKeys: dotenv.shellKeys });
  return new Services(config, { fake: opt.fake, settings, configPath: path });
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
      else if (decl.type === "Orders") printBrokerOrders(id, v as OrderTicket[]);
      else if (decl.type === "Account" && ["broker.paper", "portfolio.ibkrAccount", "portfolio.webullAccount"].includes(cfg.use)) printAccount(v as AccountState);
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

function printBrokerOrders(id: string, os: OrderTicket[]): void {
  if (!os.length) return;
  const st = (s: string) => (s === "submitted" ? c.green(s) : s === "blocked" || s === "error" ? c.red(s) : c.dim(s));
  console.log(`\n${c.bold(`${id} — broker orders`)}`);
  console.log(
    table(
      ["status", "side", "ticker", "shares", "limit", "broker id", "ref / message"],
      os.map((o) => [st(o.status), o.side, o.ticker, String(o.shares), num(o.limitPrice, 2), o.brokerOrderId === null ? "—" : String(o.brokerOrderId), `${o.ref}  ${c.dim(o.message)}`]),
      { right: [3, 4] },
    ),
  );
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
    // the workflow market's trading days (NYSE or TSE holidays skipped)
    const market = workflowMarket(Object.values(spec.nodes).map((n) => n.use), builtinRegistry()) ?? defaultMarketId(s.config);
    for (const d of marketTradingDays(market, assertIsoDate(opt.from), assertIsoDate(opt.to), Number(opt.step))) {
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

function printEval(r: EvalReport): void {
  const pc = (x: number) => pct(x, 0);
  console.log(`${c.bold(`eval ${r.task}`)}  set ${r.set}  ${r.reviewedShare < 1 ? c.yellow(`labels reviewed ${pc(r.reviewedShare)} (draft)`) : c.green("labels reviewed")}`);
  if (r.stoppedByBudget) console.log(c.red("stopped: eval budget reached (--budget)"));
  const fieldCols = r.task === "events" ? ["relevant", "eventType", "direction", "materiality", "tickers"] : [];
  console.log(
    table(
      ["version", "model", "n", "schema ok", "accepted", "correct", "accuracy", ...fieldCols, ...(r.task === "judge" ? ["bull/bear/neu/abs", "misread"] : []), "cost", "tokens in/out"],
      r.rows.map((x) => [
        x.version, x.model, String(x.n), pc(x.schemaOk / x.n), pc(x.accepted / x.n), String(x.correct), c.bold(pc(x.accuracy)),
        ...fieldCols.map((f) => (x.fields[f]?.total ? pc(x.fields[f]!.right / x.fields[f]!.total) : "—")),
        ...(r.task === "judge" ? [`${x.extra?.["bullish"] ?? 0}/${x.extra?.["bearish"] ?? 0}/${x.extra?.["neutral"] ?? 0}/${x.extra?.["abstain"] ?? 0}`, String(x.extra?.["misread"] ?? 0)] : []),
        `$${x.costUsd.toFixed(4)}`, `${x.inputTokens}/${x.outputTokens}`,
      ]),
      { right: [2, 3, 4, 5, 6] },
    ),
  );
  if (r.ensemble.length) {
    console.log(c.bold("\nensemble (what production would accept)"));
    console.log(table(["version", "members", "coverage", "precision", "accepted", "correct", "cost"], r.ensemble.map((e) => [e.version, e.members, pc(e.coverage), c.bold(pc(e.precision)), String(e.accepted), String(e.correctAccepted), `$${e.costUsd.toFixed(4)}`]), { right: [2, 3, 4, 5] }));
  }
  for (const x of r.rows) {
    if (!x.failures.length) continue;
    console.log(c.dim(`\n${x.version} ${x.model} — misses (${x.failures.length})`));
    for (const f of x.failures.slice(0, 8)) console.log(`  ${f.id}: ${c.dim(f.reason.slice(0, 140))}`);
  }
}

async function cmdEval(task: string): Promise<void> {
  if (task !== "events" && task !== "judge") throw new Error("usage: stockai eval events|judge");
  const s = services();
  const list = (csv: string | undefined) => csv?.split(",").map((x) => x.trim()).filter(Boolean);
  const report = await runPromptEval(s, {
    family: task === "events" ? "event" : "judge",
    ...(list(opt.versions) ? { versions: list(opt.versions)! } : {}),
    ...(list(opt.models) ? { models: list(opt.models)! } : {}),
    ensemble: opt.ensemble,
    budgetUsd: Number(opt.budget),
    ...(opt.set ? { set: opt.set } : {}),
    onProgress: (m: string) => void (process.stderr.isTTY && process.stderr.write(`\r\x1b[2K${c.dim(m)}`)),
  });
  if (process.stderr.isTTY) process.stderr.write("\r\x1b[2K");
  const dir = join(s.config.dataDir, "evals");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${report.createdAt.replace(/[-:.]/g, "").slice(0, 15)}-${task}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  if (opt.json) return void console.log(JSON.stringify(report, null, 2));
  printEval(report);
  console.log(c.dim(`\nreport: ${file}`));
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
    case "eval":
      return cmdEval(args[0] ?? "");
    case "webull": {
      const s = services();
      if (!s.config.webull) throw new Error("config.webull is not set (see docs/webull.md)");
      const client = new WebullClient(s.config.webull, { env: s.env });
      if (args[0] === "auth") {
        await client.ensureToken({
          waitSeconds: Number(opt.wait),
          onPending: () => console.log(c.magenta(`Webull アプリに承認リクエストを送りました。${opt.wait} 秒以内にアプリで承認してください…`)),
        });
        return void console.log(`${c.green("✓")} Webull API のアクセスが有効です（トークン: ${s.config.webull.tokenFile}）`);
      }
      if (args[0] === "check") {
        await client.ensureToken({ waitSeconds: 0 });
        const ids = await client.accountIds();
        const a = await client.account();
        const w = s.config.webull;
        console.log(`accounts ${ids.join(", ")}  using ${c.bold(a.accountId)}  trading ${w.trading === "live" ? c.red("LIVE") : c.green("dry_run (preview only)")}  tax ${w.accountTaxType ?? c.red("unset")}`);
        console.log(`cash ${money(a.cash)} ${a.currency}  net ${money(a.netLiquidation)}`);
        if (a.positions.length) console.log(table(["ticker", "shares", "avg cost"], a.positions.map((p) => [p.ticker, String(p.shares), num(p.avgCost, 1)]), { right: [1, 2] }));
        return;
      }
      throw new Error("usage: stockai webull auth|check");
    }
    case "doctor": {
      const s = services();
      console.error(c.dim("checking… (one small request per service)"));
      const results = await runDoctor(s);
      if (opt.json) return void console.log(JSON.stringify(results, null, 2));
      const color = { ok: c.green, warn: c.yellow, fail: c.red, skip: c.dim };
      console.log(table(["", "check", "result", "fix"], results.map((r) => [color[r.status](STATUS_MARK[r.status]), r.label, r.detail, r.hint && r.status !== "ok" ? c.dim(r.hint) : ""])));
      const bad = results.filter((r) => r.status === "fail").length;
      console.log(bad ? c.red(`\n${bad} 件の問題があります`) : c.green("\n必須の項目はすべて OK"));
      if (opt.run) {
        console.log(c.dim(`\nrunning ${opt.run} for today…`));
        const r = await engineFor(s).run(loadWorkflow(opt.run));
        console.log(`${status(r.status)}  ${r.runId}`);
        console.log(nodeTable(Object.values(r.nodes)));
      }
      if (bad) process.exitCode = 1;
      return;
    }
    case "smoke": {
      // Run against a copy of the database: real records (judgments, approvals, paper account) stay untouched.
      const base = services();
      const dir = join(base.config.dataDir, "smoke");
      mkdirSync(dir, { recursive: true });
      const copy = join(dir, "stockai.sqlite");
      for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) if (existsSync(f)) unlinkSync(f);
      if (existsSync(base.dbPath)) base.db.prepare("VACUUM INTO ?").run(copy);
      const s = new Services(base.config, { fake: opt.fake, settings: base.settings, configPath: base.configPath, dbPath: copy });
      const skip = new Set((opt.skip ?? "").split(",").map((x) => x.trim()).filter(Boolean));
      console.error(c.dim("通し確認を始めます（本物のデータで少しずつ。DB はコピーを使うので実際の記録は変わりません）"));
      const report = await runSmoke(s, {
        workflow: opt.workflow, skipWorkflow: skip.has("workflow"), skipScreen: skip.has("screen"), skipResearch: skip.has("research"),
        log: (m) => console.error(c.dim(m)),
      });
      const stamp = report.at.slice(0, 16).replace(/[-:T]/g, "");
      const file = join(dir, `report-${stamp}.md`);
      writeFileSync(file, smokeMarkdown(report), "utf8");
      const color = { ok: c.green, warn: c.yellow, fail: c.red, skip: c.dim };
      for (const st of report.steps) console.log(`${color[st.status](st.status.padEnd(4))}  ${st.name}  ${c.dim(`${(st.ms / 1000).toFixed(1)}s`)}${st.error ? `  ${c.red(st.error)}` : ""}`);
      console.log(`\n報告: ${file}\nこのファイルの中身を貼ってもらえれば、壊れている所をまとめて直せます（キーやメールは伏せてあります）。`);
      if (report.steps.some((x) => x.status === "fail")) process.exitCode = 1;
      return;
    }
    case "report": {
      const s = services();
      const days = Number(opt.days);
      if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error("--days: 1〜366");
      const md = buildReport(s, { days });
      const dir = join(s.config.dataDir, "reports");
      mkdirSync(dir, { recursive: true });
      const file = join(dir, `report-${new Date().toISOString().slice(0, 10)}-${days}d.md`);
      writeFileSync(file, md, "utf8");
      process.stdout.write(md);
      console.error(c.dim(`\n保存: ${file}（このまま貼って大丈夫ですが、念のため目を通してください）`));
      return;
    }
    case "backup": {
      const s = services();
      if (opt.list) {
        const files = listBackups(backupDir(s.config));
        if (!files.length) return void console.log(c.dim(`no backups in ${backupDir(s.config)}`));
        return void console.log(table(["time", "file", "size"], files.map((f) => [f.at.replace("T", " "), f.name, `${Math.ceil(f.size / 1000)} KB`]), { right: [2] }));
      }
      const f = runBackup(s.config, s.db, s.settings);
      return void console.log(`${c.green("✓")} ${f.file}  ${Math.ceil(f.size / 1000)} KB`);
    }
    case "disable":
    case "enable": {
      const ref = args[0];
      if (!ref) throw new Error(`usage: stockai ${cmd} <workflow name or .yaml>`);
      const name = existsSync(ref) ? loadWorkflow(ref).name : ref;
      const s = services();
      s.runStore.setDisabled(name, cmd === "disable", opt.note);
      return void console.log(cmd === "disable" ? `${c.yellow("⏸")} ${name} を無効にしました（スケジュール・画面・CLI から実行されません）` : `${c.green("▶")} ${name} を有効にしました`);
    }
    case "settings": {
      const s = services();
      const store = s.settings!;
      const name = args[1] ?? "";
      if (args[0] === "set") {
        assertSettingName(name);
        const value = await readSecret(`${name}: `);
        store.set(name, value);
        return void console.log(`${c.green("✓")} ${name} を ${store.path} に保存しました`);
      }
      if (args[0] === "clear") {
        store.clear(name);
        return void console.log(`${c.green("✓")} ${name} を削除しました`);
      }
      if (args[0]) throw new Error("usage: stockai settings [set NAME | clear NAME]");
      const label = { shell: c.yellow("shell"), settings: c.green("settings"), dotenv: c.cyan(".env"), none: c.dim("—") };
      console.log(table(["name", "source", "value", "use"], store.status(settingDefs(s.config)).map((x) => [x.name, label[x.source ?? "none"], x.preview ?? c.dim("未設定"), x.help])));
      return void console.log(c.dim(`settings file: ${store.path}`));
    }
    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

/** Reads one line without echoing it when stdin is a terminal (API keys). */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const ch of stdin) chunks.push(ch as Buffer);
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/)[0] ?? "";
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let buf = "";
    const done = (fn: () => void) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stderr.write("\n");
      fn();
    };
    const onData = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return done(() => resolve(buf));
        if (ch === "\u0003") return done(() => reject(new Error("cancelled")));
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

main().catch((e: unknown) => {
  const debug = Boolean(process.env["STOCKAI_DEBUG"]);
  console.error(c.red(e instanceof Error ? (debug && !(e instanceof WorkflowError) ? (e.stack ?? e.message) : `${e.name === "Error" ? "" : `${e.name}: `}${e.message}`) : String(e)));
  process.exitCode = 1;
});
