import { addDays, isWeekday, parseDate, type IsoDate } from "./dates.ts";

/**
 * Tokyo Stock Exchange closed days, computed from the rules (no data feed): national holidays
 * under the 祝日法 (with 振替休日 — a holiday on Sunday moves to the next non-holiday — and 国民の休日
 * — a weekday between two holidays), plus the exchange's year-end break (Dec 31 – Jan 3).
 * The equinoxes use the standard approximation, valid 1980–2099 (the official dates are
 * announced a year ahead and have matched it so far). The Olympic-year moves of 2020 / 2021 and
 * the Emperor's Birthday change (12/23 → 2/23 from 2020) are included; other one-off closures
 * (system failures, imperial events such as 2019) are not modelled.
 */
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const weekday = (date: IsoDate) => parseDate(date).getUTCDay();

/** The n-th (1-based) Monday of a month. */
function nthMonday(y: number, m: number, n: number): IsoDate {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return ymd(y, m, 1 + ((1 - first + 7) % 7) + (n - 1) * 7);
}

const vernalEquinox = (y: number) => Math.floor(20.8431 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));
const autumnalEquinox = (y: number) => Math.floor(23.2488 + 0.242194 * (y - 1980) - Math.floor((y - 1980) / 4));

/** National holidays of one year (date → Japanese name), substitute and in-between days included. */
export function jpNationalHolidays(year: number): Map<IsoDate, string> {
  const h = new Map<IsoDate, string>();
  const set = (date: IsoDate, name: string) => h.set(date, name);
  set(ymd(year, 1, 1), "元日");
  set(nthMonday(year, 1, 2), "成人の日");
  set(ymd(year, 2, 11), "建国記念の日");
  if (year >= 2020) set(ymd(year, 2, 23), "天皇誕生日");
  set(ymd(year, 3, vernalEquinox(year)), "春分の日");
  set(ymd(year, 4, 29), "昭和の日");
  set(ymd(year, 5, 3), "憲法記念日");
  set(ymd(year, 5, 4), "みどりの日");
  set(ymd(year, 5, 5), "こどもの日");
  if (year === 2020) {
    set("2020-07-23", "海の日");
    set("2020-07-24", "スポーツの日");
    set("2020-08-10", "山の日");
  } else if (year === 2021) {
    set("2021-07-22", "海の日");
    set("2021-07-23", "スポーツの日");
    set("2021-08-08", "山の日");
  } else {
    set(nthMonday(year, 7, 3), "海の日");
    if (year >= 2016) set(ymd(year, 8, 11), "山の日");
    set(nthMonday(year, 10, 2), year >= 2020 ? "スポーツの日" : "体育の日");
  }
  set(nthMonday(year, 9, 3), "敬老の日");
  set(ymd(year, 9, autumnalEquinox(year)), "秋分の日");
  set(ymd(year, 11, 3), "文化の日");
  set(ymd(year, 11, 23), "勤労感謝の日");
  if (year >= 1989 && year <= 2018) set(ymd(year, 12, 23), "天皇誕生日");

  const base = [...h.keys()].sort();
  // 国民の休日: a day that is not a holiday itself, with holidays on both sides (not Sunday)
  for (const d of base) {
    const mid = addDays(d, 1);
    if (!h.has(mid) && h.has(addDays(d, 2)) && weekday(mid) !== 0) h.set(mid, "国民の休日");
  }
  // 振替休日: a holiday on Sunday → the next day that is not a holiday
  for (const d of base) {
    if (weekday(d) !== 0) continue;
    let next = addDays(d, 1);
    while (h.has(next)) next = addDays(next, 1);
    h.set(next, "振替休日");
  }
  return h;
}

const cache = new Map<number, Map<IsoDate, string>>();

/** TSE closed days of one year that fall on weekdays (weekends are always closed). */
export function jpMarketHolidays(year: number): Map<IsoDate, string> {
  const hit = cache.get(year);
  if (hit) return hit;
  const out = new Map<IsoDate, string>();
  for (const [d, name] of jpNationalHolidays(year)) if (isWeekday(d)) out.set(d, name);
  for (const [d, name] of [[ymd(year, 1, 1), "元日"], [ymd(year, 1, 2), "年始休業"], [ymd(year, 1, 3), "年始休業"], [ymd(year, 12, 31), "年末休業"]] as const) {
    if (isWeekday(d) && !out.has(d)) out.set(d, name);
  }
  cache.set(year, out);
  return out;
}

export function jpHoliday(date: IsoDate): string | null {
  return jpMarketHolidays(Number(date.slice(0, 4))).get(date) ?? null;
}

export function isJpTradingDay(date: IsoDate): boolean {
  return isWeekday(date) && jpHoliday(date) === null;
}

/** TSE trading days in [from, to], every `step`-th one. */
export function jpTradingDays(from: IsoDate, to: IsoDate, step = 1): IsoDate[] {
  const out: IsoDate[] = [];
  let i = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!isJpTradingDay(d)) continue;
    if (i++ % step === 0) out.push(d);
  }
  return out;
}

export function jpHolidaysBetween(from: IsoDate, to: IsoDate): Array<{ date: IsoDate; name: string }> {
  const out: Array<{ date: IsoDate; name: string }> = [];
  for (let y = Number(from.slice(0, 4)); y <= Number(to.slice(0, 4)); y++) {
    for (const [date, name] of jpMarketHolidays(y)) if (date >= from && date <= to) out.push({ date, name });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
