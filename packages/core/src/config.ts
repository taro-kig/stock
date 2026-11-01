import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ModelSpec } from "./llm/factory.ts";
import { RiskConfig } from "./strategy/risk.ts";

export const AppConfig = z.strictObject({
  dataDir: z.string().default("data"),
  harness: z
    .strictObject({
      /** H5: hard daily cap for all LLM calls (USD). */
      dailyBudgetUsd: z.number().positive().default(0.5),
      /** H3: votes needed to accept an output. */
      quorum: z.number().int().min(1).default(2),
      /** H1: re-asks on invalid JSON / schema errors. */
      maxRetries: z.number().int().min(0).default(2),
    })
    .prefault({}),
  models: z
    .strictObject({
      /** Cheap models from different vendors (uncorrelated errors). */
      tier1: z.array(ModelSpec).min(1),
      /** Tie-breaker for important disagreements only. */
      tier2: ModelSpec.optional(),
      /** May veto a bullish consensus. */
      redTeam: ModelSpec.optional(),
    })
    .optional(),
  /** USD per 1M tokens [input, output]. Verify against current price pages. */
  pricing: z.record(z.string(), z.tuple([z.number(), z.number()])).default({}),
  sources: z.array(z.strictObject({ name: z.string(), url: z.url(), weight: z.number().min(0).default(1) })).default([]),
  watchlist: z.record(
    z.string(),
    z.strictObject({ name: z.string(), aliases: z.array(z.string()).default([]), sector: z.string().default("unknown") }),
  ),
  market: z
    .strictObject({
      currency: z.enum(["JPY", "USD"]).default("JPY"),
      /** Benchmark ticker (must be present in price data) for relative strength, regime and grading. */
      benchmark: z.string().optional(),
    })
    .prefault({}),
  risk: RiskConfig.prefault({}),
});
export type AppConfig = z.output<typeof AppConfig>;

export function loadConfig(path: string): AppConfig {
  const r = AppConfig.safeParse(parseYaml(readFileSync(path, "utf8")));
  if (!r.success) throw new Error(`invalid config ${path}:\n${r.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return r.data;
}
