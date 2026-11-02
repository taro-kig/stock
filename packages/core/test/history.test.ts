import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Judgment } from "../src/ai/judge.ts";
import { loadConfig } from "../src/config.ts";
import { PredictionStore, type Prediction } from "../src/eval/predictions.ts";
import { buildScorecard } from "../src/eval/scorecard.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { Services } from "../src/services.ts";
import type { Prices } from "../src/signals/technical.ts";
import { earningsReactions, previousJudgment, previousLines, reactionLines, returnBetween } from "../src/strategy/history.ts";
import { weekdays } from "../src/util/dates.ts";
import { openDb } from "../src/util/db.ts";
import { Engine } from "../src/workflow/engine.ts";
import { loadWorkflow } from "../src/workflow/spec.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const days = weekdays("2026-06-01", "2026-09-30");
const series = (f: (i: number) => number) => days.map((date, i) => ({ date, open: f(i), high: f(i), low: f(i), close: f(i), volume: 1 }));

describe("predictions keep why and who", () => {
  it("stores thesis, votes and events, reads back the previous one, and migrates old tables", () => {
    const db = openDb(":memory:");
    db.exec(`CREATE TABLE predictions (label TEXT, as_of TEXT, ticker TEXT, stance TEXT, conviction REAL, status TEXT, run_id TEXT, PRIMARY KEY (label, as_of, ticker))`);
    db.prepare("INSERT INTO predictions VALUES ('ai','2026-07-01','AAPL','bullish',0.5,'consensus','r0')").run();
    const st = new PredictionStore(db);
    st.record([{
      label: "ai", asOf: "2026-07-10", ticker: "AAPL", stance: "bearish", conviction: 0.6, status: "consensus", runId: "r1",
      thesis: "トレンドが下向き", invalidation: ["SMA200 を上回ったら"],
      votes: [{ provider: "g", model: "gemini-2.5-flash-lite", stance: "bearish", rejected: false }, { provider: "d", stance: null, rejected: true }],
      events: [{ eventType: "guidance_down", direction: -2 }],
    }]);
    expect(st.previous("ai", "AAPL", "2026-07-10")?.asOf).toBe("2026-07-01"); // strictly before
    const p = st.previous("ai", "AAPL", "2026-07-11")!;
    expect(p).toMatchObject({ thesis: "トレンドが下向き", invalidation: ["SMA200 を上回ったら"], events: [{ eventType: "guidance_down", direction: -2 }] });
    expect(p.votes?.[0]).toMatchObject({ model: "gemini-2.5-flash-lite", stance: "bearish" });
    expect(st.previous("ai", "MSFT", "2026-07-11")).toBeNull();
    expect(st.all()[0]).toMatchObject({ thesis: null, votes: null }); // old row
  });
});

describe("past data in the fact sheet", () => {
  const up = series((i) => 100 * 1.01 ** i);
  const flat = series(() => 100);
  it("previous judgment with what happened since", () => {
    const pj = previousJudgment({ label: "ai", asOf: days[0]!, ticker: "X", stance: "bullish", conviction: 0.62, status: "consensus", runId: "r", thesis: "上昇トレンド", invalidation: ["SMA50 割れ"] }, days[10]!, up, flat);
    expect(pj?.move).toBeCloseTo(1.01 ** 10 - 1, 6);
    expect(previousLines(pj)).toEqual([
      "## 前回の判断（参考。今日の資料で判断し直すこと）",
      `${days[0]}: 強気（確信 0.62）「上昇トレンド」`,
      "そのとき書いた撤回条件: SMA50 割れ",
      "その後の値動き: +10.5%（ベンチマーク +0.0%、差 +10.5%）",
    ]);
    expect(previousLines(null)).toEqual(["## 前回の判断", "(なし)"]);
    expect(returnBetween(up, days[5]!, days[5]!)).toBeNull();
  });

  it("earnings reactions start from the last close before the news", () => {
    // a jump of +10% on day 21 (the first close after a post-market report on day 20)
    const bars = series((i) => (i >= 21 ? 110 : 100));
    const mk = (reportTime: string | null, d: number) => ({ ticker: "X", fiscalDateEnding: "2026-06-30", reportedDate: days[d]!, reportTime, reportedEPS: 1.1, estimatedEPS: 1, surprisePct: 10 });
    const post = earningsReactions([mk("post-market", 20)], bars, flat, days.at(-1)!);
    expect(post[0]!.after[1]).toBeCloseTo(0.1, 6);
    expect(post[0]!.after[20]).toBeCloseTo(0.1, 6);
    const pre = earningsReactions([mk("pre-market", 21)], bars, flat, days.at(-1)!); // pre-market on day 21: base is day 20
    expect(pre[0]!.after[1]).toBeCloseTo(0.1, 6);
    const tooEarly = earningsReactions([mk("post-market", 20)], bars, flat, days[22]!);
    expect(tooEarly[0]!.after).toMatchObject({ 5: null, 20: null }); // not known yet on the run date
    expect(reactionLines(post)[1]).toBe(`${days[20]}（上振れ +10.0%）: 翌日 +10.0% / 5日 +10.0% / 20日 +10.0%`);
  });
});

