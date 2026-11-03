import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { buildReport } from "../src/report.ts";
import { Services } from "../src/services.ts";
import { weekdays } from "../src/util/dates.ts";
import { Engine } from "../src/workflow/engine.ts";
import { loadWorkflow, parseWorkflow } from "../src/workflow/spec.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

describe("report", () => {
  it("covers accounts, trades, judgments, accuracy, failures with logs and LLM use, with secrets masked", async () => {
    const services = new Services(loadConfig(resolve(ROOT, "config/config.jp.example.yaml")), {
      fake: true, dbPath: ":memory:", env: { GEMINI_API_KEY: "AIzaSecretValue123456", DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/tok_abcdef" },
    });
    const engine = new Engine({ services, registry: builtinRegistry(), store: services.runStore });
    const spec = loadWorkflow(resolve(ROOT, "workflows/demo-ai.yaml"));
    spec.nodes["news"]!.params["path"] = resolve(ROOT, "examples/fixtures/news.json");
    for (const d of weekdays("2026-05-04", "2026-10-30", 10)) await engine.run(spec, { asOf: d });
    // a failing run, with a log line saying why
    await engine.run(parseWorkflow("name: broken\nnodes:\n  p: { use: data.pricesCsv, params: { dir: /nonexistent } }\n"), { asOf: "2026-10-30" });
    // an LLM call that mentions a key (must not leak) and a broker account (masked)
    services.db.prepare("INSERT INTO llm_calls VALUES (?,?,?,?,?,?,?,?)").run(new Date().toISOString(), new Date().toISOString().slice(0, 10), "gemini-lite", "gemini-2.5-flash-lite", 1000, 100, 0.0012, 300);
    services.brokerLedger.recordEquity("DU7654321", "2026-10-30", 1_000_000, "JPY");

    const md = buildReport(services, { days: 366 });
    expect(md).toMatch(/^# stockai レポート /);
    for (const section of ["## 口座", "## 取引（売買日誌）", "## 判断", "## 確度（採点）", "## 実行と失敗", "## LLM の使用"]) expect(md).toContain(section);
    expect(md).toContain("| demo-ai | ペーパー |");
    expect(md).toMatch(/通算: 決済 \d+ · 保有 \d+ · 勝率/);
    expect(md).toMatch(/\| demo-ai \| \d+ \| \d+ \/ \d+ \/ \d+ \/ \d+ \|/);
    expect(md).toContain("broken（失敗）");
    expect(md).toContain("p (data.pricesCsv): no price data found in /nonexistent");
    expect(md).toMatch(/log: no price file for \d{4}/);
    expect(md).toContain("| gemini-lite | gemini-2.5-flash-lite | 1 |");
    expect(md).not.toContain("DU7654321");
    expect(md).toContain("証券口座A");
    expect(md).not.toContain("AIzaSecretValue123456");
    expect(md).not.toContain("tok_abcdef");
  });

  it("an empty database still gives a readable report", () => {
    const services = new Services(loadConfig(resolve(ROOT, "config/config.example.yaml")), { fake: true, dbPath: ":memory:" });
    const md = buildReport(services, { days: 7, now: new Date("2026-11-03T12:00:00Z") });
    expect(md).toContain("# stockai レポート 2026-10-28 〜 2026-11-03（7 日間）");
    expect(md).toContain("まだ記録がありません。");
    expect(md).toContain("まだ採点がありません");
    expect(md).toContain("この期間の実行はありません。");
  });
});
