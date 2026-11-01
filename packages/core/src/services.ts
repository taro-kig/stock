import { join } from "node:path";
import type { AppConfig } from "./config.ts";
import { PredictionStore } from "./eval/predictions.ts";
import { FakeBroker, type BrokerClient } from "./execution/broker.ts";
import { IbkrClient, IbkrConfig } from "./execution/ibkr.ts";
import { WebullClient, WebullConfig } from "./execution/webull.ts";
import { BrokerLedger } from "./execution/ledger.ts";
import { PaperBook } from "./execution/paper.ts";
import { CostTracker } from "./harness/budget.ts";
import { LLMCache } from "./harness/cache.ts";
import { StructuredCaller } from "./harness/structured.ts";
import { buildProvider } from "./llm/factory.ts";
import { FakeProvider } from "./llm/fake.ts";
import { heuristicResponder } from "./llm/heuristic.ts";
import type { LLMProvider } from "./llm/types.ts";
import { DocStore } from "./signals/docStore.ts";
import { Watchlist } from "./signals/prefilter.ts";
import { openDb, type Db } from "./util/db.ts";
import { RunStore } from "./workflow/runStore.ts";

export type BrokerKind = "ibkr" | "webull";

const FAKE_PRICING = { "fake-a": [0, 0], "fake-b": [0, 0], "fake-red": [0, 0] } as const;

export interface ServicesOptions {
  /** Use offline heuristic models: no API keys, no cost. */
  fake?: boolean;
  /** Defaults to <dataDir>/stockai.sqlite. ":memory:" for tests. */
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
  /** Override how broker connections are made (tests). */
  brokerFactory?: (kind: BrokerKind) => Promise<BrokerClient>;
}

/** Lazily-built shared dependencies handed to every node via its context. */
export class Services {
  readonly config: AppConfig;
  readonly fake: boolean;
  readonly dbPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly #brokerFactory: ((kind: BrokerKind) => Promise<BrokerClient>) | undefined;
  readonly #fakeBrokers = new Map<BrokerKind, FakeBroker>();
  #ledger?: BrokerLedger;
  #db?: Db;
  #budget?: CostTracker;
  #caller?: StructuredCaller;
  #docStore?: DocStore;
  #runStore?: RunStore;
  #watchlist?: Watchlist;
  #paper?: PaperBook;
  #predictions?: PredictionStore;
  #tier1?: LLMProvider[];

  constructor(config: AppConfig, opts: ServicesOptions = {}) {
    this.config = config;
    this.fake = opts.fake ?? false;
    this.dbPath = opts.dbPath ?? join(config.dataDir, "stockai.sqlite");
    this.env = opts.env ?? process.env;
    this.#brokerFactory = opts.brokerFactory;
  }

