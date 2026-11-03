import { homedir } from "node:os";
import { defaultMarketId } from "./markets.ts";
import { runDoctor, STATUS_MARK } from "./doctor.ts";
import { fundamentalsAt, parseCompanyFacts } from "./data/fundamentals.ts";
import { SecClient } from "./data/sec.ts";
import { builtinRegistry } from "./nodes/index.ts";
import { loadTwelveData } from "./nodes/data.ts";
import type { Services } from "./services.ts";
import { researchFactors } from "./strategy/factorResearch.ts";
import { buildResearchUniverse } from "./universe/companies.ts";
import { screenStocks } from "./universe/screen.ts";
import { KNOWN_SETTINGS } from "./util/settings.ts";
import { toIsoDate } from "./util/dates.ts";
import { Engine } from "./workflow/engine.ts";
import type { NodeContext } from "./workflow/context.ts";
import { loadWorkflow } from "./workflow/spec.ts";

/**
 * One end-to-end check with real data, for a new setup or after changes: the connection
 * check, today's AI workflow, a small data screen and a small factor research, written as a
 * report that can be shared (keys, tokens and e-mail addresses are masked). Meant to run on a
 * copy of the database, so real records (judgments, approvals, paper account) are untouched.
 */
export type SmokeStatus = "ok" | "warn" | "fail" | "skip";

export interface SmokeStep {
  name: string;
  status: SmokeStatus;
  ms: number;
  lines: string[];
  error?: string;
}

export interface SmokeReport {
  at: string;
  env: string[];
  steps: SmokeStep[];
}

export interface SmokeOptions {
  workflow?: string | undefined;
  skipWorkflow?: boolean;
  skipScreen?: boolean;
  skipResearch?: boolean;
  /** Progress lines while running. */
  log?: (m: string) => void;
  now?: Date;
}

const errText = (e: unknown) => (e instanceof Error ? `${e.message}${e.cause instanceof Error ? `: ${e.cause.message}` : ""}` : String(e));

async function step(name: string, fn: () => Promise<Omit<SmokeStep, "name" | "ms">>, log?: (m: string) => void): Promise<SmokeStep> {
  log?.(`… ${name}`);
  const t0 = Date.now();
  try {
    const r = await fn();
    return { name, ms: Date.now() - t0, ...r };
  } catch (e) {
    return { name, ms: Date.now() - t0, status: "fail", lines: [], error: errText(e).slice(0, 600) };
  }
}

