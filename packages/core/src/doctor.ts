import { accessSync, constants, existsSync } from "node:fs";
import { connect } from "node:net";
import { fetchEarningsCalendar } from "./data/earnings.ts";
import { fetchEarningsEstimates, isPremiumAnswer } from "./data/estimates.ts";
import { fundamentalsAt, parseCompanyFacts } from "./data/fundamentals.ts";
import { SecClient } from "./data/sec.ts";
import { parseTimeSeries } from "./data/twelveData.ts";
import { buildProvider, type ModelSpec } from "./llm/factory.ts";
import { usedModelNames } from "./llm/roles.ts";
import type { LLMProvider } from "./llm/types.ts";
import { isDiscordWebhookUrl } from "./notify/discord.ts";
import { PROMPT_FAMILIES } from "./prompts/registry.ts";
import type { Services } from "./services.ts";
import { fetchFeed } from "./signals/rss.ts";
import { backupStatus } from "./util/backup.ts";
import { toIsoDate } from "./util/dates.ts";

/**
 * Connection check ("doctor"): one small, real request per external service, so a new
 * setup shows what works before the first scheduled run. Requests are kept minimal:
 * one tiny LLM call per model, 1 Twelve Data credit, 1 Alpha Vantage request (stored as
 * the day's calendar, so the daily run does not spend another), a Discord webhook lookup
 * that posts nothing, and read-only SEC / RSS fetches.
 */
export type CheckStatus = "ok" | "warn" | "fail" | "skip";

export interface CheckResult {
  id: string;
  group: "config" | "llm" | "data" | "notify" | "broker" | "storage";
  label: string;
  status: CheckStatus;
  /** What was found (or the error). */
  detail: string;
  /** How to fix it, when not ok. */
  hint?: string;
  ms: number;
}

export interface DoctorOptions {
  /** Only these groups. */
  groups?: CheckResult["group"][];
  /** Builds a provider for a model spec (tests inject a fake). */
  buildModel?: (spec: Parameters<typeof buildProvider>[0], env: NodeJS.ProcessEnv) => LLMProvider;
  /** Probe a TCP port (tests inject). */
  probePort?: (host: string, port: number) => Promise<boolean>;
  now?: Date;
}

const errText = (e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
  return `${msg}${cause}`.slice(0, 400);
};

const NETWORK_HINT = "ネットワーク・プロキシ・ファイアウォールでこの宛先が止められていないか確認";

