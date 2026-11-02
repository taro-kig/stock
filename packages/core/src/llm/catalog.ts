import { z } from "zod";
import type { ModelSpec } from "./factory.ts";

/**
 * Vendors the settings screen knows how to talk to. Each one maps to a ModelSpec
 * (provider, base URL, key name); "custom" is any other OpenAI-compatible endpoint.
 */
export const VENDOR_IDS = ["gemini", "deepseek", "openrouter", "openai", "custom"] as const;
export type VendorId = (typeof VENDOR_IDS)[number];

export interface KnownModel {
  id: string;
  note?: string;
  /** USD per 1M tokens [input, output]. Reference values only: verify on the vendor's price page. */
  price?: readonly [number, number];
}

export interface Vendor {
  id: VendorId;
  label: string;
  provider: ModelSpec["provider"];
  /** Fixed for the named vendors; free for custom. */
  baseUrl?: string;
  apiKeyEnv: string;
  priceUrl?: string;
  /** Shown when the model list cannot be fetched (no key yet, offline). */
  models: KnownModel[];
}

export const VENDORS: Record<VendorId, Vendor> = {
  gemini: {
    id: "gemini", label: "Google Gemini", provider: "gemini", apiKeyEnv: "GEMINI_API_KEY",
    priceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    models: [
      { id: "gemini-2.5-flash-lite", note: "最安。多数決の1票に向く", price: [0.1, 0.4] },
      { id: "gemini-2.5-flash", note: "エスカレーション・レッドチーム向き", price: [0.3, 2.5] },
      { id: "gemini-2.5-pro", note: "高い。日次運用には不向き", price: [1.25, 10] },
    ],
  },
  deepseek: {
    id: "deepseek", label: "DeepSeek", provider: "openai_compat", baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY",
    priceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    models: [
      { id: "deepseek-chat", note: "多数決の別ベンダー枠", price: [0.28, 0.42] },
      { id: "deepseek-reasoner", note: "推論モデル。遅く出力トークンが多い", price: [0.28, 0.42] },
    ],
  },
  openrouter: {
    id: "openrouter", label: "OpenRouter", provider: "openai_compat", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY",
    priceUrl: "https://openrouter.ai/models",
    models: [
      { id: "qwen/qwen-2.5-72b-instruct", note: "3つ目の別ベンダー枠の例" },
      { id: "meta-llama/llama-3.3-70b-instruct" },
    ],
  },
  openai: {
    id: "openai", label: "OpenAI", provider: "openai_compat", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY",
    priceUrl: "https://openai.com/api/pricing/",
    models: [
      { id: "gpt-4.1-nano", price: [0.1, 0.4] },
      { id: "gpt-4.1-mini", price: [0.4, 1.6] },
      { id: "gpt-4o-mini", price: [0.15, 0.6] },
    ],
  },
  custom: {
    id: "custom", label: "その他（OpenAI 互換）", provider: "openai_compat", apiKeyEnv: "OPENAI_API_KEY",
    models: [],
  },
};

/** Our reference price for a model id (USD / 1M tokens), if it is one we know. */
export function knownPrice(model: string): readonly [number, number] | undefined {
  for (const v of Object.values(VENDORS)) {
    const m = v.models.find((x) => x.id === model);
    if (m?.price) return m.price;
  }
  return undefined;
}

/** Which vendor a configured model belongs to (custom when the base URL is not one of ours). */
export function vendorOf(spec: ModelSpec): VendorId {
  if (spec.provider === "gemini") return "gemini";
  const host = hostOf(spec.baseUrl);
  for (const v of ["deepseek", "openrouter", "openai"] as const) {
    if (host && host === hostOf(VENDORS[v].baseUrl!)) return v;
  }
  return "custom";
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/** A config name derived from the model id: "qwen/qwen-2.5-72b-instruct" → "qwen-2.5-72b-instruct". */
export function modelSlug(model: string): string {
  const last = model.split("/").filter(Boolean).at(-1) ?? model;
  return last.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "model";
}

/** The model as offered by the vendor's API. */
export interface AvailableModel {
  id: string;
  label?: string;
  note?: string;
  price?: readonly [number, number];
}

export interface ModelList {
  vendor: VendorId;
  models: AvailableModel[];
  /** api: fetched with the user's key · builtin: our short list (no key, or the API failed). */
  source: "api" | "builtin";
  error?: string;
}

/** Not text-generation models: embeddings, images, speech, realtime, moderation... */
const NOT_CHAT = /embed|imagen|image|tts|audio|speech|whisper|transcribe|realtime|live|dall-e|moderation|aqa|veo|search|computer-use|sora/i;

const GeminiList = z.object({
  models: z.array(z.object({ name: z.string(), displayName: z.string().optional(), supportedGenerationMethods: z.array(z.string()).optional() })).default([]),
  nextPageToken: z.string().optional(),
});
const OpenAIList = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string().optional(), pricing: z.object({ prompt: z.string().optional(), completion: z.string().optional() }).optional() })),
});

