/** JSON shapes exchanged between the web server and the UI. */
import type { AccountState, EvalJob, Fill, Judgment, NodeDescription, OrderTicket, PromptFamily, PromptInfo, PromptSwitch, Proposal, Scorecard, SettingStatus, UniverseChanges } from "@stockai/core";

export type NodeStatus = "pending" | "ok" | "cached" | "fallback" | "failed" | "skipped" | "waiting" | "queued";
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
  pending: Array<{ run: RunSummary; gates: WaitingGate[] }>;
  workflows: WorkflowInfo[];
  recent: RunSummary[];
  equity: EquitySeries[];
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
  watchlist: Record<string, { name: string; aliases: string[]; sector: string }>;
  benchmark: string;
  /** AI ticker suggestions are offered for USD (US stocks) only. */
  currency: "JPY" | "USD";
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
}

export interface PromptsView {
  families: PromptFamilyView[];
  switches: PromptSwitch[];
  models: string[];
  /** Switching writes config.yaml; false when the server has no config path. */
  editable: boolean;
  fake: boolean;
}
