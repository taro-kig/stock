/**
 * Webull Japan OpenAPI client (REST, HMAC-signed). No official Node SDK exists;
 * paths, parameters and the signing scheme follow the official Python SDK
 * (webull-openapi-python-sdk 3.0.4) and response shapes follow the official
 * MCP server (webull-openapi-mcp 1.2.6). See docs/webull.md for what still
 * needs confirming against a real account.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { BrokerAccount, BrokerClient, BrokerPosition, OrderRequest } from "./broker.ts";

export const WebullConfig = z.strictObject({
  /** API host for Webull Japan. */
  endpoint: z.string().default("api.webull.co.jp"),
  appKeyEnv: z.string().default("WEBULL_APP_KEY"),
  appSecretEnv: z.string().default("WEBULL_APP_SECRET"),
  /**
   * dry_run: orders are only *previewed* by Webull (nothing is placed). Webull has no paper
   * account, so this is the default. live: real orders (also needs accountId + STOCKAI_LIVE_TRADING).
   */
  trading: z.enum(["dry_run", "live"]).default("dry_run"),
  /** Recommended: refuses to run against any other account. Required for live. */
  accountId: z.string().optional(),
  /** 特定口座 = SPECIFIC, 一般口座 = GENERAL. Required by Webull JP for every order. */
  accountTaxType: z.enum(["SPECIFIC", "GENERAL"]).optional(),
  /** jp -> market JP / JPY / TSE tick grid, us -> market US / USD. */
  market: z.enum(["jp", "us"]).default("jp"),
  /** Where the 2FA-approved access token is kept (git-ignored data dir). */
  tokenFile: z.string().default("data/webull-token.json"),
  limitOffsetBps: z.number().min(0).max(500).default(50),
  maxOrderValue: z.number().positive().default(2_000_000),
  maxOrdersPerRun: z.number().int().positive().default(6),
  timeoutMs: z.number().int().positive().default(15_000),
});
export type WebullConfig = z.output<typeof WebullConfig>;

export class WebullApiError extends Error {
  override name = "WebullApiError";
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown, what: string) {
    super(`Webull ${what} failed: HTTP ${status} ${JSON.stringify(body).slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

/** The access token is not approved yet: someone must approve the login in the Webull app. */
export class WebullAuthRequired extends Error {
  override name = "WebullAuthRequired";
}

// ── signing ─────────────────────────────────────────────────────────────

/** Python's urllib.parse.quote(s, safe=""): everything but A-Z a-z 0-9 - _ . ~ is %-encoded. */
export function strictEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface SignInput {
  host: string;
  path: string;
  query?: Record<string, string> | undefined;
  /** Exact JSON text that will be sent (compact). */
  bodyText?: string | undefined;
  appKey: string;
  appSecret: string;
  timestamp: string;
  nonce: string;
}

/**
 * Signature as computed by the official SDK (default_signature_composer.py):
 * path & sorted(lower-cased signing headers + query) & SHA256(body) upper-hex,
 * strictly %-encoded, HMAC-SHA256 with key `secret + "&"`, base64.
 */
export function signRequest(i: SignInput): { headers: Record<string, string>; toSign: string } {
  const signHeaders: Record<string, string> = {
    "x-app-key": i.appKey,
    "x-timestamp": i.timestamp,
    "x-signature-version": "1.0",
    "x-signature-algorithm": "HMAC-SHA256",
    "x-signature-nonce": i.nonce,
  };
  const params: Record<string, string> = { ...signHeaders, host: i.host };
  for (const [k, v] of Object.entries(i.query ?? {})) params[k] = k in params ? `${params[k]}&${v}` : v;
  let s = `${i.path}&${Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&")}`;
  if (i.bodyText !== undefined) s += `&${createHash("sha256").update(i.bodyText, "utf8").digest("hex").toUpperCase()}`;
  const toSign = strictEncode(s);
  const signature = createHmac("sha256", `${i.appSecret}&`).update(toSign, "utf8").digest("base64");
  return { headers: { ...signHeaders, "x-signature": signature }, toSign };
}

/** Webull wants client_order_id like a uuid hex (32 chars); derived from our idempotency key so a retry reuses it. */
export function clientOrderId(ref: string): string {
  return createHash("sha256").update(ref).digest("hex").slice(0, 32);
}

// ── response helpers ────────────────────────────────────────────────────

type Obj = Record<string, unknown>;

/** Lists come either bare or wrapped (data / items / orders / result / list). */
export function asList(v: unknown, what: string): Obj[] {
  if (Array.isArray(v)) return v as Obj[];
  if (v && typeof v === "object") {
    for (const k of ["data", "items", "orders", "result", "list"]) {
      const x = (v as Obj)[k];
      if (Array.isArray(x)) return x as Obj[];
    }
  }
  throw new Error(`unexpected ${what} response: ${JSON.stringify(v).slice(0, 200)}`);
}

/** Webull sends numbers as strings; anything non-numeric is a hard error (fail closed). */
export function num(v: unknown, field: string): number {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : Number.NaN;
  if (!Number.isFinite(n)) throw new Error(`unexpected value for ${field}: ${JSON.stringify(v)}`);
  return n;
}

/** client_order_id of every order in an open-orders response, including grouped/combo children. */
export function collectClientOrderIds(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) collectClientOrderIds(x, out);
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Obj)) {
      if (k === "client_order_id" && typeof x === "string" && x) out.push(x);
      else if (x && typeof x === "object") collectClientOrderIds(x, out);
    }
  }
  return out;
}

