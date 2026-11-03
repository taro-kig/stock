import type { BrokerAccount, BrokerClient } from "./broker.ts";
import type { BrokerLedger, TrackedOrder } from "./ledger.ts";

/**
 * What became of the orders sent to a real broker. Works with what every broker client already
 * offers: an order still in the open-order list is working; once it is gone, the change in the
 * position since it was sent tells whether it filled (fully / partly) or expired or was
 * cancelled, and the change in average cost estimates the buy price. A client that can report
 * fills exactly (orderUpdates) is used instead.
 *
 * The estimate is wrong when the same stock was traded outside this system (by hand, in the app)
 * or several of our orders on one stock were open at once; those cases are marked as estimates.
 */
export type OrderState = "working" | "filled" | "partial" | "unfilled";

export interface OrderUpdate {
  ref: string;
  ticker: string;
  side: "buy" | "sell";
  shares: number;
  state: OrderState;
  filledShares: number;
  fillPrice: number | null;
  /** True when inferred from positions (not reported by the broker). */
  estimated: boolean;
  note: string;
}

export async function trackOrders(ledger: BrokerLedger, broker: BrokerClient, account: BrokerAccount, now: Date): Promise<OrderUpdate[]> {
  const pending = ledger.pendingOrders(account.accountId);
  if (!pending.length) return [];
  const exact = broker.orderUpdates ? await broker.orderUpdates(pending.map((o) => ({ ref: o.ref, brokerOrderId: o.brokerOrderId })), account.accountId) : [];
  const open = new Set(await broker.openOrderRefs());
  const key = (ref: string) => broker.refKey?.(ref) ?? ref;
  const pos = new Map(account.positions.map((p) => [p.ticker, p]));
  const sameTicker = (o: TrackedOrder) => pending.filter((x) => x.ticker === o.ticker).length > 1;
  const out: OrderUpdate[] = [];
  for (const o of pending) {
    const e = exact.find((x) => x.ref === o.ref);
    let u: OrderUpdate;
    if (e) {
      u = { ...e, ticker: o.ticker, side: o.side, shares: o.shares, estimated: false };
    } else if (open.has(key(o.ref))) {
      u = { ref: o.ref, ticker: o.ticker, side: o.side, shares: o.shares, state: "working", filledShares: 0, fillPrice: null, estimated: false, note: "注文中" };
    } else if (o.posBefore === null) {
      u = { ref: o.ref, ticker: o.ticker, side: o.side, shares: o.shares, state: "unfilled", filledShares: 0, fillPrice: null, estimated: true, note: "送った時点の保有が記録されていないため結果不明（注文中ではない）" };
    } else {
      const p = pos.get(o.ticker);
      const nowShares = p?.shares ?? 0;
      const delta = o.side === "buy" ? nowShares - o.posBefore : o.posBefore - nowShares;
      const filled = Math.max(0, Math.min(o.shares, delta));
      let price: number | null = null;
      const avgBefore = o.posBefore === 0 ? 0 : o.avgBefore;
      if (o.side === "buy" && filled > 0 && p && avgBefore !== null) {
        const est = (p.avgCost * nowShares - avgBefore * o.posBefore) / filled;
        price = Number.isFinite(est) && est > 0 ? est : null;
      }
      const state: OrderState = filled >= o.shares ? "filled" : filled > 0 ? "partial" : "unfilled";
      const caveat = sameTicker(o) ? "（同じ銘柄の注文が複数あるため推定）" : "（保有の変化から推定）";
      u = {
        ref: o.ref, ticker: o.ticker, side: o.side, shares: o.shares, state, filledShares: filled, fillPrice: price, estimated: true,
        note: (state === "filled" ? "約定" : state === "partial" ? `一部約定 ${filled}/${o.shares}` : "約定せず（期限切れ・取消）") + caveat,
      };
    }
    ledger.updateOrder(o.ref, u, now);
    out.push(u);
  }
  return out;
}
