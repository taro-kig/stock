import type { Contract, IBApiNext, Order } from "@stoqey/ib";
import { z } from "zod";
import type { BrokerAccount, BrokerClient, OrderRequest } from "./broker.ts";

/**
 * Interactive Brokers via the TWS API, talking to an IB Gateway (see docs/ibkr.md).
 * Ports: IB Gateway 4002 = paper, 4001 = live.
 */
export const IbkrConfig = z.strictObject({
  host: z.string().default("127.0.0.1"),
  port: z.number().int().positive().default(4002),
  clientId: z.number().int().min(0).default(17),
  mode: z.enum(["paper", "live"]).default("paper"),
  /** Required for live trading; recommended for paper (guards against the wrong login). */
  accountId: z.string().optional(),
  market: z.enum(["jp", "us"]).default("jp"),
  /** Per-ticker contract overrides, e.g. { "AAPL": { symbol: AAPL, exchange: SMART, currency: USD, primaryExch: NASDAQ } } */
  contracts: z
    .record(z.string(), z.strictObject({ symbol: z.string(), exchange: z.string(), currency: z.string(), primaryExch: z.string().optional() }))
    .default({}),
  /** Limit = reference close ± this many bps (caps slippage at the open). */
  limitOffsetBps: z.number().min(0).max(500).default(50),
  /** Hard cap per buy order, in account currency. */
  maxOrderValue: z.number().positive().default(2_000_000),
  maxOrdersPerRun: z.number().int().positive().default(6),
  timeoutMs: z.number().int().positive().default(15_000),
});
export type IbkrConfig = z.output<typeof IbkrConfig>;

export function ibContract(ticker: string, cfg: Pick<IbkrConfig, "market" | "contracts">): Contract {
  const o = cfg.contracts[ticker];
  // SecType.STK === "STK"; literal used so this stays usable without loading the library
  if (o) return { symbol: o.symbol, secType: "STK" as Contract["secType"], exchange: o.exchange, currency: o.currency, ...(o.primaryExch ? { primaryExch: o.primaryExch } : {}) };
  return cfg.market === "jp"
    ? { symbol: ticker, secType: "STK" as Contract["secType"], exchange: "TSEJ", currency: "JPY" }
    : { symbol: ticker, secType: "STK" as Contract["secType"], exchange: "SMART", currency: "USD" };
}

const loadIb = () => import("@stoqey/ib");
const loadRx = () => import("rxjs");
type IB = Awaited<ReturnType<typeof loadIb>>;
type RX = Awaited<ReturnType<typeof loadRx>>;

export class IbkrClient implements BrokerClient {
  readonly #api: IBApiNext;
  readonly #ib: IB;
  readonly #rx: RX;
  readonly #cfg: IbkrConfig;

  private constructor(api: IBApiNext, ib: IB, rx: RX, cfg: IbkrConfig) {
    this.#api = api;
    this.#ib = ib;
    this.#rx = rx;
    this.#cfg = cfg;
  }

  static async connect(cfg: IbkrConfig): Promise<IbkrClient> {
    const [ib, rx] = await Promise.all([loadIb(), loadRx()]);
    const api = new ib.IBApiNext({ host: cfg.host, port: cfg.port });
    api.connect(cfg.clientId);
    try {
      await rx.firstValueFrom(api.connectionState.pipe(rx.filter((s) => s === ib.ConnectionState.Connected), rx.timeout(cfg.timeoutMs)));
    } catch {
      api.disconnect();
      throw new Error(`could not connect to IB Gateway at ${cfg.host}:${cfg.port} within ${cfg.timeoutMs}ms (is it running and logged in?)`);
    }
    return new IbkrClient(api, ib, rx, cfg);
  }

  async account(): Promise<BrokerAccount> {
    const { firstValueFrom, filter, timeout } = this.#rx;
    const t = this.#cfg.timeoutMs;
    const summary = await firstValueFrom(
      this.#api.getAccountSummary("All", "NetLiquidation,TotalCashValue").pipe(
        filter((u) => [...u.all.values()].some((tags) => tags.has("NetLiquidation") && tags.has("TotalCashValue"))),
        timeout(t),
      ),
    );
    const ids = [...summary.all.keys()];
    const accountId = this.#cfg.accountId ?? (ids.length === 1 ? ids[0]! : undefined);
    if (!accountId) throw new Error(`several accounts visible (${ids.join(", ")}); set ibkr.accountId`);
    const tags = summary.all.get(accountId);
    if (!tags) throw new Error(`account ${accountId} not visible on this login (have: ${ids.join(", ")})`);
    const pick = (tag: string) => {
      const [currency, v] = [...(tags.get(tag)?.entries() ?? [])][0] ?? [];
      return { currency: currency ?? "", value: Number(v?.value) };
    };
    const nl = pick("NetLiquidation");
    const cash = pick("TotalCashValue");
    const pos = await firstValueFrom(this.#api.getPositions().pipe(timeout(t)));
    const positions = (pos.all.get(accountId) ?? [])
      .filter((p) => p.contract.secType === this.#ib.SecType.STK && p.contract.symbol)
      .map((p) => ({ ticker: p.contract.symbol!, shares: p.pos, avgCost: p.avgCost ?? 0 }));
    if (!Number.isFinite(nl.value) || !Number.isFinite(cash.value)) throw new Error("account summary returned non-numeric values");
    return { accountId, currency: nl.currency, netLiquidation: nl.value, cash: cash.value, positions };
  }

  async openOrderRefs(): Promise<string[]> {
    const open = await this.#api.getAllOpenOrders();
    return open.map((o) => o.order.orderRef ?? "").filter(Boolean);
  }

  async placeLimitOrder(req: OrderRequest, accountId: string): Promise<string> {
    const ib = this.#ib;
    const order: Order = {
      action: req.side === "buy" ? ib.OrderAction.BUY : ib.OrderAction.SELL,
      orderType: ib.OrderType.LMT,
      totalQuantity: req.shares,
      lmtPrice: req.limitPrice,
      tif: ib.TimeInForce.DAY,
      orderRef: req.ref,
      account: accountId,
      outsideRth: false,
      transmit: true,
    };
    return String(await this.#api.placeNewOrder(ibContract(req.ticker, this.#cfg), order));
  }

  async close(): Promise<void> {
    this.#api.disconnect();
  }
}
