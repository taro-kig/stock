import { convert, latestUsdJpy } from "./data/fx.ts";
import { buildTrades, summarize as summarizeTrades, type Trade } from "./eval/journal.ts";
import type { Scorecard } from "./eval/scorecard.ts";
import type { Services } from "./services.ts";
import { redactText, secretsOf } from "./smoke.ts";
import { watchlistHistory } from "./universe/watchlist.ts";
import { addDays, toIsoDate, type IsoDate } from "./util/dates.ts";

/**
 * A periodic report to paste into a conversation with Claude (or keep): what the system did over
 * the last days — accounts, trades, judgments, accuracy, failures with their log lines, broker
 * orders, watchlist changes, LLM spend. Everything comes from the database; keys, tokens, e-mail
 * addresses and broker account numbers are masked.
 */
export interface ReportOptions {
  /** Days back from `now` (default 7). */
  days?: number;
  now?: Date;
  /** Latest close for open positions (the server passes its price lookup; default: the local price copy). */
  lastClose?: (ticker: string) => { close: number; date: IsoDate } | null;
}

const OK = new Set(["ok", "cached", "fallback"]);
const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%`);
const pct0 = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${(x * 100).toFixed(0)}%`);
const money = (x: number, cur: string | null) => (cur === "JPY" ? `¥${Math.round(x).toLocaleString("en-US")}` : cur === "USD" ? `$${x.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : x.toLocaleString("en-US", { maximumFractionDigits: 2 }));
const cell = (s: string | null | undefined, max = 80) => (s ?? "").replace(/\s+/g, " ").replace(/\|/g, "／").slice(0, max);

/** The latest scorecard produced by an eval.scorecard node. */
export function latestScorecardOf(s: Services): Scorecard | null {
  let best: Scorecard | null = null;
  for (const run of s.runStore.listRuns(200)) {
    if (best && run.asOf <= best.asOf) continue;
    let nodes: Record<string, { use?: string }>;
    try {
      nodes = (JSON.parse(run.specJson) as { nodes?: Record<string, { use?: string }> }).nodes ?? {};
    } catch {
      continue;
    }
    const ids = Object.entries(nodes).filter(([, c]) => c.use === "eval.scorecard").map(([id]) => id);
    if (!ids.length) continue;
    const rows = s.runStore.nodeRuns(run.runId);
    for (const id of ids) {
      const row = rows.find((r) => r.nodeId === id);
      const h = row?.outputs["scorecard"];
      if (!h || !row || !OK.has(row.status)) continue;
      try {
        const card = s.runStore.getArtifact(h) as Scorecard;
        if (!best || card.asOf > best.asOf) best = card;
      } catch {
        // pruned
      }
    }
  }
  return best;
}

/** Latest close: the local price copy, else the newest prices a recent run downloaded. */
function defaultLastClose(s: Services) {
  let fromRuns: Map<string, { close: number; date: IsoDate }> | null = null;
  const runs = () => {
    if (fromRuns) return fromRuns;
    fromRuns = new Map();
    for (const run of s.runStore.listRuns(40)) {
      let nodes: Record<string, { use?: string }>;
      try {
        nodes = (JSON.parse(run.specJson) as { nodes?: Record<string, { use?: string }> }).nodes ?? {};
      } catch {
        continue;
      }
      const rows = s.runStore.nodeRuns(run.runId);
      for (const [id, n] of Object.entries(nodes)) {
        if (!n.use?.startsWith("data.prices")) continue;
        const row = rows.find((r) => r.nodeId === id);
        const h = row?.outputs["prices"];
        if (!h || !OK.has(row!.status)) continue;
        try {
          for (const [t, bars] of Object.entries(s.runStore.getArtifact(h) as Record<string, Array<{ date: IsoDate; close: number }>>)) {
            const b = bars.at(-1);
            const cur = fromRuns.get(t);
            if (b && (!cur || b.date > cur.date)) fromRuns.set(t, { close: b.close, date: b.date });
          }
        } catch {
          // pruned
        }
      }
    }
    return fromRuns;
  };
  return (t: string) => {
    for (const src of ["twelvedata", "jquants", "csv"]) {
      const b = s.priceStore.bars(src, t).at(-1);
      if (b) return { close: b.close, date: b.date };
    }
    return runs().get(t) ?? null;
  };
}

export function buildReport(s: Services, o: ReportOptions = {}): string {
  const now = o.now ?? new Date();
  const to = toIsoDate(now);
  const days = o.days ?? 7;
  const from = addDays(to, -(days - 1));
  const inPeriod = (d: string | null | undefined) => Boolean(d && d.slice(0, 10) >= from && d.slice(0, 10) <= to);
  const out: string[] = [];
  const h2 = (t: string) => out.push("", `## ${t}`, "");

  // ── overview ───────────────────────────────────────────────
  const runs = s.runStore.listRuns(1000).filter((r) => inPeriod(r.createdAt));
  const status = (st: string) => runs.filter((r) => r.status === st).length;
  const preds = s.predictions.all().filter((p) => inPeriod(p.asOf));
  const fills = s.paperBook.allFills().filter((f) => inPeriod(f.asOf));
  s.db.exec("CREATE TABLE IF NOT EXISTS llm_calls (ts TEXT, day TEXT, provider TEXT, model TEXT, input_tokens INT, output_tokens INT, cost_usd REAL, latency_ms REAL)");
  const llm = s.db.prepare("SELECT provider, model, COUNT(*) AS n, SUM(cost_usd) AS c, SUM(input_tokens) AS i, SUM(output_tokens) AS o FROM llm_calls WHERE day >= ? AND day <= ? GROUP BY provider, model ORDER BY c DESC").all(from, to) as Array<{ provider: string; model: string; n: number; c: number; i: number; o: number }>;
  const llmCost = llm.reduce((a, r) => a + (r.c ?? 0), 0);
  const llmDays = (s.db.prepare("SELECT COUNT(DISTINCT day) AS d FROM llm_calls WHERE day >= ? AND day <= ?").get(from, to) as { d: number }).d;

  out.push(`# stockai レポート ${from} 〜 ${to}（${days} 日間）`, "");
  out.push("キー・トークン・メールアドレス・証券口座の番号は伏せてあります。貼る前に一度目を通してください。", "");
  out.push(
    `- 市場: ${s.activeMarkets().map((m) => `${s.market(m).label} ${s.watchlistFor(m).tickers.length} 銘柄`).join(" · ")}${s.fake ? "（疑似モデル）" : ""}`,
    `- 実行: ${runs.length} 回（成功 ${status("succeeded")} · 一部失敗 ${status("partial")} · 失敗 ${status("failed")} · 承認待ち ${status("waiting")}）`,
    `- 判断: ${preds.length} 件 · ペーパー約定: ${fills.length} 件（買い ${fills.filter((f) => f.side === "buy").length} / 売り ${fills.filter((f) => f.side === "sell").length}）`,
    `- LLM の費用: $${llmCost.toFixed(4)}（${llmDays} 日 · 1 日の上限 $${s.config.harness.dailyBudgetUsd}）`,
  );

  // ── accounts ───────────────────────────────────────────────
  h2("口座");
  const series = [
    ...s.paperBook.equityHistory().map((e) => ({ ...e, kind: "ペーパー" })),
    ...s.brokerLedger.equityHistory().map((e) => ({ ...e, kind: "証券口座" })),
  ].filter((e) => e.points.length);
  if (!series.length) out.push("まだ記録がありません。");
  else {
    out.push("| 口座 | 種類 | 期首 | 期末 | 期間の増減 | 開始からの増減 | ピークからの下落 |", "|---|---|---|---|---|---|---|");
    for (const e of series) {
      const before = e.points.filter(([d]) => d < from).at(-1)?.[1];
      const within = e.points.filter(([d]) => inPeriod(d));
      const start = before ?? within[0]?.[1] ?? e.points.at(-1)![1];
      const end = (within.at(-1) ?? e.points.at(-1)!)[1];
      const first = e.points[0]![1];
      const peak = Math.max(...e.points.map(([, v]) => v));
      out.push(`| ${e.account} | ${e.kind} | ${money(start, e.currency)} | ${money(end, e.currency)} | ${pct(start ? end / start - 1 : null, 2)} | ${pct(first ? end / first - 1 : null, 2)} | ${pct(peak ? end / peak - 1 : null, 1)} |`);
    }
    const currencies = new Set(series.map((e) => e.currency).filter(Boolean));
    const fx = latestUsdJpy(s);
    if (currencies.size > 1 && fx) {
      const jpy = series.reduce((a, e) => a + (e.currency === "USD" || e.currency === "JPY" ? convert(e.points.at(-1)![1], e.currency, "JPY", fx.rate) : 0), 0);
      out.push("", `合計（USD/JPY ${fx.rate.toFixed(2)}・${fx.date}）: ${money(jpy, "JPY")} / ${money(jpy / fx.rate, "USD")}`);
    }
  }

  // ── trades ─────────────────────────────────────────────────
  h2("取引（売買日誌）");
  const trades = buildTrades(s.paperBook.allFills(), s.predictions.all(), { lastClose: o.lastClose ?? defaultLastClose(s), today: to });
  if (!trades.length) out.push("まだ取引がありません。");
  for (const acct of [...new Set(trades.map((t) => t.account))]) {
    const ts = trades.filter((t) => t.account === acct);
    const sum = summarizeTrades(ts);
    const cur = s.paperBook.accounts().find((a) => a.account === acct)?.currency ?? null;
    out.push(`### ${acct}`, "", `通算: 決済 ${sum.closed} · 保有 ${sum.open} · 勝率 ${pct0(sum.winRate)} · 平均の勝ち ${pct(sum.avgWin)} / 負け ${pct(sum.avgLoss)} · PF ${sum.profitFactor === null ? "—" : sum.profitFactor.toFixed(2)} · 確定損益 ${money(sum.realized, cur)} · 平均保有 ${sum.avgDaysHeld === null ? "—" : `${Math.round(sum.avgDaysHeld)} 日`}`, "");
    const recent = ts.filter((t: Trade) => inPeriod(t.entryDate) || inPeriod(t.exitDate) || t.open);
    if (recent.length) {
      out.push("| 銘柄 | 状態 | 期間 | 損益 | 買った理由 | 売った理由 |", "|---|---|---|---|---|---|");
      for (const t of recent.slice(0, 30)) {
        const why = t.entryJudgment ? `${t.entryJudgment.stance} ${t.entryJudgment.conviction.toFixed(2)} ${t.entryJudgment.thesis ?? ""}` : t.entryReason;
        out.push(`| ${t.ticker} | ${t.open ? "保有中" : inPeriod(t.exitDate) ? "期間内に決済" : "決済"} | ${t.entryDate} → ${t.exitDate ?? "今"}（${t.daysHeld} 日） | ${pct(t.ret)} | ${cell(why, 90)} | ${cell(t.exitReason, 60) || "—"} |`);
      }
      if (recent.length > 30) out.push("", `（ほか ${recent.length - 30} 件は省略）`);
    }
    out.push("");
  }

  // ── judgments ──────────────────────────────────────────────
  h2("判断");
  if (!preds.length) out.push("この期間の判断はありません。");
  else {
    out.push("| ワークフロー | 件数 | 買い / 売り / 中立 / 見送り | 合意 / 割れて上位に / 割れたまま / 失敗 / 拒否 | 棄却された票 |", "|---|---|---|---|---|");
    for (const label of [...new Set(preds.map((p) => p.label))].sort()) {
      const ps = preds.filter((p) => p.label === label);
      const n = (f: (p: (typeof ps)[number]) => boolean) => ps.filter(f).length;
      const votes = ps.flatMap((p) => p.votes ?? []);
      const rejected = votes.filter((v) => v.rejected);
      const byProvider = [...new Set(rejected.map((v) => v.provider))].map((p) => `${p} ${rejected.filter((v) => v.provider === p).length}`).join(", ");
      out.push(`| ${label} | ${ps.length} | ${n((p) => p.stance === "bullish")} / ${n((p) => p.stance === "bearish")} / ${n((p) => p.stance === "neutral")} / ${n((p) => p.stance === "abstain")} | ${ps[0]?.status === "rules" ? "ルール" : `${n((p) => p.status === "consensus")} / ${n((p) => p.status === "escalated")} / ${n((p) => p.status === "no_consensus")} / ${n((p) => p.status === "failed")} / ${n((p) => p.status === "vetoed")}`} | ${votes.length ? `${rejected.length}/${votes.length}${byProvider ? `（${byProvider}）` : ""}` : "—"} |`);
    }
  }

  // ── accuracy ───────────────────────────────────────────────
  h2("確度（採点）");
  const card = latestScorecardOf(s);
  if (!card || !Object.values(card.labels).some((l) => l.graded > 0)) out.push(`まだ採点がありません（判断から ${card?.horizonDays ?? 20} 営業日後に採点）。`);
  else {
    out.push(`${card.asOf} 時点 · ${card.horizonDays} 営業日後の超過リターンで採点`, "", "| ワークフロー | 判断 | 採点済み | 実効件数 | 的中率 | 下限（95%） | 買いの平均超過 | 売りの平均超過 | 権限 |", "|---|---|---|---|---|---|---|---|---|");
    for (const l of Object.values(card.labels)) {
      out.push(`| ${l.label} | ${l.total} | ${l.graded} | ${l.nEff.toFixed(1)} | ${pct0(l.hitRateEff)} | ${pct0(l.wilsonLow)} | ${pct(l.meanExcessBullish, 2)} | ${pct(l.meanExcessBearish, 2)} | ${cell(l.promotion.reason, 60)} |`);
    }
    const models = Object.values(card.labels).flatMap((l) => l.byModel.map((m) => ({ ...m, label: l.label }))).filter((m) => m.graded > 0);
    if (models.length) out.push("", "モデル別: " + models.map((m) => `${m.label}/${m.model} 的中 ${pct0(m.hitRateEff)}（実効 ${m.nEff.toFixed(1)}）`).join(" · "));
  }

  // ── runs and failures ──────────────────────────────────────
  h2("実行と失敗");
  if (!runs.length) out.push("この期間の実行はありません。");
  else {
    out.push("| ワークフロー | 回数 | 成功 | 一部失敗 | 失敗 | 承認待ち |", "|---|---|---|---|---|---|");
    for (const w of [...new Set(runs.map((r) => r.workflow))].sort()) {
      const rs = runs.filter((r) => r.workflow === w);
      const n = (st: string) => rs.filter((r) => r.status === st).length;
      out.push(`| ${w} | ${rs.length} | ${n("succeeded")} | ${n("partial")} | ${n("failed")} | ${n("waiting")} |`);
    }
    const bad = runs.filter((r) => r.status === "failed" || r.status === "partial").slice(0, 10);
    for (const r of bad) {
      const nodes = s.runStore.nodeRuns(r.runId).filter((n) => n.status === "failed" || (n.error && n.status !== "skipped" && n.status !== "pending" && n.status !== "waiting"));
      const logs = s.runStore.events(r.runId).filter((e) => e.type === "log") as Array<{ node?: string; message?: string }>;
      out.push("", `**${r.asOf} ${r.workflow}（${r.status === "failed" ? "失敗" : "一部失敗"}）**`, "", "```");
      for (const n of nodes) {
        out.push(`${n.nodeId} (${n.type}): ${cell(n.error, 400)}`);
        for (const l of logs.filter((x) => x.node === n.nodeId).slice(-5)) out.push(`  log: ${cell(l.message, 300)}`);
      }
      out.push("```");
    }
    if (runs.filter((r) => r.status === "failed" || r.status === "partial").length > bad.length) out.push("", `（ほか ${runs.filter((r) => r.status === "failed" || r.status === "partial").length - bad.length} 件は省略）`);
    // partly failing nodes inside successful runs (downloads, LLM calls)
    const PROBLEM = /^(failed|pricesFailed|macroFailed|feedsFailed|buildFailed|trackingFailed|llmErrors|invalidOutputs|limited|budgetStopped)$/;
    const partial = new Map<string, number>();
    for (const r of runs) {
      for (const n of s.runStore.nodeRuns(r.runId)) {
        for (const [k, v] of Object.entries(n.metrics ?? {})) if (PROBLEM.test(k) && v > 0) partial.set(`${n.type} ${k}`, (partial.get(`${n.type} ${k}`) ?? 0) + v);
      }
    }
    if (partial.size) out.push("", "一部の失敗（ノードは完了）: " + [...partial].map(([k, v]) => `${k}=${v}`).join(" · "));
  }

  // ── broker orders ──────────────────────────────────────────
  const orders = s.brokerLedger.recentOrders(200).filter((x) => inPeriod(x.asOf));
  if (orders.length) {
    h2("証券口座への注文");
    out.push("| 日付 | 口座 | 銘柄 | 売買 | 株数 | 指値 | 結果 | 約定 |", "|---|---|---|---|---|---|---|---|");
    for (const x of orders) out.push(`| ${x.asOf} | ${x.account} | ${x.ticker} | ${x.side === "buy" ? "買い" : "売り"} | ${x.shares} | ${x.limitPrice} | ${x.state ?? "—"}${x.estimated && x.state !== "working" ? "（推定）" : ""} | ${x.filledShares ?? "—"}${x.fillPrice ? ` @ ${x.fillPrice.toFixed(2)}` : ""} |`);
  }

  // ── watchlist ──────────────────────────────────────────────
  const changes = watchlistHistory(s, 100).filter((c) => inPeriod(c.at));
  if (changes.length) {
    h2("ウォッチリストの変更");
    for (const c of changes) {
      out.push(`- ${c.at.slice(0, 10)}（${c.source}）${[...c.added.map((a) => `+${a.ticker}`), ...c.removed.map((r) => `−${r.ticker}`)].join(" ")}${c.note ? ` · ${cell(c.note, 80)}` : ""}`);
    }
  }

  // ── LLM ───────────────────────────────────────────────────
  if (llm.length) {
    h2("LLM の使用");
    out.push("| 名前 | モデル | 呼び出し | 入力 / 出力トークン | 費用 |", "|---|---|---|---|---|");
    for (const r of llm) out.push(`| ${r.provider} | ${r.model} | ${r.n} | ${(r.i ?? 0).toLocaleString("en-US")} / ${(r.o ?? 0).toLocaleString("en-US")} | $${(r.c ?? 0).toFixed(4)} |`);
  }

  out.push("", `---`, `作成 ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`);
  return maskReport(s, `${out.join("\n")}\n`);
}

/** Keys and the like (as in the smoke report), plus broker account numbers → 証券口座A, B, … */
function maskReport(s: Services, text: string): string {
  let out = redactText(text, secretsOf(s));
  const accounts = [...new Set([...s.brokerLedger.equityHistory().map((e) => e.account), ...s.brokerLedger.recentOrders(500).map((o) => o.account)])].filter((a) => a.length >= 4);
  accounts.forEach((a, i) => {
    out = out.split(a).join(`証券口座${String.fromCharCode(65 + (i % 26))}`);
  });
  return out.replace(/\b(DU|DF|U)\d{6,}\b/g, "証券口座");
}
