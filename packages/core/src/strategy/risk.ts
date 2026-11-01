import { z } from "zod";

/** Hard limits. These bound the loss no matter what the AI decides (DESIGN §6.5). */
export const RiskConfig = z.object({
  /** Fraction of equity lost if the initial stop is hit. */
  riskPerTrade: z.number().positive().max(0.05).default(0.0075),
  stopAtrMult: z.number().positive().default(2.5),
  trailAtrMult: z.number().positive().default(3),
  maxWeight: z.number().positive().max(1).default(0.1),
  maxPositions: z.number().int().positive().default(12),
  maxSectorWeight: z.number().positive().max(1).default(0.3),
  /** 100 for Japanese equities (単元株). */
  lotSize: z.number().int().positive().default(1),
  /** Drawdown that stops new entries. */
  ddHaltNew: z.number().positive().max(1).default(0.15),
  /** Drawdown that forces de-risking and human review. */
  ddReduce: z.number().positive().max(1).default(0.25),
});
export type RiskConfig = z.output<typeof RiskConfig>;

export type TradingMode = "normal" | "no_new_entries" | "reduce";

/** Shares such that hitting the ATR stop loses ~riskPerTrade of equity; capped by maxWeight; rounded to lots. */
export function positionSize(equity: number, price: number, atr: number, cfg: RiskConfig): number {
  if (!(price > 0) || !(atr > 0) || !(equity > 0)) return 0;
  const byRisk = (equity * cfg.riskPerTrade) / (cfg.stopAtrMult * atr);
  const byWeight = (equity * cfg.maxWeight) / price;
  return Math.floor(Math.min(byRisk, byWeight) / cfg.lotSize) * cfg.lotSize;
}

/** The higher of the initial stop and the trailing stop. */
export function stopPrice(entry: number, highestClose: number, atr: number, cfg: RiskConfig): number {
  return Math.max(entry - cfg.stopAtrMult * atr, highestClose - cfg.trailAtrMult * atr);
}

export function drawdown(equity: number, peak: number): number {
  return peak <= 0 ? 0 : Math.max(0, 1 - equity / peak);
}

export function tradingMode(equity: number, peak: number, cfg: RiskConfig): TradingMode {
  const dd = drawdown(equity, peak);
  if (dd >= cfg.ddReduce) return "reduce";
  if (dd >= cfg.ddHaltNew) return "no_new_entries";
  return "normal";
}
