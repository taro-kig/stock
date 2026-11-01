import { z } from "zod";
import { postJsonWithRetry, type RetryOptions } from "./http.ts";
import { LLMError, type LLMProvider, type LLMRequest, type LLMResponse } from "./types.ts";

const ChatResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).optional(),
});

/**
 * OpenAI-compatible chat completions: OpenAI, DeepSeek, OpenRouter, Groq, local vLLM...
 * A different vendor than Gemini is what makes the ensemble vote meaningful.
 */
export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  readonly #url: string;
  readonly #apiKey: string;
  readonly #retry: RetryOptions;

  constructor(opts: { model: string; baseUrl: string; name?: string; apiKey: string; retry?: RetryOptions }) {
    if (!opts.apiKey) throw new LLMError(`missing API key for ${opts.baseUrl}`);
    this.model = opts.model;
    this.name = opts.name ?? opts.model;
    this.#url = `${opts.baseUrl.replace(/\/$/, "")}/chat/completions`;
    this.#apiKey = opts.apiKey;
    this.#retry = opts.retry ?? {};
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      temperature: req.temperature ?? 0,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    };
    if (req.jsonMode ?? true) body["response_format"] = { type: "json_object" };
    const t0 = performance.now();
    const raw = await postJsonWithRetry(this.#url, body, { authorization: `Bearer ${this.#apiKey}` }, this.#retry);
    const parsed = ChatResponse.safeParse(raw);
    if (!parsed.success) throw new LLMError(`unexpected response: ${JSON.stringify(raw).slice(0, 300)}`);
    const d = parsed.data;
    return {
      text: d.choices[0]!.message.content ?? "",
      model: this.model,
      inputTokens: d.usage?.prompt_tokens ?? 0,
      outputTokens: d.usage?.completion_tokens ?? 0,
      latencyMs: performance.now() - t0,
    };
  }
}
