import type { LLMProvider, LLMRequest, LLMResponse } from "./types.ts";

export type Responder = (req: LLMRequest) => string;

/**
 * Deterministic provider for tests and offline demos: no network, no cost.
 * `responses` is either a list (consumed in order, the last one repeats) or a function.
 */
export class FakeProvider implements LLMProvider {
  readonly name: string;
  readonly model: string;
  calls = 0;
  readonly #queue: string[];
  readonly #fn: Responder | undefined;

  constructor(name: string, responses: string[] | Responder, model?: string) {
    this.name = name;
    this.model = model ?? name;
    this.#fn = typeof responses === "function" ? responses : undefined;
    this.#queue = typeof responses === "function" ? [] : [...responses];
  }

  async generate(req: LLMRequest): Promise<LLMResponse> {
    this.calls++;
    const text = this.#fn ? this.#fn(req) : this.#queue.length > 1 ? this.#queue.shift()! : (this.#queue[0] ?? "");
    return {
      text,
      model: this.model,
      inputTokens: Math.ceil((req.system.length + req.user.length) / 4),
      outputTokens: Math.ceil(text.length / 4),
      latencyMs: 0,
    };
  }
}
