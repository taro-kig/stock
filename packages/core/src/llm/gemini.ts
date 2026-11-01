import { z } from "zod";
import { postJsonWithRetry, type RetryOptions } from "./http.ts";
import { LLMError, type LLMProvider, type LLMRequest, type LLMResponse } from "./types.ts";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const GeminiResponse = z.object({
  candidates: z.array(z.object({ content: z.object({ parts: z.array(z.object({ text: z.string().optional() })) }) })).min(1),
  usageMetadata: z.object({ promptTokenCount: z.number().optional(), candidatesTokenCount: z.number().optional() }).optional(),
});

/** Google Gemini via the Generative Language REST API. */
export class GeminiProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly #apiKey: string;
  readonly #retry: RetryOptions;

  constructor(opts: { model: string; name?: string; apiKey: string; retry?: RetryOptions }) {
    if (!opts.apiKey) throw new LLMError("missing Gemini API key");
    this.model = opts.model;
    this.name = opts.name ?? opts.model;
    this.#apiKey = opts.apiKey;
    this.#retry = opts.retry ?? {};
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const generationConfig: Record<string, unknown> = { temperature: req.temperature ?? 0 };
    if (req.jsonMode ?? true) generationConfig["responseMimeType"] = "application/json";
    const t0 = performance.now();
    const raw = await postJsonWithRetry(
      `${BASE}/${this.model}:generateContent`,
      {
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: "user", parts: [{ text: req.user }] }],
        generationConfig,
      },
      { "x-goog-api-key": this.#apiKey },
      this.#retry,
    );
    const parsed = GeminiResponse.safeParse(raw);
    if (!parsed.success) throw new LLMError(`unexpected Gemini response: ${JSON.stringify(raw).slice(0, 300)}`);
    const d = parsed.data;
    return {
      text: d.candidates[0]!.content.parts.map((p) => p.text ?? "").join(""),
      model: this.model,
      inputTokens: d.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: d.usageMetadata?.candidatesTokenCount ?? 0,
      latencyMs: performance.now() - t0,
    };
  }
}