export async function runSmoke(s: Services, o: SmokeOptions = {}): Promise<SmokeReport> {
  const now = o.now ?? new Date();
  const markets = s.activeMarkets();
  const usd = markets.includes("us");
  const def = defaultMarketId(s.config);
  const set = (n: string) => Boolean(s.env[n]);
  const env = [
    `Node ${process.version} · ${process.platform}`,
    `市場: ${markets.map((m) => `${s.market(m).label} ${s.watchlistFor(m).tickers.length} 銘柄（ベンチマーク ${s.market(m).benchmark ?? "なし"}）`).join(" · ")}`,
    `設定されているキー: ${KNOWN_SETTINGS.filter((k) => set(k.name)).map((k) => k.name).join(", ") || "なし"}`,
    `モデル: ${s.fake ? "疑似（--fake）" : (s.config.models?.pool ?? []).map((m) => `${m.name}=${m.model}`).join(", ") || "未設定"}`,
  ];
  const steps: SmokeStep[] = [];

  steps.push(await step("接続チェック", async () => {
    const r = await runDoctor(s, { now });
    const bad = r.filter((x) => x.status === "fail").length;
    return {
      status: bad ? "fail" : r.some((x) => x.status === "warn") ? "warn" : "ok",
      lines: r.map((x) => `${STATUS_MARK[x.status]} ${x.label}: ${x.detail}${x.hint && x.status !== "ok" ? ` → ${x.hint}` : ""}`),
    };
  }, o.log));

  if (!o.skipWorkflow) {
    const path = o.workflow ?? (def === "us" ? "workflows/daily-ai.yaml" : "workflows/daily-jp-ai.yaml");
    steps.push(await step(`ワークフロー ${path}（今日の分）`, async () => {
      const engine = new Engine({ services: s, registry: builtinRegistry(), store: s.runStore });
      const r = await engine.run(loadWorkflow(path));
      const nodes = Object.values(r.nodes);
      const lines = nodes.map((n) => {
        const m = Object.entries(n.metrics ?? {}).map(([k, v]) => `${k}=${typeof v === "number" && !Number.isInteger(v) ? v.toFixed(3) : v}`).join(" ");
        return `${n.status.padEnd(8)} ${n.nodeId} (${n.type}) ${n.durationMs ?? 0}ms${m ? ` · ${m}` : ""}${n.error ? ` · エラー: ${n.error}` : ""}`;
      });
      const failed = nodes.filter((n) => n.status === "failed").length;
      return {
        status: r.status === "failed" || failed ? "fail" : r.status === "partial" ? "warn" : "ok",
        lines: [`結果: ${r.status}（${r.runId}）· LLM の費用 $${s.costSnapshot().toFixed(4)}`, ...lines],
      };
    }, o.log));
  }

  if (usd && !o.skipScreen) {
    steps.push(await step("データで銘柄を探す（小さく）", async () => {
      const r = await screenStocks(s, { sizes: ["mid", "small"], count: 3, maxPriceLookups: 5 }, { now });
      return {
        status: r.candidates.length ? "ok" : "warn",
        lines: [
          r.funnel.map((f) => `${f.step} ${f.count}`).join(" → "),
          ...r.candidates.map((c) => `${c.ticker} ${c.name} · ${c.sector} · ${c.reason}`),
          ...r.notes,
        ],
      };
    }, o.log));
  }

  if (usd && !o.skipResearch) {
    steps.push(await step("因子の検証（小さく: 各規模5社）", async () => {
      const ua = s.env["SEC_USER_AGENT"];
      if (!ua) return { status: "skip", lines: ["SEC_USER_AGENT が無いので省略"] };
      const sec = new SecClient({ userAgent: ua, fetchImpl: s.fetch, sleep: s.sleep });
      const rows = await buildResearchUniverse(s, sec, now, { perBucket: 5, seed: 1 });
      const universe = Object.fromEntries(rows.map((r) => [r.ticker, r.sector]));
      const bench = s.market("us").benchmark;
      const ctx = { services: s, asOf: toIsoDate(now), wallNow: () => now, live: true, log: () => undefined } as unknown as NodeContext;
      const { prices, counts } = await loadTwelveData(ctx, [...Object.keys(universe), ...(bench ? [bench] : [])], { apiKeyEnv: "TWELVEDATA_API_KEY", symbols: {}, historyBars: 600, perMinute: 8, maxStaleDays: 5 });
      const facts: Record<string, ReturnType<typeof parseCompanyFacts>> = {};
      for (const r of rows) {
        try {
          facts[r.ticker] = parseCompanyFacts(await sec.json(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(r.cik).padStart(10, "0")}.json`));
        } catch {
          // optional
        }
      }
      const withFin = Object.entries(facts).filter(([t, f]) => fundamentalsAt(t, f, toIsoDate(now))).length;
      const rep = researchFactors({ asOf: toIsoDate(now), prices, universe, benchmark: bench, facts, minStocks: 5, lookbackDays: 365, buckets: Object.fromEntries(rows.map((r) => [r.ticker, r.bucket])) });
      return {
        status: Object.keys(prices).length >= 8 && rep.factors.some((f) => f.meanIC !== null) ? "ok" : "warn",
        lines: [
          `銘柄: ${rows.map((r) => `${r.ticker}(${r.bucket}/${r.sector})`).join(" ")}`,
          `株価: ${Object.keys(prices).length} 銘柄（${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}）· 財務データ: ${withFin}/${rows.length} 社`,
          `測定: ${rep.from ?? "—"}〜${rep.to ?? "—"}`,
          ...rep.factors.map((f) => `${f.label}: IC ${f.meanIC === null ? "—" : f.meanIC.toFixed(3)} · t ${f.t === null ? "—" : f.t.toFixed(1)} · 日付 ${f.dates}`),
          "（少数の銘柄なので数字そのものに意味はない。最後まで動くかの確認）",
        ],
      };
    }, o.log));
  }

  return { at: now.toISOString(), env, steps: redact(s, steps) };
}

/** Masks every secret value present in the environment, e-mail addresses and API keys in URLs. */
export function redactText(text: string, secrets: readonly string[], home: string = homedir()): string {
  let out = text;
  // the home folder carries the user name (C:\\Users\\<name>, /home/<name>)
  if (home.length > 3) out = out.split(home).join("~");
  for (const v of secrets) if (v.length >= 6) out = out.split(v).join("***");
  return out
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/([?&](?:api_?key|apikey|token|key)=)[^&\s]+/gi, "$1***")
    .replace(/(https:\/\/discord(?:app)?\.com\/api\/webhooks\/)\S+/g, "$1***");
}

function redact(s: Services, steps: SmokeStep[]): SmokeStep[] {
  const secrets = Object.entries(s.env)
    .filter(([k, v]) => v && (KNOWN_SETTINGS.some((d) => d.name === k && d.secret) || /KEY|SECRET|TOKEN|PASSWORD|WEBHOOK/i.test(k)))
    .map(([, v]) => v!);
  return steps.map((st) => ({ ...st, lines: st.lines.map((l) => redactText(l, secrets)), ...(st.error ? { error: redactText(st.error, secrets) } : {}) }));
}

const MARK: Record<SmokeStatus, string> = { ok: "✓", warn: "⚠", fail: "✕", skip: "–" };

export function smokeMarkdown(r: SmokeReport): string {
  const out = [
    `# stockai 通し確認 ${r.at.slice(0, 16).replace("T", " ")} UTC`,
    "",
    "キー・トークン・メールアドレスは伏せてあります。共有して大丈夫ですが、念のため目を通してから貼ってください。",
    "",
    ...r.env.map((e) => `- ${e}`),
    "",
    "| | 段階 | 時間 |",
    "|---|---|---|",
    ...r.steps.map((s) => `| ${MARK[s.status]} | ${s.name} | ${(s.ms / 1000).toFixed(1)} 秒 |`),
  ];
  for (const s of r.steps) {
    out.push("", `## ${MARK[s.status]} ${s.name}`, "");
    if (s.error) out.push(`エラー: ${s.error}`, "");
    if (s.lines.length) out.push("```", ...s.lines, "```");
  }
  return `${out.join("\n")}\n`;
}
