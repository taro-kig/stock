/**
 * Provider-agnostic LLM interface. A provider only turns (system, user) into
 * text + token counts; everything that makes output trustworthy is in harness/.
 */
export interface LLMRequest {
  system: string;
  user: string;
  temperature?: number;
  jsonMode?: boolean;
}

export interface LLMResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface LLMProvider {
  /** Unique label used in votes and logs, e.g. "gemini-lite". */
  readonly name: string;
  /** Model id sent to the API; also the key into the pricing table. */
  readonly model: string;
  generate(req: LLMRequest): Promise<LLMResponse>;
}

export class LLMError extends Error {
  override name = "LLMError";
}
