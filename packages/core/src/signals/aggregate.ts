import { daysBetween } from "../util/dates.ts";
import type { EventRecord } from "./models.ts";

export const HALF_LIFE_DAYS = { days: 3, weeks: 10, months: 30 } as const;
export const MATERIALITY_WEIGHT = [0, 0.3, 0.7, 1] as const;

/** Per-ticker event score with time decay and a corroboration bonus (DESIGN §4.3). */
export function eventScores(events: readonly EventRecord[], now: Date, opts: { corroborationBonus?: number } = {}): Record<string, number> {
  const bonus = opts.corroborationBonus ?? 0.5;
  const out: Record<string, number> = {};
  for (const r of events) {
    const e = r.event;
    const learned = new Date(r.learnedAt);
    if (!e.relevant || learned > now) continue; // never use information from the future
    const decay = Math.exp((-Math.LN2 * daysBetween(learned, now)) / HALF_LIFE_DAYS[e.horizon]);
    let s = e.direction * MATERIALITY_WEIGHT[e.materiality as 0 | 1 | 2 | 3] * e.confidence * r.agreement * r.sourceWeight * decay;
    if (r.nSources >= 2) s *= 1 + bonus;
    for (const t of e.tickers) out[t] = (out[t] ?? 0) + s;
  }
  return out;
}
