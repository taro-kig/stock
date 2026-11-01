import type { IsoDate } from "../util/dates.ts";

/**
 * Minimal broker surface the system needs. Mid-term, once a day: read the
 * account, place limit orders. Everything else (sizing, limits, approval) lives
 * upstream so it is identical for paper, IBKR-paper and live.
 */
export interface BrokerPosition {
  ticker: string;
  shares: number;
  avgCost: number;
}

export interface BrokerAccount {
  accountId: string;
  currency: string;
  netLiquidation: number;
  cash: number;
  positions: BrokerPosition[];
}

export interface OrderRequest {
  /** Idempotency key: one order per account/day/ticker/side. Sent to the broker as orderRef. */
  ref: string;
  ticker: string;
  side: "buy" | "sell";
  shares: number;
  limitPrice: number;
  tif: "DAY";
}

export type OrderTicketStatus = "submitted" | "duplicate" | "blocked" | "error" | "dry_run";

export interface OrderTicket extends OrderRequest {
  asOf: IsoDate;
  account: string;
  status: OrderTicketStatus;
  brokerOrderId: number | null;
  message: string;
}

export interface BrokerClient {
  account(): Promise<BrokerAccount>;
  /** orderRefs of orders currently working at the broker. */
  openOrderRefs(): Promise<string[]>;
  placeLimitOrder(req: OrderRequest, accountId: string): Promise<number>;
  close(): Promise<void>;
}

/** In-memory broker for tests and offline runs. Orders fill immediately at the limit price. */
export class FakeBroker implements BrokerClient {
  readonly placed: Array<OrderRequest & { accountId: string; id: number }> = [];
  readonly positions = new Map<string, BrokerPosition>();
  readonly accountId: string;
  readonly currency: string;
  cash: number;
  closed = 0;
  #nextId = 1;

  constructor(accountId = "DU0000001", cash = 10_000_000, currency = "JPY") {
    this.accountId = accountId;
    this.cash = cash;
    this.currency = currency;
  }

  async account(): Promise<BrokerAccount> {
    const positions = [...this.positions.values()];
    const value = positions.reduce((s, p) => s + p.shares * p.avgCost, 0);
    return { accountId: this.accountId, currency: this.currency, netLiquidation: this.cash + value, cash: this.cash, positions };
  }

  async openOrderRefs(): Promise<string[]> {
    return [];
  }

  async placeLimitOrder(req: OrderRequest, accountId: string): Promise<number> {
    const id = this.#nextId++;
    this.placed.push({ ...req, accountId, id });
    const p = this.positions.get(req.ticker);
    if (req.side === "buy") {
      this.cash -= req.shares * req.limitPrice;
      const shares = (p?.shares ?? 0) + req.shares;
      const avg = ((p?.shares ?? 0) * (p?.avgCost ?? 0) + req.shares * req.limitPrice) / shares;
      this.positions.set(req.ticker, { ticker: req.ticker, shares, avgCost: avg });
    } else if (p) {
      this.cash += req.shares * req.limitPrice;
      if (p.shares <= req.shares) this.positions.delete(req.ticker);
      else this.positions.set(req.ticker, { ...p, shares: p.shares - req.shares });
    }
    return id;
  }

  async close(): Promise<void> {
    this.closed++;
  }
}
