/** JSON shapes exchanged between the web server and the UI. */
import type { JournalSummary, Trade, TrackedOrder, MarketContext, EarningsReaction, EarningsResult, Fundamentals, InsiderSummary, NextEarnings, Revision, ModelSpec, Vendor, WatchlistChangeRow, AccountState, EvalJob, Fill, Judgment, NodeDescription, OrderTicket, PromptFamily, PromptInfo, PromptSwitch, Proposal, Scorecard, SettingStatus, UniverseChanges } from "@stockai/core";

export type NodeStatus = "pending" | "ok" | "cached" | "fallback" | "failed" | "skipped" | "waiting" | "queued" | "running";
export type RunStatus = "running" | "succeeded" | "partial" | "failed" | "waiting" | "queued";

export interface RunSummary {
  runId: string;
  workflow: string;
  asOf: string;
  status: RunStatus;
  createdAt: string;
  finishedAt: string | null;
}

export interface PortRef {
  node: string;
  port: string;
}

export interface NodeView {
  id: string;
  type: string;
  title: string;
  category: string;
  status: NodeStatus;
  durationMs: number;
  error: string | null;
  metrics: Record<string, number>;
  summary: Record<string, unknown>;
  /** Column in the DAG (longest path from a source). */
  layer: number;
  params: Record<string, unknown>;
  onError: string;
  inputs: Array<{ name: string; type: string; optional: boolean; from: PortRef | null }>;
  outputs: Array<{ name: string; type: string }>;
  /** What the node wrote while running (per-ticker failures and the like), last 40 lines. */
  logs: string[];
  /** While the node runs: when it started, and how far it is when it reports that (e.g. symbols downloaded). */
  startedAt: string | null;
  progress: { done: number; total: number } | null;
}

export interface EdgeView {
  from: PortRef;
  to: PortRef;
  type: string;
}

export interface Highlights {
  judgments?: { node: string; source: "ai" | "rules"; items: Judgment[] };
  proposals?: { node: string; approved: boolean; items: Proposal[] };
  fills?: Fill[];
  orders?: OrderTicket[];
  account?: AccountState;
  scorecard?: Scorecard;
  /** Proposed (or applied) watchlist changes from universe.review / universe.apply. */
  universe?: { node: string; applied: boolean; changes: UniverseChanges };
}

export interface WaitingGate {
  node: string;
  message: string;
  proposals: Proposal[];
  /** Set for universe.apply gates: watchlist changes instead of orders. */
  changes?: UniverseChanges;
}

export interface RunDetail {
  run: RunSummary;
  currency: "JPY" | "USD";
  description: string;
  nodes: NodeView[];
  edges: EdgeView[];
  highlights: Highlights;
  waiting: WaitingGate[];
  /** ticker -> company name (from the watchlist) */
  names: Record<string, string>;
}

export interface WorkflowInfo {
  name: string;
  file: string;
  description: string;
  problems: string[];
  nodeCount: number;
  lastRun: RunSummary | null;
  /** Set when the workflow is switched off (no scheduled, manual or CLI runs). */
  disabled: { since: string; note: string } | null;
  /** Market the workflow is built for (null: either). */
  market: "us" | "jp" | null;
  /** Set when that market is not the one in config.yaml: running it will not find data for the watchlist. */
  marketMismatch: string | null;
}

export interface ScheduleItem {
  workflow: string;
  file: string;
  at: string;
  days: number[];
  nextAt: string | null;
  ranToday: RunSummary | null;
  disabled: boolean;
}

export interface EquitySeries {
  account: string;
  kind: "paper" | "broker";
  currency: string | null;
  points: Array<[string, number]>;
}

