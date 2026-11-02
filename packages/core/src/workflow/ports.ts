import type { Judgment } from "../ai/judge.ts";
import type { Scorecard } from "../eval/scorecard.ts";
import type { EarningsMap } from "../data/earnings.ts";
import type { EarningsResults } from "../data/earningsResults.ts";
import type { EstimatesMap } from "../data/estimates.ts";
import type { FundamentalsMap } from "../data/fundamentals.ts";
import type { MarketContext } from "../data/market.ts";
import type { InsiderMap } from "../data/insider.ts";
import type { OrderTicket } from "../execution/broker.ts";
import type { AccountState, Fill } from "../execution/paper.ts";
import type { EventRecord, Document } from "../signals/models.ts";
import type { Match } from "../signals/prefilter.ts";
import type { Prices } from "../signals/technical.ts";
import type { FactorTable } from "../strategy/factors.ts";
import type { Proposal } from "../strategy/portfolio.ts";
import type { UniverseChanges } from "../universe/watchlist.ts";

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
  Orders: OrderTicket[];
  Scorecard: Scorecard;
  Count: number;
  UniverseChanges: UniverseChanges;
  /** Next known earnings date per ticker, as of the run date. */
  Earnings: EarningsMap;
  /** Open-market insider buying / selling per ticker (SEC Form 4), as of the run date. */
  Insider: InsiderMap;
  /** Reported EPS vs estimate per ticker (newest first), as of the run date. */
  EarningsResults: EarningsResults;
  /** Financials per ticker from SEC filings (growth, margins, EPS, shares), as of the run date. */
  Fundamentals: FundamentalsMap;
  /** Analyst EPS estimate revisions per ticker, as of the run date. */
  Estimates: EstimatesMap;
  /** Sector strength vs the market and market-wide risk gauges, as of the run date. */
  Market: MarketContext;
}
export type PortType = keyof PortTypes;

export const PORT_TYPES = [
  "Documents", "Matches", "Events", "Prices", "Factors", "Scores", "Judgments",
  "Account", "Proposals", "Fills", "Orders", "Scorecard", "Count", "UniverseChanges", "Earnings", "Insider", "EarningsResults", "Fundamentals", "Estimates", "Market",
] as const satisfies readonly PortType[];
