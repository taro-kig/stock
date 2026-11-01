import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { STANCES } from "../ai/judge.ts";
import { EVENT_TYPES } from "../signals/models.ts";

/**
 * Hand-labelled evaluation sets ("golden sets") for prompts and models.
 * Labels list every *acceptable* value, because several answers can be defensible
 * (e.g. direction +1 or +2 for a 9% guidance raise).
 */
export const EventCase = z.strictObject({
  id: z.string(),
  note: z.string().default(""),
  /** True once a human has checked the label (drafts are false). */
  reviewed: z.boolean().default(false),
  candidates: z.record(z.string(), z.string()),
  doc: z.strictObject({
    source: z.string().default("golden"),
    title: z.string(),
    body: z.string().default(""),
    publishedAt: z.string().nullable().default(null),
  }),
  expect: z.strictObject({
    /** true / false, or [true, false] when either is defensible (then the other labels apply if relevant). */
    relevant: z.union([z.boolean(), z.array(z.boolean()).min(1)]),
    tickers: z.array(z.string()).optional(),
    eventType: z.array(z.enum(EVENT_TYPES)).optional(),
    direction: z.array(z.number().int().min(-2).max(2)).optional(),
    materiality: z.array(z.number().int().min(0).max(3)).optional(),
    horizon: z.array(z.enum(["days", "weeks", "months"])).optional(),
  }),
});
export type EventCase = z.output<typeof EventCase>;

export const JudgeCase = z.strictObject({
  id: z.string(),
  note: z.string().default(""),
  reviewed: z.boolean().default(false),
  row: z.strictObject({
    ticker: z.string(),
    name: z.string(),
    sector: z.string().default("unknown"),
    close: z.number().positive(),
    atr: z.number().nullable().default(null),
    momentum: z.number().nullable(),
    relStrength: z.number().nullable(),
    vol: z.number().nullable(),
    trend: z.enum(["up", "flat", "down"]).nullable(),
    ret20: z.number().nullable().default(null),
    fromHigh52: z.number().nullable().default(null),
  }),
  rank: z.number().int().positive(),
  universe: z.number().int().positive(),
  events: z
    .array(z.strictObject({
      date: z.string(),
      eventType: z.enum(EVENT_TYPES),
      direction: z.number().int().min(-2).max(2),
      materiality: z.number().int().min(0).max(3),
      evidence: z.string(),
    }))
    .default([]),
  held: z.strictObject({ entryPrice: z.number().positive(), daysHeld: z.number().int().min(0) }).optional(),
  /** Stances a sound analyst could take from this dossier; anything else is a sanity failure. */
  expect: z.strictObject({ allowed: z.array(z.enum(STANCES)).min(1) }),
});
export type JudgeCase = z.output<typeof JudgeCase>;

function setSchema<T extends z.ZodType>(item: T) {
  return z
    .strictObject({ name: z.string(), description: z.string().default(""), cases: z.array(item).min(1) })
    .superRefine((s, ctx) => {
      const seen = new Set<string>();
      for (const c of s.cases as Array<{ id: string }>) {
        if (seen.has(c.id)) ctx.addIssue({ code: "custom", message: `duplicate case id ${c.id}` });
        seen.add(c.id);
      }
    });
}
export const EventGoldenSet = setSchema(EventCase);
export const JudgeGoldenSet = setSchema(JudgeCase);
export type EventGoldenSet = z.output<typeof EventGoldenSet>;
export type JudgeGoldenSet = z.output<typeof JudgeGoldenSet>;

function load<S extends z.ZodType>(schema: S, path: string): z.output<S> {
  const r = schema.safeParse(parseYaml(readFileSync(path, "utf8")));
  if (!r.success) throw new Error(`invalid golden set ${path}:\n${r.error.issues.map((i) => `- ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  return r.data;
}
export const loadEventSet = (path: string): EventGoldenSet => load(EventGoldenSet, path);
export const loadJudgeSet = (path: string): JudgeGoldenSet => load(JudgeGoldenSet, path);
