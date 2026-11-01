import { addDays, isWeekday, parseDate, toIsoDate, type IsoDate } from "./dates.ts";

/**
 * NYSE / Nasdaq full-day holidays, computed from the exchange rules (no data feed):
 * New Year's Day, Martin Luther King Jr. Day, Washington's Birthday, Good Friday,
 * Memorial Day, Juneteenth (from 2022), Independence Day, Labor Day, Thanksgiving,
 * Christmas. Saturday holidays are observed on Friday and Sunday ones on Monday, except
 * that New Year's Day on a Saturday is not moved into the previous year.
 * Unscheduled closures (national days of mourning, storms) and early closes are not modelled.
 */
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** The n-th (1-based) weekday `wd` (0 = Sunday) of a month; n = -1 for the last one. */
function nthWeekday(y: number, m: number, wd: number, n: number): IsoDate {
  if (n > 0) {
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    return ymd(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = new Date(Date.UTC(y, m - 1, lastDay)).getUTCDay();
  return ymd(y, m, lastDay - ((last - wd + 7) % 7));
}

/** Western Easter Sunday (anonymous Gregorian algorithm). */
function easter(y: number): IsoDate {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return ymd(y, month, day);
}

function observed(date: IsoDate): IsoDate | null {
  const wd = parseDate(date).getUTCDay();
  if (wd === 6) return date.endsWith("-01-01") ? null : addDays(date, -1);
  if (wd === 0) return addDays(date, 1);
  return date;
}

const cache = new Map<number, Map<IsoDate, string>>();

/** Holiday date → name for one year. */
export function usMarketHolidays(year: number): Map<IsoDate, string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const out = new Map<IsoDate, string>();
  const fixed = (m: number, d: number, name: string) => {
    const o = observed(ymd(year, m, d));
    if (o) out.set(o, name);
  };
  fixed(1, 1, "New Year's Day");
  out.set(nthWeekday(year, 1, 1, 3), "Martin Luther King Jr. Day");
  out.set(nthWeekday(year, 2, 1, 3), "Washington's Birthday");
  out.set(addDays(easter(year), -2), "Good Friday");
  out.set(nthWeekday(year, 5, 1, -1), "Memorial Day");
  if (year >= 2022) fixed(6, 19, "Juneteenth");
  fixed(7, 4, "Independence Day");
  out.set(nthWeekday(year, 9, 1, 1), "Labor Day");
  out.set(nthWeekday(year, 11, 4, 4), "Thanksgiving Day");
  fixed(12, 25, "Christmas Day");
  cache.set(year, out);
  return out;
}

export const US_HOLIDAY_JA: Record<string, string> = {
  "New Year's Day": "元日", "Martin Luther King Jr. Day": "キング牧師記念日", "Washington's Birthday": "大統領の日",
  "Good Friday": "聖金曜日", "Memorial Day": "戦没将兵追悼記念日", Juneteenth: "ジューンティーンス", "Independence Day": "独立記念日",
  "Labor Day": "労働者の日", "Thanksgiving Day": "感謝祭", "Christmas Day": "クリスマス",
};

export function usHoliday(date: IsoDate): string | null {
  return usMarketHolidays(Number(date.slice(0, 4))).get(date) ?? null;
}

export function isUsTradingDay(date: IsoDate): boolean {
  return isWeekday(date) && usHoliday(date) === null;
}

/** Trading days in [from, to], every `step`-th one. */
export function usTradingDays(from: IsoDate, to: IsoDate, step = 1): IsoDate[] {
  const out: IsoDate[] = [];
  let i = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!isUsTradingDay(d)) continue;
    if (i++ % step === 0) out.push(d);
  }
  return out;
}

/** Holidays between two dates (inclusive), for calendars. */
export function usHolidaysBetween(from: IsoDate, to: IsoDate): Array<{ date: IsoDate; name: string; nameJa: string }> {
  const out: Array<{ date: IsoDate; name: string; nameJa: string }> = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    for (const [date, name] of usMarketHolidays(y)) if (date >= from && date <= to) out.push({ date, name, nameJa: US_HOLIDAY_JA[name] ?? name });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export const todayUtc = (): IsoDate => toIsoDate(new Date());
