import type { Bar } from "../signals/technical.ts";

/**
 * Twelve Data REST client for daily bars (https://twelvedata.com/docs#time-series).
 * Free plan (2026): 800 credits/day, 8 credits/minute, 1 credit per symbol per request.
 * The key is sent in the Authorization header, never in the URL, so it cannot leak
 * into logs or error messages.
 */
export interface TwelveDataOptions {
  apiKey: string;
  /** Requests per minute to stay under (free plan: 8). */
  perMinute?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
}

/** Bad key, plan limits, etc.: retrying other symbols is pointless. */
export class TwelveDataAuthError extends Error {
  override name = "TwelveDataAuthError";
}

export class TwelveDataError extends Error {
  override name = "TwelveDataError";
  readonly code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

type Obj = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN);

/** Parses a time_series response body. Returns [] for "no data in the requested range". */
export function parseTimeSeries(body: unknown, symbol: string): Bar[] {
  if (!body || typeof body !== "object") throw new TwelveDataError(`${symbol}: unexpected response`);
  const o = body as Obj;
  if (o["status"] === "error") {
    const code = typeof o["code"] === "number" ? o["code"] : undefined;
    const msg = String(o["message"] ?? "error");
    if (code === 400 && /no data is available/i.test(msg)) return [];
    if (code === 401 || code === 403) throw new TwelveDataAuthError(`Twelve Data rejected the request (${code}): ${msg}`);
    throw new TwelveDataError(`${symbol}: ${code ?? "?"} ${msg}`, code);
  }
  const values = o["values"];
  if (!Array.isArray(values)) throw new TwelveDataError(`${symbol}: response has no values`);
  const bars: Bar[] = [];
  for (const v of values as Obj[]) {
    const date = String(v["datetime"] ?? "").slice(0, 10);
    const bar: Bar = { date, open: num(v["open"]), high: num(v["high"]), low: num(v["low"]), close: num(v["close"]), volume: num(v["volume"] ?? 0) };
    if (!Number.isFinite(bar.volume)) bar.volume = 0;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TwelveDataError(`${symbol}: bad datetime ${JSON.stringify(v["datetime"])}`);
    // Refuse to guess: a non-numeric price is an API change, not a value to skip silently.
    if (![bar.open, bar.high, bar.low, bar.close].every((x) => Number.isFinite(x) && x > 0)) throw new TwelveDataError(`${symbol} ${date}: non-numeric price`);
    bars.push(bar);
  }
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}

export class TwelveDataClient {
  readonly #o: Required<Omit<TwelveDataOptions, "apiKey">> & { apiKey: string };
  #last = Number.NEGATIVE_INFINITY;

  constructor(o: TwelveDataOptions) {
    if (!o.apiKey) throw new TwelveDataAuthError("Twelve Data API key is empty");
    this.#o = {
      apiKey: o.apiKey,
      perMinute: o.perMinute ?? 8,
      baseUrl: o.baseUrl ?? "https://api.twelvedata.com",
      fetchImpl: o.fetchImpl ?? ((i, init) => fetch(i, init)),
      sleep: o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
      clock: o.clock ?? Date.now,
    };
  }

  /** Daily bars, oldest first. Either the last `outputsize` bars or everything since `startDate`. */
  async dailyBars(symbol: string, q: { outputsize?: number; startDate?: string }): Promise<Bar[]> {
    const params = new URLSearchParams({ symbol, interval: "1day", order: "asc", outputsize: String(q.outputsize ?? 5000) });
    if (q.startDate) params.set("start_date", q.startDate);
    const url = `${this.#o.baseUrl}/time_series?${params}`;
    for (let attempt = 0; ; attempt++) {
      await this.#throttle();
      let body: unknown;
      try {
        const res = await this.#o.fetchImpl(url, { headers: { authorization: `apikey ${this.#o.apiKey}` }, signal: AbortSignal.timeout(30_000) });
        if (res.status === 401 || res.status === 403) throw new TwelveDataAuthError(`Twelve Data rejected the request (HTTP ${res.status})`);
        if (res.status === 429) body = { status: "error", code: 429, message: "rate limited" };
        else if (!res.ok) throw new TwelveDataError(`${symbol}: HTTP ${res.status}`, res.status);
        else body = await res.json();
      } catch (e) {
        if (e instanceof TwelveDataError || e instanceof TwelveDataAuthError) throw e;
        const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
        throw new TwelveDataError(`cannot reach ${new URL(this.#o.baseUrl).host}: ${e instanceof Error ? e.message : String(e)}${cause}`);
      }
      try {
        return parseTimeSeries(body, symbol);
      } catch (e) {
        // Minute quota exhausted (e.g. another process used credits): wait for the next minute once.
        if (e instanceof TwelveDataError && e.code === 429 && attempt === 0) {
          await this.#o.sleep(61_000);
          continue;
        }
        throw e;
      }
    }
  }

  async #throttle(): Promise<void> {
    const gap = 60_000 / this.#o.perMinute;
    const wait = this.#last + gap - this.#o.clock();
    if (wait > 0) await this.#o.sleep(wait);
    this.#last = Math.max(this.#o.clock(), this.#last + gap);
  }
}