describe("scorecard by model and by event", () => {
  const prices: Prices = { UP: series((i) => 100 * 1.01 ** i), DOWN: series((i) => 100 * 0.99 ** i), FLAT: series(() => 100) };
  const p = (ticker: string, asOf: string, extra: Partial<Prediction>): Prediction => ({ label: "ai", asOf, ticker, stance: "bullish", conviction: 0.6, status: "consensus", runId: "r", ...extra });
  it("grades every model's own answers and each event type's direction", () => {
    const preds = [
      p("UP", days[0]!, { votes: [{ provider: "a", model: "m-a", stance: "bullish", rejected: false }, { provider: "b", model: "m-b", stance: "bearish", rejected: false }], events: [{ eventType: "guidance_up", direction: 1 }] }),
      p("DOWN", days[0]!, { stance: "abstain", votes: [{ provider: "a", model: "m-a", stance: "bearish", rejected: false }, { provider: "b", model: "m-b", stance: "bullish", rejected: true }], events: [{ eventType: "guidance_up", direction: 2 }, { eventType: "scandal", direction: -2 }] }),
    ];
    const card = buildScorecard(preds, prices, days.at(-1)!, 20, { minNEff: 1, minWilsonLow: 0 }).labels["ai"]!;
    expect(card.byModel).toEqual([
      { model: "m-a", votes: 2, graded: 2, nEff: 2, hitRate: 1, hitRateEff: 1 },
      { model: "m-b", votes: 1, graded: 1, nEff: 1, hitRate: 0, hitRateEff: 0 }, // its rejected vote does not count
    ]);
    expect(card.byEvent.find((e) => e.eventType === "guidance_up")).toMatchObject({ direction: 1, graded: 2, hitRate: 0.5 });
    expect(card.byEvent.find((e) => e.eventType === "scandal")).toMatchObject({ direction: -1, graded: 1, hitRate: 1 });
  });
});

describe("the AI reads its previous judgment", () => {
  it("demo-ai: day 2's fact sheet shows day 1's judgment and the move since", async () => {
    const services = new Services(loadConfig(resolve(ROOT, "config/config.example.yaml")), { fake: true, dbPath: ":memory:" });
    const engine = new Engine({ services, registry: builtinRegistry(), store: services.runStore });
    const spec = loadWorkflow(resolve(ROOT, "workflows/demo-ai.yaml"));
    for (const n of Object.values(spec.nodes)) if (typeof n.params["path"] === "string") n.params["path"] = resolve(ROOT, n.params["path"] as string);
    await engine.run(spec, { asOf: "2026-07-20" });
    const r = await engine.run(spec, { asOf: "2026-07-21" });
    const js = Object.values(r.output<Record<string, Judgment>>("decide", "judgments"));
    expect(js.length).toBeGreaterThan(0);
    const d = js[0]!.dossier!;
    expect(d).toContain("## 前回の判断（参考。今日の資料で判断し直すこと）");
    expect(d).toMatch(/2026-07-20: (強気|弱気|中立|見送り)/);
    expect(d).toMatch(/その後の値動き: [+-]\d/);
    const prev = services.predictions.previous("demo-ai", js[0]!.ticker, "2026-07-21");
    expect(prev?.votes?.length).toBeGreaterThan(0);
  });
});