  get db(): Db {
    return (this.#db ??= openDb(this.dbPath));
  }
  get budget(): CostTracker {
    const pricing = this.fake ? { ...this.config.pricing, ...FAKE_PRICING } : this.config.pricing;
    return (this.#budget ??= new CostTracker(this.db, { pricing, dailyLimitUsd: this.config.harness.dailyBudgetUsd }));
  }
  get caller(): StructuredCaller {
    return (this.#caller ??= new StructuredCaller({ cache: new LLMCache(this.db), budget: this.budget, maxRetries: this.config.harness.maxRetries }));
  }
  get docStore(): DocStore {
    return (this.#docStore ??= new DocStore(this.db));
  }
  get runStore(): RunStore {
    return (this.#runStore ??= new RunStore(this.db));
  }
  get watchlist(): Watchlist {
    return (this.#watchlist ??= new Watchlist(this.config.watchlist));
  }
  get paperBook(): PaperBook {
    return (this.#paper ??= new PaperBook(this.db));
  }
  get predictions(): PredictionStore {
    return (this.#predictions ??= new PredictionStore(this.db));
  }
  get brokerLedger(): BrokerLedger {
    return (this.#ledger ??= new BrokerLedger(this.db));
  }
  get ibkrConfig(): IbkrConfig {
    return this.config.ibkr ?? IbkrConfig.parse({});
  }
  get webullConfig(): WebullConfig {
    return this.config.webull ?? WebullConfig.parse({});
  }

  /** A fresh broker connection; the caller closes it. --fake uses an in-memory broker per kind. */
  async brokerClient(kind: BrokerKind = "ibkr"): Promise<BrokerClient> {
    if (this.#brokerFactory) return this.#brokerFactory(kind);
    if (this.fake) {
      let b = this.#fakeBrokers.get(kind);
      if (!b) this.#fakeBrokers.set(kind, (b = new FakeBroker(kind === "ibkr" ? "DU0000001" : "WB0000001")));
      const fb = b;
      return { account: () => fb.account(), openOrderRefs: () => fb.openOrderRefs(), placeLimitOrder: (r, a) => fb.placeLimitOrder(r, a), close: async () => {} };
    }
    if (kind === "webull") {
      if (!this.config.webull) throw new Error("config.webull is not set (see docs/webull.md)");
      return WebullClient.connect(this.config.webull, { env: this.env });
    }
    if (!this.config.ibkr) throw new Error("config.ibkr is not set (see docs/ibkr.md)");
    return IbkrClient.connect(this.config.ibkr);
  }

  get risk() {
    return this.config.risk;
  }

  tier1(): LLMProvider[] {
    if (this.#tier1) return this.#tier1;
    if (this.fake) return (this.#tier1 = [new FakeProvider("fake-a", heuristicResponder), new FakeProvider("fake-b", heuristicResponder)]);
    if (!this.config.models) throw new Error("config.models is required (or run with --fake)");
    return (this.#tier1 = this.config.models.tier1.map((s) => buildProvider(s, this.env)));
  }

  tier2(): LLMProvider | undefined {
    if (this.fake || !this.config.models?.tier2) return undefined;
    return buildProvider(this.config.models.tier2, this.env);
  }

  redTeam(): LLMProvider | undefined {
    if (this.fake) return new FakeProvider("fake-red", heuristicResponder);
    const spec = this.config.models?.redTeam ?? this.config.models?.tier2;
    return spec ? buildProvider(spec, this.env) : undefined;
  }

  /** Names of every configured model (tier1, tier2, redTeam). */
  modelNames(): string[] {
    if (this.fake) return this.tier1().map((p) => p.name);
    const m = this.config.models;
    if (!m) throw new Error("config.models is required (or run with --fake)");
    return [...new Set([...m.tier1, ...(m.tier2 ? [m.tier2] : []), ...(m.redTeam ? [m.redTeam] : [])].map((s) => s.name))];
  }

  /**
   * Builds the named models (all when names is omitted). Only the requested ones need an API key,
   * so e.g. `--models deepseek` works without GEMINI_API_KEY.
   */
  allModels(names?: readonly string[]): LLMProvider[] {
    if (this.fake) return this.tier1().filter((p) => !names || names.includes(p.name));
    const m = this.config.models;
    if (!m) throw new Error("config.models is required (or run with --fake)");
    const specs = [...new Map([...m.tier1, ...(m.tier2 ? [m.tier2] : []), ...(m.redTeam ? [m.redTeam] : [])].map((s) => [s.name, s])).values()];
    const unknown = (names ?? []).filter((n) => !specs.some((s) => s.name === n));
    if (unknown.length) throw new Error(`unknown model(s) ${unknown.join(", ")} (configured: ${specs.map((s) => s.name).join(", ")})`);
    return specs.filter((s) => !names || names.includes(s.name)).map((s) => buildProvider(s, this.env));
  }

  /** Today's LLM spend so far (0 if nothing has touched the budget yet). */
  costSnapshot(): number {
    return this.#budget ? this.#budget.spentToday() : 0;
  }
}
