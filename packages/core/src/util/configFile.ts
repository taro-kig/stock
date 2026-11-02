import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMap, parseDocument, YAMLMap } from "yaml";
import { z } from "zod";
import { AppConfig } from "../config.ts";
import { ModelsInput } from "../llm/catalog.ts";

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

/**
 * Replaces `models` (tier1 / tier2 / redTeam) and merges prices into `pricing`, keeping comments.
 * A null tier2 / redTeam removes it (redTeam then falls back to tier2).
 */
export function saveModels(loadedFrom: string, input: ModelsInput): { file: string; created: boolean; config: AppConfig } {
  const m = ModelsInput.parse(input);
  return editConfig(loadedFrom, (doc) => {
    const flow = (spec: (typeof m.tier1)[number]) => {
      // name first, like the hand-written examples
      const { name, provider, model, ...rest } = spec;
      const n = doc.createNode({ name, provider, ...("baseUrl" in rest ? { baseUrl: rest.baseUrl } : {}), model, apiKeyEnv: rest.apiKeyEnv });
      n.flow = true;
      return n;
    };
    if (!isMap(doc.get("models", true))) doc.set("models", new YAMLMap());
    // setIn on the existing map keeps the keys' comments; the nodes' own comments are carried
    // over (e.g. the commented-out 3rd member below tier1).
    const keep = (key: string, node: ReturnType<typeof doc.createNode>) => {
      const old = doc.getIn(["models", key], true) as { comment?: string | null; commentBefore?: string | null } | undefined;
      if (old?.comment) node.comment = old.comment;
      if (old?.commentBefore) node.commentBefore = old.commentBefore;
      doc.setIn(["models", key], node);
    };
    keep("tier1", doc.createNode(m.tier1.map((s) => flow(s))));
    for (const key of ["tier2", "redTeam"] as const) {
      const spec = m[key];
      if (spec) keep(key, flow(spec));
      else doc.deleteIn(["models", key]);
    }
    if (Object.keys(m.pricing).length) {
      if (!isMap(doc.get("pricing", true))) doc.set("pricing", new YAMLMap());
      for (const [model, price] of Object.entries(m.pricing)) {
        const old = doc.getIn(["pricing", model]) as unknown;
        if (JSON.stringify((old as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? old) === JSON.stringify(price)) continue; // keep "0.10" as written
        const n = doc.createNode(price);
        n.flow = true;
        doc.setIn(["pricing", model], n);
      }
    }
  });
}
