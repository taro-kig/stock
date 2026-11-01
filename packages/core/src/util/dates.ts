/** Calendar helpers. Dates are ISO strings "YYYY-MM-DD" (no time zone ambiguity). */
export type IsoDate = string;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(s: string): IsoDate {
  if (!ISO.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) throw new Error(`invalid date: ${s}`);
  return s;
}

export function toIsoDate(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

export function today(): IsoDate {
  return toIsoDate(new Date());
}

export function parseDate(s: IsoDate): Date {
  return new Date(`${s}T00:00:00Z`);
}

export function addDays(s: IsoDate, n: number): IsoDate {
  const d = parseDate(s);
  d.setUTCDate(d.getUTCDate() + n);
  return toIsoDate(d);
}

export function isWeekday(s: IsoDate): boolean {
  const wd = parseDate(s).getUTCDay();
  return wd !== 0 && wd !== 6;
}

/** Weekdays in [from, to], every `step`-th one. (Exchange holidays are not modelled.) */
export function weekdays(from: IsoDate, to: IsoDate, step = 1): IsoDate[] {
  const out: IsoDate[] = [];
  let i = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) {
    if (!isWeekday(d)) continue;
    if (i++ % step === 0) out.push(d);
  }
  return out;
}

/** End of the given day in UTC: the "now" used when replaying a past date. */
export function endOfDay(s: IsoDate): Date {
  return new Date(`${s}T23:59:59Z`);
}

export function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 86_400_000;
}
