import { NodeRegistry } from "../workflow/registry.ts";
import { paperBroker } from "./broker.ts";
import { csvPrices, earningsCalendar, earningsResultsNode, estimatesNode, marketNode, jquantsPrices, stooqPrices, syntheticPrices, twelveDataPrices } from "./data.ts";
import { aiDecide, rulesDecide } from "./decide.ts";
import { recordPredictions, scorecardNode, factorResearchNode } from "./evaluation.ts";
import { checkEventsNode, dedupNode, mergeDocs, watchlistFilter } from "./filters.ts";
import { approvalGate } from "./gate.ts";
import { ibkrAccount, ibkrBroker, webullAccount, webullBroker } from "./brokers.ts";
import { extractEvents } from "./llm.ts";
import { accountNode, proposeNode } from "./portfolio.ts";
import { eventHistory, eventScoreNode, factorsNode, scoreNode } from "./signals.ts";
import { fixtureSource, fundamentalsNode, insiderTrades, rssSource, secFilings } from "./sources.ts";
import { universeApply, universeReview } from "./universe.ts";

export function builtinRegistry(): NodeRegistry {
  return new NodeRegistry().register(
    rssSource, secFilings, fixtureSource, insiderTrades, fundamentalsNode,
    mergeDocs, dedupNode, watchlistFilter, checkEventsNode,
    extractEvents,
    csvPrices, jquantsPrices, twelveDataPrices, stooqPrices, syntheticPrices, earningsCalendar, earningsResultsNode, estimatesNode, marketNode,
    eventHistory, eventScoreNode, factorsNode, scoreNode,
    rulesDecide, aiDecide,
    accountNode, ibkrAccount, webullAccount, proposeNode,
    approvalGate,
    paperBroker, ibkrBroker, webullBroker,
    recordPredictions, scorecardNode, factorResearchNode,
    universeReview, universeApply,
  );
}
