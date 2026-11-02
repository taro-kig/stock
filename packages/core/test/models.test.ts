import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { listModels, ModelsInput, modelSlug, vendorOf } from "../src/llm/catalog.ts";
import { Services } from "../src/services.ts";
import { saveModels } from "../src/util/configFile.ts";

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

  it("validates the edited models", () => {
    const g = { provider: "gemini" as const, name: "g", model: "gemini-2.5-flash-lite", apiKeyEnv: "GEMINI_API_KEY" };
    const d = { provider: "openai_compat" as const, name: "d", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" };
    expect(ModelsInput.safeParse({ tier1: [g, d], tier2: null, redTeam: null }).success).toBe(true);
    expect(ModelsInput.safeParse({ tier1: [], tier2: null, redTeam: null }).success).toBe(false);
    expect(ModelsInput.safeParse({ tier1: [g, { ...g, name: "g2" }], tier2: null, redTeam: null }).success).toBe(false); // same model twice
    expect(ModelsInput.safeParse({ tier1: [g, { ...d, name: "g" }], tier2: null, redTeam: null }).success).toBe(false); // name clash
    expect(ModelsInput.safeParse({ tier1: [g, d], tier2: { ...g, name: "f", model: "gemini-2.5-flash" }, redTeam: { ...g, name: "f", model: "gemini-2.5-flash" } }).success).toBe(true);
    expect(ModelsInput.safeParse({ tier1: [{ ...g, name: "Bad Name" }, d], tier2: null, redTeam: null }).success).toBe(false);
  });
});

describe("saving models", () => {
  function copyConfig(): string {
    const p = join(mkdtempSync(join(tmpdir(), "models-")), "config.yaml");
    copyFileSync(join(ROOT, "config/config.example.yaml"), p);
    return p;
  }

  it("replaces models, merges prices and keeps the comments", () => {
    const p = copyConfig();
    const r = saveModels(p, {
      tier1: [
        { provider: "gemini", name: "gemini-2.5-flash", model: "gemini-2.5-flash", apiKeyEnv: "GEMINI_API_KEY" },
        { provider: "openai_compat", name: "deepseek-reasoner", model: "deepseek-reasoner", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" },
      ],
      tier2: null,
      redTeam: { provider: "gemini", name: "gemini-2.5-pro", model: "gemini-2.5-pro", apiKeyEnv: "GEMINI_API_KEY" },
      pricing: { "deepseek-reasoner": [0.28, 0.42], "gemini-2.5-pro": [1.25, 10] },
    });
    const text = readFileSync(p, "utf8");
    expect(text).toContain("# A 3rd member enables 2-of-3 voting");
    expect(text).toContain("# USD per 1M tokens");
    expect(text).toContain("- { name: deepseek-reasoner, provider: openai_compat, baseUrl: https://api.deepseek.com/v1, model: deepseek-reasoner, apiKeyEnv: DEEPSEEK_API_KEY }");
    expect(text).toContain("deepseek-reasoner: [ 0.28, 0.42 ]");
    const cfg = loadConfig(p);
    expect(cfg.models!.tier1.map((m) => m.model)).toEqual(["gemini-2.5-flash", "deepseek-reasoner"]);
    expect(cfg.models!.tier2).toBeUndefined();
    expect(cfg.models!.redTeam!.model).toBe("gemini-2.5-pro");
    expect(cfg.pricing["deepseek-chat"]).toEqual([0.27, 1.1]); // other prices kept
    expect(cfg.pricing["gemini-2.5-pro"]).toEqual([1.25, 10]);
    expect(r.config.models).toEqual(cfg.models);
  });

  it("applies to a running Services without a restart", () => {
    const p = copyConfig();
    const s = new Services(loadConfig(p), { dbPath: ":memory:", env: { GEMINI_API_KEY: "g", DEEPSEEK_API_KEY: "d" } });
    expect(s.tier1().map((m) => m.model)).toEqual(["gemini-2.5-flash-lite", "deepseek-chat"]);
    const hash = s.configHash;
    const r = saveModels(p, {
      tier1: [
        { provider: "gemini", name: "gemini-2.5-flash", model: "gemini-2.5-flash", apiKeyEnv: "GEMINI_API_KEY" },
        { provider: "openai_compat", name: "deepseek-chat", model: "deepseek-chat", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY" },
      ],
      tier2: null, redTeam: null, pricing: { "gemini-2.5-flash": [0.5, 3] },
    });
    s.updateModels(r.config.models, r.config.pricing);
    expect(s.tier1().map((m) => m.model)).toEqual(["gemini-2.5-flash", "deepseek-chat"]);
    expect(s.tier2()).toBeUndefined();
    expect(s.budget.costOf("gemini-2.5-flash", 1_000_000, 0)).toBe(0.5);
    expect(s.configHash).not.toBe(hash);
  });
});
