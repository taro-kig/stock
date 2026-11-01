import { NodeRegistry } from "../workflow/registry.ts";
import { paperBroker } from "./broker.ts";
import { csvPrices, stooqPrices, syntheticPrices } from "./data.ts";
import { aiDecide, rulesDecide } from "./decide.ts";
import { recordPredictions, scorecardNode } from "./evaluation.ts";
import { dedupNode, watchlistFilter } from "./filters.ts";
import { approvalGate } from "./gate.ts";
import { ibkrAccount, ibkrBroker, webullAccount, webullBroker } from "./brokers.ts";
import { extractEvents } from "./llm.ts";
import { accountNode, proposeNode } from "./portfolio.ts";
import { eventHistory, eventScoreNode, factorsNode, scoreNode } from "./signals.ts";
import { fixtureSource, rssSource } from "./sources.ts";

export function builtinRegistry(): NodeRegistry {
  return new NodeRegistry().register(
    rssSource, fixtureSource,
    dedupNode, watchlistFilter,
    extractEvents,
    csvPrices, stooqPrices, syntheticPrices,
    eventHistory, eventScoreNode, factorsNode, scoreNode,
    rulesDecide, aiDecide,
    accountNode, ibkrAccount, webullAccount, proposeNode,
    approvalGate,
    paperBroker, ibkrBroker, webullBroker,
    recordPredictions, scorecardNode,
  );
}
