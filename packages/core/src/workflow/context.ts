import type { MarketProfile } from "../markets.ts";
import type { Services } from "../services.ts";
import type { IsoDate } from "../util/dates.ts";

/** Thrown by a node that needs outside input (e.g. human approval). The run pauses and can be resumed. */
export class WaitingForInput extends Error {
  override name = "WaitingForInput";
  readonly payload: unknown;
  constructor(message: string, payload?: unknown) {
    super(message);
    this.payload = payload;
  }
}

export interface Approval {
  decision: "approve" | "reject";
  note: string;
  decidedAt: string;
}

export interface NodeContext {
  readonly runId: string;
  readonly workflow: string;
  readonly nodeId: string;
  /** The trading day this run is for. In a replay this is in the past. */
  readonly asOf: IsoDate;
  /** Wall-clock "now" for the run: real time when live, end of `asOf` in a replay. */
  readonly now: Date;
  readonly live: boolean;
  readonly runCreatedAt: Date;
  /** Real (engine) wall clock — unlike `now`, not pinned to the run date in replays. */
  wallNow(): Date;
  readonly services: Services;
  /**
   * The market this run is for (from the workflow's nodes, else the default market). Nodes read
   * it through nodes/scope.ts, which also covers hand-made contexts in tests.
   */
  readonly market?: MarketProfile;
  log(message: string, data?: unknown): void;
  /** Additive per-node metric, shown in run views (e.g. llm calls, docs skipped). */
  metric(name: string, value: number): void;
  approval(): Approval | undefined;
}