// ── token storage ───────────────────────────────────────────────────────

const StoredToken = z.object({ token: z.string(), expires: z.union([z.number(), z.string()]).optional(), status: z.string() });
type StoredToken = z.output<typeof StoredToken>;

function loadToken(file: string): StoredToken | undefined {
  if (!existsSync(file)) return undefined;
  const r = StoredToken.safeParse(JSON.parse(readFileSync(file, "utf8")));
  return r.success ? r.data : undefined;
}

function saveToken(file: string, t: StoredToken): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(t), { encoding: "utf8", mode: 0o600 });
  chmodSync(file, 0o600);
}

// ── client ──────────────────────────────────────────────────────────────

export interface WebullClientOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  nonce?: () => string;
  sleep?: (ms: number) => Promise<void>;
}

export class WebullClient implements BrokerClient {
  readonly #cfg: WebullConfig;
  readonly #key: string;
  readonly #secret: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #nonce: () => string;
  readonly #sleep: (ms: number) => Promise<void>;
  #token: string | undefined;

  constructor(cfg: WebullConfig, opts: WebullClientOptions = {}) {
    const env = opts.env ?? process.env;
    const key = env[cfg.appKeyEnv];
    const secret = env[cfg.appSecretEnv];
    if (!key || !secret) throw new Error(`Webull credentials missing: set ${cfg.appKeyEnv} and ${cfg.appSecretEnv}`);
    this.#cfg = cfg;
    this.#key = key;
    this.#secret = secret;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#now = opts.now ?? (() => new Date());
    this.#nonce = opts.nonce ?? randomUUID;
    this.#sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Connects for unattended use: an approved token must already exist (see `stockai webull auth`). */
  static async connect(cfg: WebullConfig, opts: WebullClientOptions = {}): Promise<WebullClient> {
    const c = new WebullClient(cfg, opts);
    await c.ensureToken({ waitSeconds: 0 });
    return c;
  }

  get currency(): "JPY" | "USD" {
    return this.#cfg.market === "jp" ? "JPY" : "USD";
  }

  async request(method: "GET" | "POST", path: string, opts: { query?: Record<string, string>; body?: unknown; headers?: Record<string, string> } = {}): Promise<unknown> {
    const bodyText = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const ts = this.#now().toISOString().replace(/\.\d{3}Z$/, "Z");
    const { headers } = signRequest({ host: this.#cfg.endpoint, path, query: opts.query, bodyText, appKey: this.#key, appSecret: this.#secret, timestamp: ts, nonce: this.#nonce() });
    const qs = opts.query && Object.keys(opts.query).length ? `?${new URLSearchParams(opts.query).toString()}` : "";
    let res: Response;
    try {
      res = await this.#fetch(`https://${this.#cfg.endpoint}${path}${qs}`, {
      method,
      headers: {
        ...headers,
        "x-version": "v3",
        ...(this.#token ? { "x-access-token": this.#token } : {}),
        ...(bodyText !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      ...(bodyText !== undefined ? { body: bodyText } : {}),
      signal: AbortSignal.timeout(this.#cfg.timeoutMs),
      });
    } catch (e) {
      const cause = e instanceof Error ? ((e.cause as Error | undefined)?.message ?? e.message) : String(e);
      throw new Error(`cannot reach Webull at ${this.#cfg.endpoint} (${method} ${path}): ${cause}`);
    }
    const text = await res.text();
    let json: unknown = text;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* keep text */
    }
    if (!res.ok) throw new WebullApiError(res.status, json, `${method} ${path}`);
    return json;
  }

  /**
   * Token flow of the official SDK: if the account requires it, create (or renew) an access
   * token; a new token stays PENDING until approved in the Webull app (2FA). With
   * waitSeconds = 0 a pending token throws WebullAuthRequired instead of blocking.
   */
  async ensureToken(opts: { waitSeconds: number; onPending?: () => void }): Promise<void> {
    const conf = (await this.request("GET", "/openapi/config")) as Obj | null;
    if (!conf?.["token_check_enabled"]) return;
    const local = loadToken(this.#cfg.tokenFile);
    const created = StoredToken.parse(await this.request("POST", "/auth/tokens/create", { body: local?.token ? { token: local.token } : {} }));
    saveToken(this.#cfg.tokenFile, created);
    if (created.status === "NORMAL") {
      this.#token = created.token;
      return;
    }
    if (opts.waitSeconds <= 0) {
      throw new WebullAuthRequired("Webull のアクセストークンが未承認です。`npm run stockai -- webull auth` を実行し、Webull アプリで承認してください。");
    }
    opts.onPending?.();
    const deadline = this.#now().getTime() + opts.waitSeconds * 1000;
    while (this.#now().getTime() < deadline) {
      await this.#sleep(5000);
      const checked = StoredToken.parse(await this.request("POST", "/auth/tokens/check", { body: { token: created.token } }));
      saveToken(this.#cfg.tokenFile, checked);
      if (checked.status === "NORMAL") {
        this.#token = checked.token;
        return;
      }
      if (checked.status === "INVALID" || checked.status === "EXPIRED") throw new Error(`Webull token ${checked.status}; run \`stockai webull auth\` again`);
    }
    throw new WebullAuthRequired("Webull アプリでの承認が時間内に確認できませんでした");
  }

  async accountIds(): Promise<string[]> {
    return asList(await this.request("GET", "/trading/accounts/list"), "account list").map((a) => String(a["account_id"] ?? "")).filter(Boolean);
  }

  async account(): Promise<BrokerAccount> {
    const ids = await this.accountIds();
    const accountId = this.#cfg.accountId ?? (ids.length === 1 ? ids[0]! : undefined);
    if (!accountId) throw new Error(`several Webull accounts visible (${ids.join(", ")}); set webull.accountId`);
    if (!ids.includes(accountId)) throw new Error(`account ${accountId} not visible on this API key (have: ${ids.join(", ")})`);
    const bal = (await this.request("GET", "/trading/assets/balances/get", { query: { account_id: accountId, total_asset_currency: this.currency } })) as Obj;
    const cash = num(bal["total_cash_balance"], "total_cash_balance");
    const marketValue = bal["total_market_value"] === undefined ? 0 : num(bal["total_market_value"], "total_market_value");
    const netLiq = bal["total_net_liquidation_value"] !== undefined ? num(bal["total_net_liquidation_value"], "total_net_liquidation_value") : cash + marketValue;
    const raw = await this.request("GET", "/trading/assets/positions/list", { query: { account_id: accountId } });
    const rows = raw === null || (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as Obj).length === 0) ? [] : asList(raw, "positions");
    const positions: BrokerPosition[] = rows
      .filter((p) => (p["instrument_type"] ?? "EQUITY") === "EQUITY")
      .map((p) => ({ ticker: String(p["symbol"]), shares: num(p["quantity"], "quantity"), avgCost: num(p["cost_price"] ?? 0, "cost_price") }));
    return { accountId, currency: String(bal["total_asset_currency"] ?? this.currency), netLiquidation: netLiq, cash, positions };
  }

  /** Open orders are reported by client_order_id, i.e. in the hashed id space. */
  refKey(ref: string): string {
    return clientOrderId(ref);
  }

  async openOrderRefs(): Promise<string[]> {
    const id = this.#cfg.accountId ?? (await this.account()).accountId;
    return collectClientOrderIds(await this.request("GET", "/trading/orders/open-orders/list", { query: { account_id: id } }));
  }

  /** The JSON order Webull JP expects (all numbers as strings). */
  orderBody(req: OrderRequest, accountId: string): Obj {
    if (!this.#cfg.accountTaxType) throw new Error("set webull.accountTaxType (SPECIFIC = 特定口座 / GENERAL = 一般口座)");
    return {
      account_id: accountId,
      new_orders: [
        {
          combo_type: "NORMAL",
          client_order_id: clientOrderId(req.ref),
          symbol: req.ticker,
          instrument_type: "EQUITY",
          market: this.#cfg.market.toUpperCase(),
          order_type: "LIMIT",
          limit_price: String(req.limitPrice),
          quantity: String(req.shares),
          support_trading_session: "CORE",
          side: req.side === "buy" ? "BUY" : "SELL",
          time_in_force: "DAY",
          entrust_type: "QTY",
          account_tax_type: this.#cfg.accountTaxType,
        },
      ],
    };
  }

  #category(): Record<string, string> {
    return { category: `${this.#cfg.market.toUpperCase()}_EQUITY` };
  }

  /** Places nothing: Webull validates the order and returns fees/estimates. Used for dry runs. */
  async previewLimitOrder(req: OrderRequest, accountId: string): Promise<string> {
    const r = await this.request("POST", "/trading/orders/preview", { body: this.orderBody(req, accountId), headers: this.#category() });
    return JSON.stringify(r).slice(0, 300);
  }

  /** Never retried automatically: a retry is safe only via the next run's idempotency checks. */
  async placeLimitOrder(req: OrderRequest, accountId: string): Promise<string> {
    const r = (await this.request("POST", "/trading/orders/place", { body: this.orderBody(req, accountId), headers: this.#category() })) as Obj | null;
    return String(r?.["order_id"] ?? r?.["client_order_id"] ?? clientOrderId(req.ref));
  }

  async close(): Promise<void> {}
}
