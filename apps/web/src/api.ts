import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { StreamEvent } from "../shared/types.ts";

/** Optional access token: passed once as ?token=…, then remembered. */
const TOKEN_KEY = "stockai.token";
const fromUrl = new URLSearchParams(location.search).get("token");
if (fromUrl) {
  localStorage.setItem(TOKEN_KEY, fromUrl);
  history.replaceState(null, "", location.pathname + location.hash);
}
const token = localStorage.getItem(TOKEN_KEY) ?? "";
const headers = (): Record<string, string> => (token ? { "x-stockai-token": token } : {});

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function parse<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? res.statusText);
  return body as T;
}

export const get = async <T,>(path: string): Promise<T> => parse<T>(await fetch(path, { headers: headers() }));
export const post = async <T,>(path: string, body: unknown): Promise<T> =>
  parse<T>(await fetch(path, { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify(body) }));
export const put = async <T,>(path: string, body: unknown): Promise<T> =>
  parse<T>(await fetch(path, { method: "PUT", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify(body) }));

const listeners = new Set<(e: StreamEvent) => void>();
/** Subscribe to raw stream events (e.g. live node status in the editor). Returns an unsubscribe function. */
export function onStream(fn: (e: StreamEvent) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Increments whenever the server reports activity; views refetch on change. */
export const PulseContext = createContext(0);

export function useStream(onEvent: (e: StreamEvent) => void): { connected: boolean; pulse: number } {
  const [connected, setConnected] = useState(false);
  const [pulse, setPulse] = useState(0);
  const cb = useRef(onEvent);
  cb.current = onEvent;
  useEffect(() => {
    let timer: number | undefined;
    const es = new EventSource(`/api/stream${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (m) => {
      const e = JSON.parse(m.data as string) as StreamEvent;
      cb.current(e);
      for (const l of listeners) l(e);
      // coalesce bursts (a run emits one event per node)
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setPulse((p) => p + 1), 250);
    };
    return () => {
      window.clearTimeout(timer);
      es.close();
    };
  }, []);
  return { connected, pulse };
}

export interface Loaded<T> {
  data: T | undefined;
  error: string | undefined;
  loading: boolean;
  reload: () => void;
}

/** GET with refetch on server activity. Keeps the previous data while reloading (no flicker). */
export function useApi<T>(path: string | null): Loaded<T> {
  const pulse = useContext(PulseContext);
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean; path?: string | null }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setState((s) => ({ ...s, loading: true, ...(s.path !== path ? { data: undefined, error: undefined } : {}), path }));
    get<T>(path).then(
      (data) => alive && setState({ data, loading: false, path }),
      (e: unknown) => alive && setState((s) => ({ ...s, error: e instanceof Error ? e.message : String(e), loading: false })),
    );
    return () => {
      alive = false;
    };
  }, [path, pulse, nonce]);
  return { data: path ? state.data : undefined, error: state.error, loading: state.loading, reload };
}