function probe(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

export type ModelTest = Omit<CheckResult, "id" | "group" | "label" | "ms">;

/** One tiny JSON-mode call to a model (doctor and the model settings screen). Costs a few tokens. */
export async function testModel(s: Services, spec: ModelSpec, build: DoctorOptions["buildModel"] = buildProvider): Promise<ModelTest> {
  if (!s.env[spec.apiKeyEnv]) return { status: "fail", detail: `${spec.apiKeyEnv} が未設定`, hint: `⚙ 設定で ${spec.apiKeyEnv} を入力` };
  const p = build(spec, s.env);
  const r = await p.generate({ system: "Answer with JSON only.", user: 'Return {"ok": true}', temperature: 0, jsonMode: true });
  s.budget.record(p.name, r);
  let ok = false;
  try {
    ok = (JSON.parse(r.text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as { ok?: unknown }).ok === true;
  } catch {
    ok = false;
  }
  return ok
    ? { status: "ok", detail: `応答あり · ${Math.round(r.latencyMs)} ms · ${r.inputTokens}/${r.outputTokens} tokens` }
    : { status: "warn", detail: `応答はあるが JSON で返らない: ${r.text.slice(0, 120)}`, hint: "モデル名・JSON モード対応を確認" };
}

export async function runDoctor(s: Services, o: DoctorOptions = {}): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const want = (g: CheckResult["group"]) => !o.groups || o.groups.includes(g);
  const now = o.now ?? new Date();
  const check = async (id: string, group: CheckResult["group"], label: string, fn: () => Promise<Omit<CheckResult, "id" | "group" | "label" | "ms">>) => {
    if (!want(group)) return;
    const t0 = Date.now();
    try {
      out.push({ id, group, label, ...(await fn()), ms: Date.now() - t0 });
    } catch (e) {
      out.push({ id, group, label, status: "fail", detail: errText(e), hint: NETWORK_HINT, ms: Date.now() - t0 });
    }
  };
  const c = s.config;
  const us = c.market.currency === "USD";
  const env = s.env;

  // ── config ──────────────────────────────────────────────────
  await check("config", "config", "設定ファイル", async () => ({
    status: Object.keys(c.watchlist).length ? "ok" : "fail",
    detail: `${s.configPath ?? "(パス不明)"} · ${us ? "米国株" : "日本株"} · ${Object.keys(c.watchlist).length} 銘柄 · ベンチマーク ${c.market.benchmark ?? "なし"}`,
    ...(Object.keys(c.watchlist).length ? {} : { hint: "「6 銘柄」で銘柄を追加" }),
  }));
  await check("prompts", "config", "プロンプトの版", async () => {
    const keys = { event: c.prompts.event, judge: c.prompts.judge, redteam: c.prompts.redTeam, universe: c.prompts.universe } as const;
    const missing = PROMPT_FAMILIES.filter((f) => !s.prompts.list(f).some((p) => p.version === keys[f]));
    return missing.length
      ? { status: "fail", detail: `見つからない版: ${missing.map((f) => `${f}=${keys[f]}`).join(", ")}`, hint: "「8 プロンプト」で存在する版に切り替える" }
      : { status: "ok", detail: Object.values(keys).join(" · ") };
  });

  // ── LLM ─────────────────────────────────────────────────────
  if (want("llm")) {
    if (s.fake) {
      out.push({ id: "llm", group: "llm", label: "LLM", status: "skip", detail: "疑似モデル（--fake）で起動中", ms: 0 });
    } else {
      const m = c.models;
      const r = m ? s.resolvedModels() : undefined;
      const used = r ? usedModelNames(r) : [];
      // Only the models in use are called (the rest of the pool needs no key).
      const specs = (m?.pool ?? []).filter((x) => used.includes(x.name));
      if (r) {
        out.push({
          id: "llm:assign", group: "llm", label: "モデルの割り当て",
          status: r.notes.length ? "warn" : "ok",
          detail: `判断: ${r.judge.vote.join(" + ")}${r.judge.escalation ? ` → ${r.judge.escalation}` : ""} · 反対役: ${r.redteam ?? "なし"}${Object.values(r.auto).some(Boolean) ? "（おまかせ）" : ""}`,
          ...(r.notes.length ? { hint: r.notes.join(" / ") } : {}), ms: 0,
        });
      }
      if (!specs.length) out.push({ id: "llm", group: "llm", label: "LLM", status: "fail", detail: "config.models がない", hint: "config.yaml に models を書く", ms: 0 });
      for (const spec of specs) {
        await check(`llm:${spec.name}`, "llm", `LLM ${spec.name}（${spec.model}）`, () => testModel(s, spec, o.buildModel));
      }
    }
  }

  // ── data ────────────────────────────────────────────────────
  if (us) {
    await check("twelvedata", "data", "株価（Twelve Data）", async () => {
      const key = env["TWELVEDATA_API_KEY"];
      if (!key) return { status: "fail", detail: "TWELVEDATA_API_KEY が未設定", hint: "twelvedata.com で無料キーを取り、⚙ 設定で入力" };
      const sym = c.market.benchmark ?? Object.keys(c.watchlist)[0]!;
      const res = await s.fetch(`https://api.twelvedata.com/time_series?${new URLSearchParams({ symbol: sym, interval: "1day", outputsize: "5", order: "asc" })}`, {
        headers: { authorization: `apikey ${key}` }, signal: AbortSignal.timeout(20_000),
      });
      if (res.status === 401 || res.status === 403) return { status: "fail", detail: `キーが拒否された（HTTP ${res.status}）`, hint: "キーを確認" };
      const bars = parseTimeSeries(await res.json(), sym);
      const last = bars.at(-1);
      return last ? { status: "ok", detail: `${sym} 終値 ${last.close} (${last.date}) · 1 クレジット使用` } : { status: "warn", detail: `${sym} のデータが空`, hint: "銘柄コードを確認" };
    });

    await check("sec", "data", "SEC EDGAR（8-K・13D・Form 4・財務データ）", async () => {
      const ua = env["SEC_USER_AGENT"];
      if (!ua) return { status: "fail", detail: "SEC_USER_AGENT が未設定", hint: "⚙ 設定で「stockai 自分のメール」の形で入力" };
      const sec = new SecClient({ userAgent: ua, fetchImpl: s.fetch, sleep: s.sleep });
      const map = await sec.tickerMap();
      const t = Object.keys(c.watchlist).find((x) => map[x] !== undefined);
      const missing = Object.keys(c.watchlist).filter((x) => map[x] === undefined);
      if (!t) return { status: "warn", detail: "ウォッチリストの銘柄が SEC のティッカー一覧に無い", hint: "ティッカーを確認（米国の上場企業か）" };
      const { filings } = await sec.submissions(map[t]!);
      // the financials (XBRL company facts) of the same company, stored like the daily run would
      let finText: string;
      try {
        const facts = parseCompanyFacts(await sec.json(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(map[t]!).padStart(10, "0")}.json`));
        s.fundamentals.save(t, toIsoDate(now), facts);
        const fin = fundamentalsAt(t, facts, toIsoDate(now));
        finText = fin ? ` · 財務データ: ${fin.periodEnd.slice(0, 7)} 期まで（売上の前年比 ${fin.revenueTtmYoY === null ? "不明" : `${(fin.revenueTtmYoY * 100).toFixed(1)}%`}）` : " · 財務データ: 四半期の数字が見つからない";
      } catch (e) {
        finText = ` · 財務データ: 取得できない（${errText(e).slice(0, 120)}）`;
      }
      const since = now.getTime() - 90 * 86_400_000;
      const recent = filings.filter((f) => Date.parse(f.acceptedAt) > since);
      const n = (re: RegExp) => recent.filter((f) => re.test(f.form)).length;
      return {
        status: missing.length ? "warn" : "ok",
        detail: `ティッカー一覧 ${Object.keys(map).length.toLocaleString()} 社 · ${t} の直近90日: 8-K ${n(/^8-K/)}件・Form 4 ${n(/^4(\/A)?$/)}件・13D ${n(/13D/)}件${finText}${missing.length ? ` · 一覧に無い: ${missing.join(", ")}` : ""}`,
        ...(missing.length ? { hint: "一覧に無い銘柄は開示・インサイダー売買が取れない（ティッカーを確認）" } : {}),
      };
    });

    await check("alphavantage", "data", "決算予定（Alpha Vantage・任意）", async () => {
      const key = env["ALPHAVANTAGE_API_KEY"];
      if (!key) return { status: "skip", detail: "ALPHAVANTAGE_API_KEY が未設定（決算日のルールが働かないだけ）", hint: "使うなら alphavantage.co で無料キーを取り、⚙ 設定で入力" };
      const today = toIsoDate(now);
      if (s.earnings.fetchedOn(today)) {
        const last = s.earnings.lastFetch();
        return { status: "ok", detail: `今日は取得済み（${last?.rows ?? 0} 件）` };
      }
      const entries = await fetchEarningsCalendar(key, s.fetch);
      s.earnings.save(today, entries, now); // counts as today's download
      const mine = entries.filter((e) => e.ticker in c.watchlist).sort((a, b) => a.reportDate.localeCompare(b.reportDate));
      s.estimates.saveCalendar(today, mine); // and as today's consensus record
      return { status: "ok", detail: `${entries.length.toLocaleString()} 件 · ウォッチリスト ${mine.length} 件${mine[0] ? `（次: ${mine[0].ticker} ${mine[0].reportDate}）` : ""}` };
    });

    // One EARNINGS_ESTIMATES request: tells whether this key can use it, and what came back.
    await check("estimates", "data", "アナリスト予想（Alpha Vantage・任意）", async () => {
      const key = env["ALPHAVANTAGE_API_KEY"];
      if (!key) return { status: "skip", detail: "ALPHAVANTAGE_API_KEY が未設定" };
      const t = Object.keys(c.watchlist).find((x) => x !== c.market.benchmark);
      if (!t) return { status: "skip", detail: "ウォッチリストが空" };
      try {
        const snaps = await fetchEarningsEstimates(key, t, s.fetch);
        s.estimates.save(t, toIsoDate(now), snaps);
        if (!snaps.length) return { status: "warn", detail: `${t}: 応答は来たが予想の行を読み取れない`, hint: "データの形式が想定と違う可能性。自前の記録（決算予定の予想値）だけで動きます" };
        const parts = snaps.map((x) => `${x.horizon === "quarter" ? "四半期" : "通期"} ${x.period}: ${x.average} · 過去値 ${Object.keys(x.ago).join("/") || "なし"} 日前 · 修正件数 ${x.up === null && x.down === null ? "なし" : `${x.up ?? 0}↑ ${x.down ?? 0}↓`}`);
        return { status: "ok", detail: `${t} · ${parts.join(" · ")}` };
      } catch (e) {
        if (isPremiumAnswer(e)) return { status: "skip", detail: "このキーでは使えない（有料プラン向け）。決算予定の予想値を毎日記録して、修正を自前で計算します（1か月ほどで使えるようになる）" };
        throw e;
      }
    });
  }

  if (want("data")) {
    const tickers = Object.keys(c.watchlist).map(encodeURIComponent).join(",");
    for (const f of c.sources) {
      await check(`rss:${f.name}`, "data", `ニュース ${f.name}`, async () => {
        const docs = await fetchFeed(f.url.replaceAll("{tickers}", tickers), f.name, { fetchImpl: s.fetch, timeoutMs: 15_000 });
        const matched = docs.filter((d) => Object.keys(s.watchlist.match(d)).length).length;
        return docs.length
          ? { status: "ok", detail: `${docs.length} 件 · ウォッチリストに関係 ${matched} 件` }
          : { status: "warn", detail: "記事が 0 件", hint: "フィードの URL を確認" };
      });
    }
    if (!c.sources.length) out.push({ id: "rss", group: "data", label: "ニュース（RSS）", status: "skip", detail: "config.sources が空", ms: 0 });
  }

  // ── notify ──────────────────────────────────────────────────
  await check("discord", "notify", "Discord 通知（任意）", async () => {
    const url = env[c.notify.webhookEnv];
    if (!url) return { status: "skip", detail: `${c.notify.webhookEnv} が未設定（通知しないだけ）`, hint: "使うなら ⚙ 設定でウェブフック URL を入力" };
    if (!isDiscordWebhookUrl(url)) return { status: "fail", detail: "Discord のウェブフック URL の形ではない", hint: "https://discord.com/api/webhooks/… をコピーし直す" };
    // GET on a webhook returns its info and posts nothing
    const res = await s.fetch(url.trim(), { signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 404) return { status: "fail", detail: `ウェブフックが無い（HTTP ${res.status}）`, hint: "Discord で削除されたか URL 違い。作り直して入力" };
    if (!res.ok) return { status: "warn", detail: `HTTP ${res.status}`, hint: "時間をおいて再確認" };
    const info = (await res.json()) as { name?: string; channel_id?: string };
    return { status: "ok", detail: `ウェブフック「${info.name ?? "?"}」· チャンネル ${info.channel_id ?? "?"}（投稿はしていない。⚙ 設定の「テスト送信」で実際に送れる）` };
  });

  // ── brokers (presence only: nothing is sent) ───────────────
  if (want("broker")) {
    if (c.webull) {
      const w = c.webull;
      const keys = Boolean(env[w.appKeyEnv] && env[w.appSecretEnv]);
      const token = existsSync(w.tokenFile);
      out.push({
        id: "webull", group: "broker", label: "ウィブル証券（任意）",
        status: !keys ? "skip" : token ? "ok" : "warn",
        detail: !keys ? "キー未設定（使わないなら問題なし）" : `キーあり · アクセストークン${token ? "あり" : "なし"} · ${w.trading === "live" ? "本番発注" : "プレビューのみ"}`,
        ...(keys && !token ? { hint: "npm run stockai -- webull auth で承認（2FA）してから webull check" } : {}),
        ms: 0,
      });
    }
    if (c.ibkr) {
      const t0 = Date.now();
      const up = await (o.probePort ?? probe)(c.ibkr.host, c.ibkr.port);
      out.push({
        id: "ibkr", group: "broker", label: "IB Gateway（任意）", status: up ? "ok" : "skip",
        detail: up ? `${c.ibkr.host}:${c.ibkr.port} が応答（${c.ibkr.mode}）` : `${c.ibkr.host}:${c.ibkr.port} に接続できない（使わないなら問題なし）`,
        ...(up ? {} : { hint: "IBKR を使うなら IB Gateway を起動（docs/ibkr.md）" }),
        ms: Date.now() - t0,
      });
    }
  }

  // ── storage ─────────────────────────────────────────────────
  await check("storage", "storage", "データ保存", async () => {
    void s.db;
    accessSync(c.dataDir, constants.W_OK);
    const b = backupStatus(c, now);
    const ageDays = b.last ? (now.getTime() - Date.parse(b.last.at)) / 86_400_000 : null;
    const stale = ageDays === null || ageDays > 2;
    return {
      status: stale ? "warn" : "ok",
      detail: `${c.dataDir} に書き込み可 · バックアップ ${b.count} 件${b.last ? `（最新 ${b.last.at.replace("T", " ")}）` : "（まだ無い）"}`,
      ...(stale ? { hint: "Web サーバーの起動中は毎日自動。⚙ 設定の「今すぐバックアップ」でも取れる" } : {}),
    };
  });

  return out;
}

export const STATUS_MARK: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✕", skip: "–" };
