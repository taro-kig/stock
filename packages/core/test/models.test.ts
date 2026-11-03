import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AppConfig, loadConfig } from "../src/config.ts";
import { listModels, missingStarterModels, modelSlug, PoolInput, vendorOf } from "../src/llm/catalog.ts";
import { describeUse, explicitModelNames, ModelsConfig, modelsFor, resolveUse, usedModelNames } from "../src/llm/roles.ts";
import { SettingsStore } from "../src/util/settings.ts";
import { Services } from "../src/services.ts";
import { saveModelPool, saveModelUse } from "../src/util/configFile.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("model catalog", () => {
  it("knows the vendor of a configured model", () => {
    expect(vendorOf({ provider: "gemini", name: "g", model: "gemini-2.5-flash", apiKeyEnv: "GEMINI_API_KEY" })).toBe("gemini");
    expect(vendorOf({ provider: "openai_compat", name: "d", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" })).toBe("deepseek");
    expect(vendorOf({ provider: "openai_compat", name: "q", model: "x", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" })).toBe("openrouter");
    expect(vendorOf({ provider: "openai_compat", name: "l", model: "x", baseUrl: "http://localhost:8000/v1", apiKeyEnv: "LOCAL_KEY" })).toBe("custom");
    expect(modelSlug("qwen/qwen-2.5-72b-instruct")).toBe("qwen-2.5-72b-instruct");
    expect(modelSlug("Gemini 2.5 Flash")).toBe("gemini-2.5-flash");
  });

  it("lists Gemini text models across pages, with our notes and reference prices", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      expect((init?.headers as Record<string, string>)["x-goog-api-key"]).toBe("k");
      return url.includes("pageToken")
        ? json({ models: [{ name: "models/gemini-2.5-flash-lite", supportedGenerationMethods: ["generateContent"] }] })
        : json({
            models: [
              { name: "models/gemini-9-flash", displayName: "Gemini 9 Flash", supportedGenerationMethods: ["generateContent", "countTokens"] },
              { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
              { name: "models/gemini-2.5-flash-preview-tts", supportedGenerationMethods: ["generateContent"] },
            ],
            nextPageToken: "p2",
          });
    }) as typeof globalThis.fetch;
    const r = await listModels("gemini", { env: { GEMINI_API_KEY: "k" }, fetch });
    expect(r.source).toBe("api");
    expect(urls).toHaveLength(2);
    expect(r.models.map((m) => m.id)).toEqual(["gemini-2.5-flash-lite", "gemini-9-flash"]); // known first
    expect(r.models[0]).toMatchObject({ price: [0.1, 0.4], note: expect.any(String) });
    expect(r.models[1]).toMatchObject({ label: "Gemini 9 Flash" });
    expect(r.models[1]!.price).toBeUndefined();
  });

  it("reads OpenRouter's per-token prices as USD per 1M", async () => {
    const fetch = (async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://openrouter.ai/api/v1/models");
      expect((init?.headers as Record<string, string>)["authorization"]).toBe("Bearer k");
      return json({ data: [{ id: "qwen/qwen-2.5-72b-instruct", name: "Qwen2.5 72B", pricing: { prompt: "0.00000012", completion: "0.00000039" } }, { id: "openai/whisper-1" }] });
    }) as typeof globalThis.fetch;
    const r = await listModels("openrouter", { env: { OPENROUTER_API_KEY: "k" }, fetch });
    expect(r.models).toEqual([{ id: "qwen/qwen-2.5-72b-instruct", label: "Qwen2.5 72B", note: expect.any(String), price: [0.12, 0.39] }]);
  });

  it("falls back to the built-in list without a key or when the API fails", async () => {
    const never = (async () => {
      throw new Error("no network in tests");
    }) as typeof globalThis.fetch;
    const noKey = await listModels("deepseek", { env: {}, fetch: never });
    expect(noKey).toMatchObject({ source: "builtin", error: expect.stringMatching(/DEEPSEEK_API_KEY/) });
    expect(noKey.models.map((m) => m.id)).toContain("deepseek-chat");
    const down = await listModels("deepseek", { env: { DEEPSEEK_API_KEY: "k" }, fetch: (async () => json({}, 401)) as typeof globalThis.fetch });
    expect(down).toMatchObject({ source: "builtin", error: expect.stringMatching(/401/) });
    const custom = await listModels("custom", { env: { LOCAL_KEY: "k" }, apiKeyEnv: "LOCAL_KEY", fetch: never });
    expect(custom.error).toMatch(/Base URL/);
  });

  it("validates the edited pool", () => {
    const g = { provider: "gemini" as const, name: "g", model: "gemini-2.5-flash-lite", apiKeyEnv: "GEMINI_API_KEY" };
    expect(PoolInput.safeParse({ pool: [g] }).success).toBe(true);
    expect(PoolInput.safeParse({ pool: [] }).success).toBe(false);
    expect(PoolInput.safeParse({ pool: [g, { ...g, model: "x" }] }).success).toBe(false); // name twice
    expect(PoolInput.safeParse({ pool: [{ ...g, name: "Bad Name" }] }).success).toBe(false);
    expect(PoolInput.safeParse({ pool: [{ ...g, provider: "openai_compat", baseUrl: "file:///etc" }] }).success).toBe(false);
  });
});

describe("model config", () => {
  const g = { name: "g", provider: "gemini", model: "gemini-2.5-flash-lite", apiKeyEnv: "GEMINI_API_KEY" };
  const d = { name: "d", provider: "openai_compat", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKeyEnv: "DEEPSEEK_API_KEY" };
  const f = { name: "f", provider: "gemini", model: "gemini-2.5-flash", apiKeyEnv: "GEMINI_API_KEY" };
  const p = { name: "p", provider: "gemini", model: "gemini-2.5-pro", apiKeyEnv: "GEMINI_API_KEY" };
  const r1 = { name: "r1", provider: "openai_compat", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner", apiKeyEnv: "DEEPSEEK_API_KEY" };
  const ctx = (keys: string[], quorum = 2) => ({ hasKey: (s: { apiKeyEnv: string }) => keys.includes(s.apiKeyEnv), pricing: {}, quorum });
  const both = ["GEMINI_API_KEY", "DEEPSEEK_API_KEY"];

  it("auto: the cheapest model of each vendor votes, a pricier one settles disagreements", () => {
    const m = ModelsConfig.parse({ pool: [p, f, r1, d, g] });
    expect(m.use).toEqual({ event: "auto", judge: "auto", redteam: "auto", universe: "auto" });
    const r = resolveUse(m, ctx(both));
    expect(r.judge).toEqual({ vote: ["g", "d"], escalation: "f" }); // not the pro or the reasoner
    expect(r.event).toEqual(r.judge);
    expect(r.redteam).toBe("f");
    expect(r.universe).toBe("f");
    expect(r.notes).toEqual([]);
    expect(describeUse(r, "judge", 2)).toBe("g と d に同じことを聞き、答えが一致したものだけを使う。それでも決まらない大事なものは f が決める");
  });

  it("auto: follows the keys that are set, and says what is missing", () => {
    const m = ModelsConfig.parse({ pool: [g, d, f] });
    const onlyGemini = resolveUse(m, ctx(["GEMINI_API_KEY"]));
    expect(onlyGemini.judge).toEqual({ vote: ["g", "f"] }); // two Gemini models, nothing stronger left
    expect(onlyGemini.notes.join()).toMatch(/1 社だけ/);
    const third = resolveUse(ModelsConfig.parse({ pool: [g, d, f, { name: "q", provider: "openai_compat", baseUrl: "https://openrouter.ai/api/v1", model: "qwen/qwen-2.5-72b-instruct", apiKeyEnv: "OPENROUTER_API_KEY" }] }), ctx([...both, "OPENROUTER_API_KEY"]));
    expect(third.judge.vote).toEqual(["g", "d", "q"]); // a 3rd vendor only asked on disagreement
    expect(third.judge.escalation).toBe("f");
    const none = resolveUse(m, ctx([]));
    expect(none.notes.join()).toMatch(/キーが設定されたモデルがありません/);
    const one = resolveUse(ModelsConfig.parse({ pool: [g] }), ctx(both));
    expect(one.notes.join()).toMatch(/少なくとも 2 つ/);
  });

  it("old tier1 / tier2 / redTeam files load as a pool with auto", () => {
    const m = ModelsConfig.parse({ tier1: [g, d], tier2: f });
    expect(m.pool.map((x) => x.name)).toEqual(["g", "d", "f"]);
    expect(m.use.judge).toBe("auto");
    expect(resolveUse(m, ctx(both)).judge).toEqual({ vote: ["g", "d"], escalation: "f" }); // the same roles as before
  });

  it("hand-picked choices are kept as they are and checked against the pool", () => {
    expect(ModelsConfig.safeParse({ pool: [g, d], use: { event: { vote: ["g", "x"] } } }).success).toBe(false);
    expect(ModelsConfig.safeParse({ pool: [g, d], use: { event: { vote: ["g", "g"] } } }).success).toBe(false);
    expect(ModelsConfig.safeParse({ pool: [g, g] }).success).toBe(false);
    expect(ModelsConfig.safeParse({ pool: [g], use: { universe: "none" } }).success).toBe(false);
    const m = ModelsConfig.parse({ pool: [g, d, f], use: { judge: { vote: ["d", "g"], escalation: "f" }, redteam: "none" } });
    expect(explicitModelNames(m)).toEqual(["d", "g", "f"]);
    const r = resolveUse(m, ctx(both));
    expect(r.judge).toEqual({ vote: ["d", "g"], escalation: "f" });
    expect(r.event).toEqual({ vote: ["g", "d"], escalation: "f" }); // still auto
    expect(r.redteam).toBeUndefined();
    expect(r.auto).toEqual({ event: true, judge: false, redteam: false, universe: true });
    expect(modelsFor(r, "redteam")).toEqual([]);
    expect(usedModelNames(r)).toEqual(["g", "d", "f"]);
  });

  it("Services resolve per family, with node overrides, and re-pick when a key is added", () => {
    const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: "k" };
    const settings = new SettingsStore({ path: ":memory:", env, shellKeys: new Set() });
    const cfg = AppConfig.parse({ watchlist: {}, models: { pool: [g, d, f], use: { redteam: "none", universe: "d" } } });
    const s = new Services(cfg, { dbPath: ":memory:", env, settings });
    expect(s.voters("judge").map((x) => x.name)).toEqual(["g", "f"]);
    const hash = s.configHash;
    settings.set("DEEPSEEK_API_KEY", "dk-0123456789abcdef");
    expect(s.voters("judge").map((x) => x.name)).toEqual(["g", "d"]);
    expect(s.escalation("judge")?.name).toBe("f");
    expect(s.configHash).not.toBe(hash); // node results computed with other models are not reused
    expect(s.voters("judge", ["f", "g"]).map((x) => x.name)).toEqual(["f", "g"]);
    expect(s.escalation("judge", "none")).toBeUndefined();
    expect(s.redTeam()).toBeUndefined();
    expect(s.redTeam("f")?.model).toBe("gemini-2.5-flash");
    expect(s.universeModel().name).toBe("d");
    expect(() => s.voters("event", ["nope"])).toThrow(/unknown model "nope"/);
    expect(s.voters("event")[0]).toBe(s.voters("judge", ["g"])[0]); // one client per model
  });
});

describe("saving models", () => {
  function copyConfig(from = "config/config.example.yaml"): string {
    const p = join(mkdtempSync(join(tmpdir(), "models-")), "config.yaml");
    copyFileSync(join(ROOT, from), p);
    return p;
  }
  const spec = (name: string, model: string) => ({ name, provider: "gemini" as const, model, apiKeyEnv: "GEMINI_API_KEY" });

  it("replaces the pool, merges prices and keeps the comments", () => {
    const p = copyConfig();
    const before = loadConfig(p).models!.pool;
    const r = saveModelPool(p, {
      pool: [...before, { name: "deepseek-reasoner", provider: "openai_compat", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-reasoner", apiKeyEnv: "DEEPSEEK_API_KEY" }],
      pricing: { "deepseek-reasoner": [0.28, 0.42], "gemini-2.5-flash-lite": [0.1, 0.4] },
    });
    const text = readFileSync(p, "utf8");
    expect(text).toContain("# - { name: qwen");
    expect(text).toContain("# USD per 1M tokens");
    expect(text).toContain("- { name: deepseek-reasoner, provider: openai_compat, baseUrl: https://api.deepseek.com/v1, model: deepseek-reasoner, apiKeyEnv: DEEPSEEK_API_KEY }");
    expect(text).toContain("deepseek-reasoner: [ 0.28, 0.42 ]");
    expect(text).toContain("gemini-2.5-flash-lite: [ 0.10, 0.40 ]"); // unchanged price keeps "0.10"
    const cfg = loadConfig(p);
    expect(cfg.models!.pool.map((m) => m.name)).toContain("deepseek-reasoner");
    expect(cfg.models!.use.event).toBe("auto");
    expect(r.config.models).toEqual(cfg.models);
  });

  it("a model picked by auto can be removed; one chosen by hand cannot", () => {
    const p = copyConfig();
    saveModelPool(p, { pool: [spec("gemini-lite", "gemini-2.5-flash-lite"), spec("gemini-flash", "gemini-2.5-flash")] });
    saveModelUse(p, "judge", { vote: ["gemini-lite", "gemini-flash"], escalation: null });
    const before = readFileSync(p, "utf8");
    expect(() => saveModelPool(p, { pool: [spec("gemini-lite", "gemini-2.5-flash-lite")] })).toThrow(/gemini-flash/);
    expect(readFileSync(p, "utf8")).toBe(before);
  });

  it("sets what a family uses, and back to auto", () => {
    const p = copyConfig();
    saveModelUse(p, "judge", { vote: ["deepseek", "gemini-flash"], escalation: null });
    saveModelUse(p, "redteam", "none");
    let m = loadConfig(p).models!;
    expect(m.use.judge).toEqual({ vote: ["deepseek", "gemini-flash"] });
    expect(m.use.event).toBe("auto");
    expect(m.use.redteam).toBe("none");
    expect(readFileSync(p, "utf8")).toContain("# Which model does what");
    saveModelUse(p, "judge", "auto");
    m = loadConfig(p).models!;
    expect(m.use.judge).toBe("auto");
    expect(() => saveModelUse(p, "event", { vote: ["nope"], escalation: null })).toThrow(/not in models.pool/);
  });

  it("rewrites an old tier1 file into pool / use on the first edit", () => {
    const p = copyConfig();
    const old = readFileSync(p, "utf8").replace(/models:\n(?:  .*\n)+/, `models:
  tier1:
    - { name: gemini-lite, provider: gemini, model: gemini-2.5-flash-lite, apiKeyEnv: GEMINI_API_KEY }
    - { name: deepseek, provider: openai_compat, baseUrl: "https://api.deepseek.com/v1", model: deepseek-chat, apiKeyEnv: DEEPSEEK_API_KEY }
  tier2: { name: gemini-flash, provider: gemini, model: gemini-2.5-flash, apiKeyEnv: GEMINI_API_KEY }
`);
    writeFileSync(p, old);
    saveModelUse(p, "event", { vote: ["deepseek", "gemini-lite"], escalation: "gemini-flash" });
    const text = readFileSync(p, "utf8");
    expect(text).not.toContain("tier1");
    expect(text).toContain("# Models (settings screen");
    const m = loadConfig(p).models!;
    expect(m.pool.map((x) => x.name)).toEqual(["gemini-lite", "deepseek", "gemini-flash"]);
    expect(m.use.event).toEqual({ vote: ["deepseek", "gemini-lite"], escalation: "gemini-flash" });
    expect(m.use.judge).toBe("auto");
  });

  it("applies to a running Services without a restart", () => {
    const p = copyConfig();
    const s = new Services(loadConfig(p), { dbPath: ":memory:", env: { GEMINI_API_KEY: "g", DEEPSEEK_API_KEY: "d" } });
    expect(s.voters("judge").map((m) => m.model)).toEqual(["gemini-2.5-flash-lite", "deepseek-chat"]);
    const hash = s.configHash;
    const r = saveModelUse(p, "judge", { vote: ["gemini-flash", "deepseek"], escalation: null });
    s.updateModels(r.config.models, r.config.pricing);
    expect(s.voters("judge").map((m) => m.model)).toEqual(["gemini-2.5-flash", "deepseek-chat"]);
    expect(s.escalation("judge")).toBeUndefined();
    const r2 = saveModelPool(p, { pool: r.config.models!.pool, pricing: { "gemini-2.5-flash": [0.5, 3] } });
    s.updateModels(r2.config.models, r2.config.pricing);
    expect(s.budget.costOf("gemini-2.5-flash", 1_000_000, 0)).toBe(0.5);
    expect(s.configHash).not.toBe(hash);
  });
});

describe("starter models for a key without models", () => {
  it("only for vendors with a key and nothing registered; names do not collide", () => {
    const pool = [{ provider: "openai_compat" as const, name: "gemini-lite", model: "x", baseUrl: "https://example.com/v1", apiKeyEnv: "X_KEY" }];
    const m = missingStarterModels(pool, { GEMINI_API_KEY: "g", OPENROUTER_API_KEY: "" });
    expect(m.map((x) => x.vendor)).toEqual(["gemini"]);
    expect(m[0]!.add.map((x) => [x.name, x.model])).toEqual([["gemini-lite-2", "gemini-2.5-flash-lite"], ["gemini-flash", "gemini-2.5-flash"]]);
    expect(missingStarterModels([{ provider: "gemini", name: "g", model: "gemini-2.5-pro", apiKeyEnv: "GEMINI_API_KEY" }], { GEMINI_API_KEY: "g" })).toEqual([]);
  });
});

describe("one model deciding alone", () => {
  const d = { name: "deepseek", provider: "openai_compat", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKeyEnv: "DEEPSEEK_API_KEY" };
  const d2 = { ...d, name: "deepseek-red" };
  const g = { name: "g", provider: "gemini", model: "gemini-2.5-flash-lite", apiKeyEnv: "GEMINI_API_KEY" };
  const ctx = (quorum: number) => ({ hasKey: () => true, pricing: {}, quorum });

  it("warns about quorum 1 and about voters that are the same model", () => {
    const same = ModelsConfig.parse({ pool: [d, d2, g], use: { event: { vote: ["deepseek", "deepseek-red"] }, judge: { vote: ["deepseek", "deepseek-red"] } } });
    const notes = resolveUse(same, ctx(2)).notes;
    expect(notes.some((n) => n.includes("判断の deepseek と deepseek-red は同じモデル（deepseek-chat）"))).toBe(true);
    expect(resolveUse(ModelsConfig.parse({ pool: [d, g] }), ctx(1)).notes.some((n) => n.includes("harness.quorum が 1"))).toBe(true);
    expect(resolveUse(ModelsConfig.parse({ pool: [d, g] }), ctx(2)).notes).toEqual([]);
  });
});
