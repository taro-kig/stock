import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { IbkrConfig } from "./execution/ibkr.ts";
import { WebullConfig } from "./execution/webull.ts";
import { ModelSpec } from "./llm/factory.ts";
import { RiskConfig } from "./strategy/risk.ts";

export const NOTIFY_EVENTS = ["approval", "failure", "orders", "fills", "success", "backup"] as const;

export const AppConfig = z.strictObject({
  /** User prompt versions created from the UI (prompts/<family>/<version>.md). */
  promptsDir: z.string().default("prompts"),
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
  /** Prompt versions in use. Compare candidates with `stockai eval` before switching. */
  prompts: z
    .strictObject({
      // Built-in or user versions (prompts/<family>/<version>.md); unknown names fail when used.
      event: z.string().regex(/^event-[a-z0-9.-]+$/).default("event-v1"),
      judge: z.string().regex(/^judge-[a-z0-9.-]+$/).default("judge-v1"),
      redTeam: z.string().regex(/^redteam-[a-z0-9.-]+$/).default("redteam-v1"),
      universe: z.string().regex(/^universe-[a-z0-9.-]+$/).default("universe-v1"),
    })
    .prefault({}),
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
  /** Interactive Brokers via IB Gateway (docs/ibkr.md). */
  ibkr: IbkrConfig.optional(),
  /** Webull Japan OpenAPI (docs/webull.md). */
  webull: WebullConfig.optional(),
  /** Discord notifications (the webhook URL is a secret: settings screen → DISCORD_WEBHOOK_URL). */
  notify: z
    .strictObject({
      webhookEnv: z.string().default("DISCORD_WEBHOOK_URL"),
      /** approval: waiting for approval · failure: failed / partly failed run · orders: orders sent to (or previewed by) a broker ·
       *  fills: paper fills · success: every successful run · backup: backup failed */
      events: z.array(z.enum(NOTIFY_EVENTS)).default(["approval", "failure", "orders", "backup"]),
      /** Where links in notifications point. */
      baseUrl: z.string().default("http://127.0.0.1:4317"),
    })
    .prefault({}),
  /** Daily copy of the database (the forward record of judgments cannot be recreated). */
  backup: z
    .strictObject({
      enabled: z.boolean().default(true),
      /** Default <dataDir>/backups. Another disk or a synced folder protects against disk failure. */
      dir: z.string().optional(),
      at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM").default("12:30"),
      keepDaily: z.number().int().min(1).default(14),
      keepMonthly: z.number().int().min(0).default(12),
      /** Also copy settings.sqlite (API keys, plain text). Off by default: keys can be re-entered, a leaked copy cannot be recalled. */
      includeSettings: z.boolean().default(false),
    })
    .prefault({}),
  /** Runs started automatically by the web server (local time of the server). */
  schedule: z
    .array(
      z.strictObject({
        workflow: z.string(),
        at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM"),
        /** 0 = Sunday … 6 = Saturday */
        days: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]),
      }),
    )
    .default([]),
});
export type AppConfig = z.output<typeof AppConfig>;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

export function loadConfig(path: string): AppConfig {
  const r = AppConfig.safeParse(parseYaml(readFileSync(path, "utf8")));
  if (!r.success) throw new Error(`invalid config ${path}:\n${r.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return r.data;
}
