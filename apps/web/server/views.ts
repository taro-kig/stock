import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
  defaultMarketId, loadWorkflow, MARKET_LABEL, type MarketId, toGraph, toIsoDate, validateWorkflow, workflowMarket, WorkflowSpec,
  type AccountState, latestFactorReport as coreLatestFactorReport, type Fill, type Judgment, type NodeRegistry, type NodeRunRow, type OrderTicket, type Proposal, type RunRow, type Scorecard, type Services,
  type UniverseChanges,
} from "@stockai/core";
import type { EquitySeries, Highlights, NodeView, RunDetail, RunSummary, WaitingGate, WorkflowInfo } from "../shared/types.ts";

const OK = new Set(["ok", "cached", "fallback"]);

export const summary = (r: RunRow): RunSummary => ({
  runId: r.runId, workflow: r.workflow, asOf: r.asOf, status: r.status, createdAt: r.createdAt, finishedAt: r.finishedAt,
});

export interface WorkflowFile {
  name: string;
  file: string;
  spec: WorkflowSpec | null;
  error: string | null;
}

export function discoverWorkflows(dir: string): WorkflowFile[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml")).sort();
  } catch {
    return [];
  }
  return files.map((f) => {
    const file = join(dir, f);
    try {
      const spec = loadWorkflow(file);
      return { name: spec.name, file, spec, error: null };
    } catch (e) {
      return { name: f.replace(/\.ya?ml$/, ""), file, spec: null, error: e instanceof Error ? e.message : String(e) };
    }
  });
}

export function workflowInfo(w: WorkflowFile, s: Services, registry: NodeRegistry): WorkflowInfo {
  const last = s.runStore.listRuns(1, w.name)[0];
  return {
    name: w.name, file: w.file, description: w.spec?.description ?? "",
    problems: w.spec ? validateWorkflow(w.spec, registry) : [w.error ?? "unreadable"],
    nodeCount: w.spec ? Object.keys(w.spec.nodes).length : 0,
    lastRun: last ? summary(last) : null,
    disabled: s.runStore.disabled(w.name),
    ...marketOf(w, s, registry),
  };
}

/** The market a workflow runs in: from its nodes, else the default market (as the engine decides). */
export function runMarketOf(spec: WorkflowSpec | null, s: Services, registry: NodeRegistry): MarketId {
  return (spec ? workflowMarket(Object.values(spec.nodes).map((n) => n.use), registry) : null) ?? defaultMarketId(s.config);
}

function marketOf(w: WorkflowFile, s: Services, registry: NodeRegistry): Pick<WorkflowInfo, "market" | "marketMismatch"> {
  const market = w.spec ? workflowMarket(Object.values(w.spec.nodes).map((n) => n.use), registry) : null;
  const empty = market && !s.watchlistFor(market).tickers.length && !Object.keys(s.heldTickers(market)).length;
  return {
    market,
    marketMismatch: empty
      ? `${MARKET_LABEL[market]}用のワークフローですが、ウォッチリストに${MARKET_LABEL[market]}がありません。「6 銘柄」で${MARKET_LABEL[market]}を追加すると動きます`
      : null,
  };
}

/** DAG column = longest path from a source node. */
function layers(spec: WorkflowSpec): Record<string, number> {
  const memo: Record<string, number> = {};
  const deps = (id: string) => [...new Set([...Object.values(spec.nodes[id]!.in).map((r) => r.split(".")[0]!), ...spec.nodes[id]!.after])];
  const depth = (id: string, seen: Set<string>): number => {
    if (id in memo) return memo[id]!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const ds = deps(id).filter((d) => d in spec.nodes);
    return (memo[id] = ds.length ? 1 + Math.max(...ds.map((d) => depth(d, seen))) : 0);
  };
  for (const id of Object.keys(spec.nodes)) depth(id, new Set());
  return memo;
}

function artifact<T>(s: Services, row: NodeRunRow | undefined, port: string): T | undefined {
  const h = row?.outputs[port];
  if (!h || !OK.has(row.status)) return undefined;
  try {
    return s.runStore.getArtifact(h) as T;
  } catch {
    return undefined;
  }
}

