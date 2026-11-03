import type { ScheduleItem } from "../shared/types.ts";

export interface ScheduleEntry {
  workflow: string;
  file: string;
  at: string;
  days: number[];
  skipHolidays?: boolean;
}

export interface SchedulerDeps {
  /** Run (or queue) the workflow file now. */
  trigger: (file: string) => void;
  /** A run of this workflow for today's date, if any. */
  ranToday: (workflow: string) => ScheduleItem["ranToday"];
  /** Disabled workflows are skipped (not queued, no error). */
  isDisabled?: (workflow: string) => boolean;
  /** Name of the exchange holiday on a run date (YYYY-MM-DD, UTC like the engine's asOf), or null. */
  holiday?: (asOf: string, workflow?: string) => string | null;
  clock?: () => Date;
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h! * 60 + m!;
};

/** Fires each entry once per day, at or after its time, in the server's local time zone. */
export class Scheduler {
  readonly #entries: ScheduleEntry[];
  readonly #deps: SchedulerDeps;
  readonly #fired = new Set<string>();
  #timer: NodeJS.Timeout | undefined;

  constructor(entries: ScheduleEntry[], deps: SchedulerDeps) {
    this.#entries = entries;
    this.#deps = deps;
  }

  #now(): Date {
    return this.#deps.clock?.() ?? new Date();
  }

  start(intervalMs = 30_000): void {
    this.tick();
    this.#timer = setInterval(() => this.tick(), intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  tick(): string[] {
    const now = this.#now();
    const day = now.getDay();
    const mins = now.getHours() * 60 + now.getMinutes();
    const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const fired: string[] = [];
    for (const e of this.#entries) {
      const key = `${dateKey}|${e.file}|${e.at}`;
      if (!e.days.includes(day) || mins < minutes(e.at) || this.#fired.has(key)) continue;
      this.#fired.add(key);
      if (this.#deps.isDisabled?.(e.workflow)) continue;
      if (e.skipHolidays !== false && this.#deps.holiday?.(now.toISOString().slice(0, 10), e.workflow)) continue; // market closed: no new data
      if (this.#deps.ranToday(e.workflow)) continue; // already run (e.g. manually) today
      this.#deps.trigger(e.file);
      fired.push(e.file);
    }
    return fired;
  }

  status(): ScheduleItem[] {
    const now = this.#now();
    return this.#entries.map((e) => {
      const disabled = this.#deps.isDisabled?.(e.workflow) ?? false;
      return { ...e, nextAt: disabled ? null : nextAt(e, now, e.skipHolidays !== false && this.#deps.holiday ? (d) => this.#deps.holiday!(d, e.workflow) : undefined), ranToday: this.#deps.ranToday(e.workflow), disabled };
    });
  }
}

function nextAt(e: ScheduleEntry, now: Date, holiday?: (asOf: string) => string | null): string | null {
  if (!e.days.length) return null;
  for (let i = 0; i < 15; i++) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    const [h, m] = e.at.split(":").map(Number);
    d.setHours(h!, m!, 0, 0);
    if (e.days.includes(d.getDay()) && d > now && !holiday?.(d.toISOString().slice(0, 10))) return d.toISOString();
  }
  return null;
}