export interface Overview {
  now: string;
  fake: boolean;
  /** Market currency (for amounts that carry no account, like proposed orders). */
  currency: "JPY" | "USD";
  pending: Array<{ run: RunSummary; gates: WaitingGate[]; currency: "JPY" | "USD" }>;
  workflows: WorkflowInfo[];
  recent: RunSummary[];
  equity: EquitySeries[];
  /** All accounts in one currency (set when there are both yen and dollar accounts). */
  combined: { jpy: number | null; usd: number | null; rate: number | null; rateDate: string | null; accounts: number; note: string | null } | null;
  scorecard: Scorecard | null;
  cost: { spentToday: number; dailyLimit: number; byProvider: Array<{ provider: string; calls: number; costUsd: number }> };
  schedule: ScheduleItem[];
  queue: { running: string | null; pending: number };
}

export type NodeCatalog = NodeDescription[];

/** Pushed on /api/stream. */
export type StreamEvent =
  | { type: "hello"; now: string }
  | { type: "queued"; runId: string; workflow: string }
  | { type: "run_event"; runId: string; event: Record<string, unknown> }
  | { type: "workflow_state"; workflow: string; disabled: boolean }
  | { type: "config_changed" }
  | { type: "prompt_eval"; id: number; status: string };

export interface ModelsView {
  /** Registered models (config.yaml models.pool). */
  pool: ModelSpec[];
  /** Pool name → where it is used now ("売買判断（おまかせ）", "daily-ai（ノード）", ...). */
  usedBy: Record<string, string[]>;
  /** Named explicitly (by hand or in a node): cannot be removed. Models picked by "auto" can. */
  locked: string[];
  pricing: Record<string, readonly [number, number]>;
  /** Charged for models without a price (deliberately high). */
  fallbackPrice: number[];
  vendors: Array<Vendor & { keySet: boolean }>;
  dailyBudgetUsd: number;
  editable: boolean;
  file: string | null;
  fake: boolean;
}

export interface SettingsView {
  /** False when the server was started without a settings store (tests, embedded use). */
  available: boolean;
  path: string | null;
  items: SettingStatus[];
}

export interface ImportResult {
  name: string;
  file: string;
  created: boolean;
  /** Validation problems: the file is saved as a draft but cannot run until fixed. */
  problems: string[];
}

export interface WatchlistView {
  watchlist: Record<string, { name: string; aliases: string[]; sector: string; market?: "us" | "jp" | undefined }>;
  /** Benchmark of the default market (older clients). */
  benchmark: string;
  /** The default market's currency. */
  currency: "JPY" | "USD";
  /** Per market: settings in effect and how many stocks it has. */
  markets: Array<{ id: "us" | "jp"; label: string; currency: "JPY" | "USD"; benchmark: string; lotSize: number; count: number; isDefault: boolean }>;
  /** Recent watchlist changes (screen, Claude, review), newest first. */
  history: WatchlistChangeRow[];
  /** Still held in an account but no longer watched (stops and exits keep working). */
  heldNotWatched: string[];
  /** Where edits are saved (config/config.yaml; created from the example on first save). */
  file: string | null;
  loadedFrom: string | null;
}

export interface PromptVersionView extends PromptInfo {
  /** "config" (the default for every workflow) and/or workflows that pin this version in a node. */
  usedBy: string[];
}

export interface PromptFamilyView {
  family: PromptFamily;
  label: string;
  /** Key under `prompts:` in config.yaml. */
  configKey: string;
  active: string;
  /** Has a golden set (event, judge); the others are compared on live results. */
  evaluable: boolean;
  goldenSet: string | null;
  versions: PromptVersionView[];
  evals: EvalJob[];
  /** Models this family uses (config.yaml models.use); overriddenBy = workflows whose node picks its own. */
  models: {
    kind: "vote" | "single";
    /** Chosen by the app ("auto") rather than by hand. */
    auto: boolean;
    /** The saved manual choice (null when auto). */
    manual: { vote: string[]; escalation: string | null } | string | null;
    /** What is used now (auto decided). */
    vote: string[];
    escalation: string | null;
    model: string | null;
    /** One plain-language sentence. */
    summary: string;
    /** Warnings about the automatic choice (missing keys, one vendor only). */
    notes: string[];
    overriddenBy: string[];
  };
}

