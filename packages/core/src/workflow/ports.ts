import type { Judgment } from "../ai/judge.ts";
import type { Scorecard } from "../eval/scorecard.ts";
import type { AccountState, Fill } from "../execution/paper.ts";
import type { EventRecord, Document } from "../signals/models.ts";
import type { Match } from "../signals/prefilter.ts";
import type { Prices } from "../signals/technical.ts";
import type { FactorTable } from "../strategy/factors.ts";
import type { Proposal } from "../strategy/portfolio.ts";

/**
 * The data types that flow along workflow edges. Port types are checked when a
 * workflow is loaded (an edge must connect equal types) and give node
 * implementations static types. The node UI colours ports by these names.
 *
 * Every value must be plain JSON (no Date/Map/NaN): outputs are stored as
 * artifacts so runs can be inspected, cached, resumed and replayed.
 */
export interface PortTypes {
  Documents: Document[];
  Matches: Match[];
  Events: EventRecord[];
  Prices: Prices;
  Factors: FactorTable;
  Scores: Record<string, number>;
  Judgments: Record<string, Judgment>;
  Account: AccountState;
  Proposals: Proposal[];
  Fills: Fill[];
  Scorecard: Scorecard;
  Count: number;
}
export type PortType = keyof PortTypes;

export const PORT_TYPES = [
  "Documents", "Matches", "Events", "Prices", "Factors", "Scores", "Judgments",
  "Account", "Proposals", "Fills", "Scorecard", "Count",
] as const satisfies readonly PortType[];