/**
 * Lists the models the vendor offers to this key. Without a key, or when the call fails,
 * returns the built-in list instead (with `error` saying why), so the screen always has choices.
 */
export async function listModels(
  vendorId: VendorId,
  o: { env: NodeJS.ProcessEnv; fetch: typeof fetch; baseUrl?: string; apiKeyEnv?: string },
): Promise<ModelList> {
  const v = VENDORS[vendorId];
  const known = new Map(v.models.map((m) => [m.id, m]));
  const builtin = (error: string): ModelList => ({ vendor: vendorId, models: v.models.map((m) => ({ ...m })), source: "builtin", error });
  const keyEnv = vendorId === "custom" ? (o.apiKeyEnv ?? v.apiKeyEnv) : v.apiKeyEnv;
  const key = o.env[keyEnv];
  const baseUrl = vendorId === "custom" ? o.baseUrl : v.baseUrl;
  if (!key) return builtin(`${keyEnv} が未設定のため、一覧は取得していません`);
  try {
    let models: AvailableModel[];
    if (v.provider === "gemini") {
      models = [];
      let page: string | undefined;
      for (let i = 0; i < 5; i++) {
        const q = new URLSearchParams({ pageSize: "1000", ...(page ? { pageToken: page } : {}) });
        const res = await o.fetch(`https://generativelanguage.googleapis.com/v1beta/models?${q}`, { headers: { "x-goog-api-key": key }, signal: AbortSignal.timeout(15_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const d = GeminiList.parse(await res.json());
        for (const m of d.models) {
          const id = m.name.replace(/^models\//, "");
          if (!(m.supportedGenerationMethods ?? []).includes("generateContent") || NOT_CHAT.test(id)) continue;
          models.push({ id, ...(m.displayName ? { label: m.displayName } : {}) });
        }
        page = d.nextPageToken;
        if (!page) break;
      }
    } else {
      if (!baseUrl) return builtin("Base URL が未入力です");
      const res = await o.fetch(`${baseUrl.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = OpenAIList.parse(await res.json());
      models = d.data
        .filter((m) => !NOT_CHAT.test(m.id))
        .map((m) => {
          const pIn = Number(m.pricing?.prompt);
          const pOut = Number(m.pricing?.completion);
          // OpenRouter prices are USD per token.
          const price = m.pricing && Number.isFinite(pIn) && Number.isFinite(pOut) && pIn >= 0 && pOut >= 0
            ? ([round(pIn * 1e6), round(pOut * 1e6)] as const)
            : undefined;
          return { id: m.id, ...(m.name && m.name !== m.id ? { label: m.name } : {}), ...(price ? { price } : {}) };
        });
    }
    // Our notes and reference prices for the models we know; known models first, then the rest by name.
    const merged = models.map((m) => {
      const k = known.get(m.id);
      return { ...m, ...(k?.note ? { note: k.note } : {}), ...(m.price ? {} : k?.price ? { price: k.price } : {}) };
    });
    merged.sort((a, b) => Number(known.has(b.id)) - Number(known.has(a.id)) || a.id.localeCompare(b.id));
    return { vendor: vendorId, models: merged, source: "api" };
  } catch (e) {
    return builtin(`一覧を取得できませんでした（${e instanceof Error ? e.message : String(e)}）`);
  }
}

function round(x: number): number {
  return Math.round(x * 10_000) / 10_000;
}

/** The models section as edited on the settings screen. */
const Name = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,39}$/, "name: a-z, 0-9, '.', '_', '-'（40 文字まで）");
/** One model as entered on the settings screen (stricter than the config schema). */
export const ModelSpecInput = z.discriminatedUnion("provider", [
  z.strictObject({ provider: z.literal("gemini"), name: Name, model: z.string().trim().min(1).max(120), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/) }),
  z.strictObject({
    provider: z.literal("openai_compat"), name: Name, model: z.string().trim().min(1).max(120),
    baseUrl: z.url().refine((u) => /^https?:\/\//.test(u), "baseUrl: http(s) のみ"), apiKeyEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  }),
]);
const Price = z.tuple([z.number().min(0).max(1000), z.number().min(0).max(1000)]);

/** The model pool as edited on the settings screen. Which family uses which model is set on the prompts screen. */
export const PoolInput = z
  .strictObject({
    pool: z.array(ModelSpecInput).min(1, "モデルを 1 つ以上登録してください").max(12, "登録できるモデルは 12 個まで"),
    /** Prices for these models (merged into config.pricing; other entries are kept). */
    pricing: z.record(z.string(), Price).default({}),
  })
  .superRefine((m, ctx) => {
    const names = new Set<string>();
    for (const s of m.pool) {
      if (names.has(s.name)) ctx.addIssue({ code: "custom", message: `名前「${s.name}」が 2 回使われています` });
      names.add(s.name);
    }
  });
export type PoolInput = z.input<typeof PoolInput>;
