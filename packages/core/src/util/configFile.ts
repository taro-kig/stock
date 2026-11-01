import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMap, parseDocument, YAMLMap } from "yaml";
import { z } from "zod";
import { AppConfig } from "../config.ts";

/** One watchlist row as edited in the UI. */
export const WatchlistEntryInput = z.strictObject({
  name: z.string().trim().min(1).max(80),
  aliases: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  sector: z.string().trim().min(1).max(40).default("unknown"),
});

export const WatchlistInput = z
  .record(z.string().regex(/^[A-Z0-9][A-Z0-9.-]{0,9}$/, "ticker: A-Z, 0-9, '.', '-' (e.g. AAPL, BRK.B, 7203)"), WatchlistEntryInput)
  .refine((w) => Object.keys(w).length >= 1, "the watchlist needs at least one ticker")
  .refine((w) => Object.keys(w).length <= 200, "at most 200 tickers");

/** The file edits go to: an *.example.yaml is never modified; config/config.yaml is created from it instead. */
export function editableConfigPath(loadedFrom: string): string {
  return basename(loadedFrom).includes(".example.") ? join(dirname(loadedFrom), "config.yaml") : loadedFrom;
}

type YamlDoc = ReturnType<typeof parseDocument>;

/**
 * Edits the config file in place, keeping every other line and comment: the result is
 * validated before anything is written, the previous file is kept as .bak and the new
 * one is written atomically. An *.example.yaml is never touched (config.yaml is created).
 */
export function editConfig(loadedFrom: string, mutate: (doc: YamlDoc) => void): { file: string; created: boolean; config: AppConfig } {
  const target = editableConfigPath(loadedFrom);
  const created = target !== loadedFrom && !existsSync(target);
  if (target !== loadedFrom && !created) {
    throw new Error(`${target} already exists but the server was started with ${loadedFrom}; restart the server so it uses ${target}, then edit again`);
  }
  const doc = parseDocument(readFileSync(created ? loadedFrom : target, "utf8"));
  if (doc.errors.length) throw new Error(`cannot parse ${target}: ${doc.errors[0]!.message}`);
  mutate(doc);
  const parsed = AppConfig.safeParse(doc.toJS());
  if (!parsed.success) throw new Error(`invalid config after edit: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const text = doc.toString({ lineWidth: 0 });
  if (!created) copyFileSync(target, `${target}.bak`);
  const tmp = `${target}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, target);
  return { file: target, created, config: parsed.data };
}

/** Replaces `watchlist` (and optionally `market.benchmark`). */
export function saveWatchlist(
  loadedFrom: string,
  watchlist: z.input<typeof WatchlistInput>,
  benchmark?: string,
): { file: string; created: boolean; config: AppConfig } {
  const wl = WatchlistInput.parse(watchlist);
  if (benchmark !== undefined && benchmark.trim() && !/^[A-Z0-9][A-Z0-9.-]{0,9}$/.test(benchmark.trim())) throw new Error("benchmark: A-Z, 0-9, '.', '-'");
  return editConfig(loadedFrom, (doc) => {
    const map = new YAMLMap();
    for (const [ticker, e] of Object.entries(wl).sort(([a], [b]) => a.localeCompare(b))) {
      const entry = doc.createNode({ name: e.name, ...(e.aliases.length ? { aliases: e.aliases } : {}), sector: e.sector });
      entry.flow = true;
      map.set(doc.createNode(ticker), entry);
    }
    const old = doc.get("watchlist", true);
    if (isMap(old) && old.commentBefore) map.commentBefore = old.commentBefore;
    doc.set("watchlist", map);
    if (benchmark !== undefined) {
      const b = benchmark.trim();
      if (b) doc.setIn(["market", "benchmark"], b);
      else doc.deleteIn(["market", "benchmark"]);
    }
  });
}

/** Sets one value, e.g. ["prompts", "judge"] = "judge-v2". */
export function saveConfigValue(loadedFrom: string, path: string[], value: string | number | boolean) {
  return editConfig(loadedFrom, (doc) => doc.setIn(path, value));
}
