import type { Fill } from "../execution/paper.ts";
import type { IsoDate } from "../util/dates.ts";
import type { Prediction } from "./predictions.ts";

/**
 * Trade journal: paper fills grouped into trades (a position from its first buy until it is
 * back to zero), with the judgment that was behind the entry and the reasons for the exit.
 * The scorecard grades every *judgment*; this is the view of what was actually *traded*.
 */
export interface Trade {
  account: string;
  ticker: string;
  open: boolean;
  entryDate: IsoDate;
  exitDate: IsoDate | null;
  /** Shares bought over the trade (adds included). */
  shares: number;
  /** Still held (open trades). */
  openShares: number;
  avgEntry: number;
  /** Average sale price of what was sold (null before any sale). */
  avgExit: number | null;
  fees: number;
  /** Realized + (for open trades) unrealized at `lastClose`, after fees. */
  pnl: number;
  /** pnl ÷ cost of what was bought. */
  ret: number;
  daysHeld: number;
  lastClose: number | null;
  entryReason: string;
  exitReason: string | null;
  /** The recorded judgment on the entry day (same workflow when there is one). */
  entryJudgment: { label: string; stance: string; conviction: number; thesis: string | null } | null;
}

export interface JournalSummary {
  closed: number;
  open: number;
  /** Share of closed trades with a profit. */
  winRate: number | null;
  avgWin: number | null;
  avgLoss: number | null;
  /** Gross profits ÷ gross losses of closed trades. */
  profitFactor: number | null;
  avgDaysHeld: number | null;
  /** Realized P&L of closed trades. */
  realized: number;
}

const days = (a: IsoDate, b: IsoDate) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function buildTrades(
  fills: readonly Fill[],
  predictions: readonly Prediction[],
  o: { lastClose: (ticker: string) => { close: number; date: IsoDate } | null; today: IsoDate },
): Trade[] {
  const byKey = new Map<string, Fill[]>();
  for (const f of fills) byKey.set(`${f.account}\u0000${f.ticker}`, [...(byKey.get(`${f.account}\u0000${f.ticker}`) ?? []), f]);
  const predOf = new Map<string, Prediction[]>();
  for (const p of predictions) predOf.set(`${p.ticker}\u0000${p.asOf}`, [...(predOf.get(`${p.ticker}\u0000${p.asOf}`) ?? []), p]);
  const out: Trade[] = [];
  for (const list of byKey.values()) {
    let cur: { fills: Fill[]; held: number } | null = null;
    const close = (t: { fills: Fill[]; held: number }, open: boolean) => {
      const buys = t.fills.filter((f) => f.side === "buy");
      const sells = t.fills.filter((f) => f.side === "sell");
      const bought = buys.reduce((s, f) => s + f.shares, 0);
      const cost = buys.reduce((s, f) => s + f.shares * f.price, 0);
      const sold = sells.reduce((s, f) => s + f.shares, 0);
      const proceeds = sells.reduce((s, f) => s + f.shares * f.price, 0);
      const fees = t.fills.reduce((s, f) => s + f.fee, 0);
      const first = t.fills[0]!;
      const last = t.fills.at(-1)!;
      const lastBar = o.lastClose(first.ticker);
      const lc = lastBar?.close ?? null;
      const avgEntry = bought ? cost / bought : 0;
      const unrealized = open && lc !== null ? (lc - avgEntry) * t.held : 0;
      const pnl = proceeds - avgEntry * sold + unrealized - fees;
      const preds = predOf.get(`${first.ticker}\u0000${first.asOf}`) ?? [];
      const pred = preds.find((p) => p.label === first.account) ?? preds.find((p) => p.stance === "bullish") ?? preds[0];
      out.push({
        account: first.account, ticker: first.ticker, open, entryDate: first.asOf, exitDate: open ? null : last.asOf,
        shares: bought, openShares: open ? t.held : 0, avgEntry, avgExit: sold ? proceeds / sold : null, fees, pnl,
        ret: cost > 0 ? pnl / cost : 0, daysHeld: days(first.asOf, open ? (lastBar?.date ?? o.today) : last.asOf), lastClose: lc,
        entryReason: buys[0]?.reason ?? "", exitReason: sells.at(-1)?.reason ?? null,
        entryJudgment: pred ? { label: pred.label, stance: pred.stance, conviction: pred.conviction, thesis: pred.thesis ?? null } : null,
      });
    };
    for (const f of list) {
      if (f.side === "buy") {
        cur ??= { fills: [], held: 0 };
        cur.fills.push(f);
        cur.held += f.shares;
      } else if (cur) {
        cur.fills.push(f);
        cur.held -= f.shares;
        if (cur.held <= 0) {
          close(cur, false);
          cur = null;
        }
      }
    }
    if (cur) close(cur, true);
  }
  return out.sort((a, b) => b.entryDate.localeCompare(a.entryDate));
}

export function summarize(trades: readonly Trade[]): JournalSummary {
  const closed = trades.filter((t) => !t.open);
  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl <= 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const gross = (ts: Trade[]) => ts.reduce((s, t) => s + t.pnl, 0);
  return {
    closed: closed.length, open: trades.length - closed.length,
    winRate: closed.length ? wins.length / closed.length : null,
    avgWin: avg(wins.map((t) => t.ret)), avgLoss: avg(losses.map((t) => t.ret)),
    profitFactor: losses.length && gross(losses) < 0 ? gross(wins) / -gross(losses) : null,
    avgDaysHeld: avg(closed.map((t) => t.daysHeld)),
    realized: gross(closed),
  };
}
