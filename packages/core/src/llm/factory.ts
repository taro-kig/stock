import { z } from "zod";
import { GeminiProvider } from "./gemini.ts";
import { OpenAICompatProvider } from "./openaiCompat.ts";
import { LLMError, type LLMProvider } from "./types.ts";

export const ModelSpec = z.discriminatedUnion("provider", [
  z.object({
    provider: z.literal("gemini"),
    name: z.string(),
    model: z.string(),
    apiKeyEnv: z.string().default("GEMINI_API_KEY"),
  }),
  z.object({
    provider: z.literal("openai_compat"),
    name: z.string(),
    model: z.string(),
    baseUrl: z.url(),
    apiKeyEnv: z.string().default("OPENAI_API_KEY"),
  }),
]);
export type ModelSpec = z.infer<typeof ModelSpec>;

export function buildProvider(spec: ModelSpec, env: NodeJS.ProcessEnv = process.env): LLMProvider {
  const apiKey = env[spec.apiKeyEnv];
  if (!apiKey) throw new LLMError(`model "${spec.name}": environment variable ${spec.apiKeyEnv} is not set`);
  switch (spec.provider) {
    case "gemini":
      return new GeminiProvider({ model: spec.model, name: spec.name, apiKey });
    case "openai_compat":
      return new OpenAICompatProvider({ model: spec.model, name: spec.name, baseUrl: spec.baseUrl, apiKey });
  }
}