export interface PromptsView {
  families: PromptFamilyView[];
  switches: PromptSwitch[];
  models: string[];
  /** Registered models (settings → モデル) to pick from. */
  pool: Array<{ name: string; model: string; vendor: string; keySet: boolean }>;
  quorum: number;
  /** Switching writes config.yaml; false when the server has no config path. */
  editable: boolean;
  fake: boolean;
}

export interface CalendarView {
  from: string;
  to: string;
  /** Today in the server's local time zone. */
  today: string;
  market: "us" | "jp";
  holidays: Array<{ date: string; name: string; market?: "us" | "jp" }>;
  earnings: Array<{ date: string; ticker: string; name: string; time: string | null; estimate: number | null; held: boolean; daysAway: number }>;
  /** Upcoming automatic runs, by local date. */
  schedule: Array<{ date: string; at: string; workflow: string; skipped: string | null }>;
  /** Past runs by run date (asOf). */
  runs: Array<{ date: string; workflow: string; status: string; runId: string }>;
  earningsSource: { configured: boolean; lastFetch: string | null; rows: number | null };
}

/** Everything known about one ticker (the stock page). */
export interface StockView {
  ticker: string;
  name: string;
  sector: string;
  inWatchlist: boolean;
  held: boolean;
  currency: string;
  /** Date of the last bar. */
  asOf: string;
  bars: Array<{ date: string; close: number }>;
  benchmark: string | null;
  returns: { d20: number | null; d60: number | null; d250: number | null; bench60: number | null };
  /** Recorded judgments (every workflow), with the 20-day excess return that followed when known. */
  judgments: Array<{ asOf: string; label: string; stance: string; conviction: number; thesis: string | null; invalidation: string[]; excess20: number | null; hit: boolean | null }>;
  fills: Fill[];
  positions: Array<{ account: string; currency: string; shares: number; entryPrice: number; entryDate: string; close: number; daysHeld: number; pnl: number; pnlPct: number; stop: number | null }>;
  /** The newest composite score with each factor's contribution (they sum to `total`). */
  score: { asOf: string; runId: string; workflow: string; total: number; rank: number; of: number; contributions: Record<string, number>; weights: Record<string, number> } | null;
  fundamentals: Fundamentals | null;
  valuation: { pe: number | null; ps: number | null; marketCap: number | null } | null;
  estimates: Revision[];
  earnings: { next: NextEarnings | null; results: EarningsResult[]; reactions: EarningsReaction[] };
  insider: InsiderSummary | null;
  sectorRead: { etf: string; rank: number | null; of: number; rel60: number | null } | null;
  events: Array<{ learnedAt: string; title: string; url: string; source: string; eventType: string; direction: number; materiality: number; evidence: string[] }>;
}

/** The overview's market pane. */
export interface TodayView {
  market: MarketContext | null;
  /** Held stocks reporting within 14 days. */
  earnings: Array<{ ticker: string; reportDate: string; daysAway: number; time: string | null }>;
  /** Last download per data source (age in days; stale when older than usual). */
  freshness: Array<{ label: string; day: string | null; age: number | null; stale: boolean; hint: string }>;
}

/** signal.score nodes whose weights the factor research can be applied to. */
export interface WeightTargets {
  targets: Array<{ workflow: string; file: string; node: string; weights: Record<string, number>; explicit: boolean }>;
  history: Array<{ at: string; workflow: string; node: string; from: Record<string, number>; to: Record<string, number>; source: string }>;
}

/** Paper trades per account (the trade journal). */
export interface JournalView {
  accounts: Array<{ account: string; currency: string; summary: JournalSummary; trades: Trade[] }>;
  /** Orders sent to a real broker (IBKR / Webull) and what became of them. */
  brokerOrders: TrackedOrder[];
}
