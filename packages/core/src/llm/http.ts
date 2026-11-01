import { LLMError } from "./types.ts";

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** POST JSON with exponential backoff on rate limits / transient server errors. */
export async function postJsonWithRetry(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  opts: RetryOptions = {},
): Promise<unknown> {
  const { maxAttempts = 4, baseDelayMs = 2000, timeoutMs = 60_000 } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return await res.json();
      const text = (await res.text()).slice(0, 500);
      if (!RETRY_STATUS.has(res.status)) throw new LLMError(`HTTP ${res.status}: ${text}`);
      lastErr = `HTTP ${res.status}: ${text}`;
    } catch (e) {
      if (e instanceof LLMError) throw e;
      const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
      lastErr = `${e instanceof Error ? e.message : String(e)}${cause} (${new URL(url).host})`;
    }
    if (attempt < maxAttempts - 1) await sleep(baseDelayMs * 2 ** attempt);
  }
  throw new LLMError(`request failed after ${maxAttempts} attempts: ${lastErr}`);
}