export function runDetail(s: Services, registry: NodeRegistry, run: RunRow): RunDetail {
  const spec = WorkflowSpec.parse(JSON.parse(run.specJson));
  const graph = toGraph(spec, registry);
  const rows = Object.fromEntries(s.runStore.nodeRuns(run.runId).map((n) => [n.nodeId, n]));
  const layer = layers(spec);
  const logs: Record<string, string[]> = {};
  for (const e of s.runStore.events(run.runId)) {
    if (e.type !== "log" || !("node" in e) || typeof e.node !== "string") continue;
    (logs[e.node] ??= []).push(String((e as { message?: unknown }).message ?? ""));
  }
  const nodes: NodeView[] = graph.nodes.map((n) => {
    const r = rows[n.id];
    return {
      id: n.id, type: n.type, title: n.title, category: n.category,
      status: r?.status ?? (run.status === "running" ? "queued" : "pending"),
      durationMs: r?.durationMs ?? 0, error: r?.error ?? null, metrics: r?.metrics ?? {}, summary: r?.summary ?? {},
      layer: layer[n.id] ?? 0, params: n.params, onError: n.onError,
      inputs: n.inputs.map((i) => ({ ...i, from: graph.edges.find((e) => e.to.node === n.id && e.to.port === i.name)?.from ?? null })),
      outputs: n.outputs,
      logs: (logs[n.id] ?? []).slice(-40),
    };
  });

  const h: Highlights = {};
  const waiting: WaitingGate[] = [];
  for (const [id, cfg] of Object.entries(spec.nodes)) {
    const row = rows[id];
    switch (cfg.use) {
      case "decide.ai":
      case "decide.rules": {
        const js = artifact<Record<string, Judgment>>(s, row, "judgments");
        if (js && (!h.judgments || cfg.use === "decide.ai")) h.judgments = { node: id, source: cfg.use === "decide.ai" ? "ai" : "rules", items: Object.values(js) };
        break;
      }
      case "portfolio.propose": {
        const ps = artifact<Proposal[]>(s, row, "proposals");
        if (ps && !h.proposals) h.proposals = { node: id, approved: false, items: ps };
        break;
      }
      case "gate.approval": {
        const ps = artifact<Proposal[]>(s, row, "proposals");
        if (ps) h.proposals = { node: id, approved: true, items: ps };
        if (row?.status === "waiting") {
          const ref = cfg.in["proposals"]?.split(".") ?? [];
          const src = rows[ref[0] ?? ""];
          waiting.push({ node: id, message: row.error ?? "awaiting approval", proposals: artifact<Proposal[]>(s, src, ref[1] ?? "proposals") ?? [] });
        }
        break;
      }
      case "universe.review": {
        const c = artifact<UniverseChanges>(s, row, "changes");
        if (c && !h.universe) h.universe = { node: id, applied: false, changes: c };
        break;
      }
      case "universe.apply": {
        const c = artifact<UniverseChanges>(s, row, "changes");
        if (c) h.universe = { node: id, applied: true, changes: c };
        if (row?.status === "waiting") {
          const ref = cfg.in["changes"]?.split(".") ?? [];
          const pending = artifact<UniverseChanges>(s, rows[ref[0] ?? ""], ref[1] ?? "changes");
          waiting.push({ node: id, message: row.error ?? "awaiting approval", proposals: [], ...(pending ? { changes: pending } : {}) });
        }
        break;
      }
      case "broker.paper": {
        h.fills = artifact<Fill[]>(s, row, "fills") ?? h.fills;
        h.account = artifact<AccountState>(s, row, "account") ?? h.account;
        break;
      }
      case "broker.ibkr":
      case "broker.webull":
        h.orders = artifact<OrderTicket[]>(s, row, "orders") ?? h.orders;
        break;
      case "portfolio.account":
      case "portfolio.ibkrAccount":
      case "portfolio.webullAccount":
        h.account ??= artifact<AccountState>(s, row, "account");
        break;
      case "eval.scorecard":
        h.scorecard = artifact<Scorecard>(s, row, "scorecard") ?? h.scorecard;
        break;
    }
  }
  const names = Object.fromEntries(Object.keys(s.config.watchlist).map((t) => [t, s.watchlist.name(t)]));
  return { run: summary(run), currency: s.market(runMarketOf(spec, s, registry)).currency, description: spec.description, nodes, edges: graph.edges, highlights: h, waiting, names };
}

/** Scorecard with the latest as-of date among recent runs (replays of old dates do not win). */
export function latestScorecard(s: Services): Scorecard | null {
  let best: Scorecard | null = null;
  for (const run of s.runStore.listRuns(150)) {
    if (best && run.asOf <= best.asOf) continue;
    const spec = WorkflowSpec.safeParse(JSON.parse(run.specJson));
    if (!spec.success) continue;
    const ids = Object.entries(spec.data.nodes).filter(([, c]) => c.use === "eval.scorecard").map(([id]) => id);
    if (!ids.length) continue;
    const rows = s.runStore.nodeRuns(run.runId);
    for (const id of ids) {
      const card = artifact<Scorecard>(s, rows.find((r) => r.nodeId === id), "scorecard");
      if (card && (!best || card.asOf > best.asOf)) best = card;
    }
  }
  return best;
}

/** The newest factor research report (eval.factors), with the run it came from. */
export const latestFactorReport = (s: Services) => coreLatestFactorReport(s);

export function equitySeries(s: Services): EquitySeries[] {
  return [
    ...s.paperBook.equityHistory().map((e) => ({ account: e.account, kind: "paper" as const, currency: e.currency, points: e.points })),
    ...s.brokerLedger.equityHistory().map((e) => ({ account: e.account, kind: "broker" as const, currency: null, points: e.points })),
  ];
}

export function ranToday(s: Services, workflow: string, clock: () => Date): RunSummary | null {
  const today = toIsoDate(clock());
  const r = s.runStore.listRuns(20, workflow).find((x) => x.asOf === today);
  return r ? summary(r) : null;
}
