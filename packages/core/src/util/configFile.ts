import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMap, parseDocument, YAMLMap } from "yaml";
import { z } from "zod";
import { AppConfig } from "../config.ts";
import { PoolInput } from "../llm/catalog.ts";
import { MODEL_USES, NO_MODEL, usedModelNames, type ModelsConfig, type ModelUse } from "../llm/roles.ts";

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

type Spec = ModelsConfig["pool"][number];
const flowSpec = (doc: YamlDoc, spec: Spec) => {
  // name first, like the hand-written examples
  const n = doc.createNode({ name: spec.name, provider: spec.provider, ...(spec.provider === "openai_compat" ? { baseUrl: spec.baseUrl } : {}), model: spec.model, apiKeyEnv: spec.apiKeyEnv });
  n.flow = true;
  return n;
};
const useNode = (doc: YamlDoc, v: ModelsConfig["use"]["event"]) => {
  const n = doc.createNode({ vote: v.vote, ...(v.escalation ? { escalation: v.escalation } : {}) });
  n.flow = true;
  return n;
};

/**
 * Makes sure `models` has the pool / use shape. A pre-v0.17 file (tier1 / tier2 / redTeam) is
 * rewritten from its parsed form once (comments above `models` are kept).
 */
function modernizeModels(doc: YamlDoc, current: ModelsConfig | undefined): void {
  const old = doc.get("models", true);
  if (isMap(old) && old.has("pool")) return;
  if (!current) throw new Error("config.models is not set: add models.pool to config.yaml first");
  const map = new YAMLMap();
  map.set(doc.createNode("pool"), doc.createNode(current.pool.map((x) => flowSpec(doc, x))));
  const use = new YAMLMap();
  use.set(doc.createNode("event"), useNode(doc, current.use.event));
  use.set(doc.createNode("judge"), useNode(doc, current.use.judge));
  if (current.use.redteam) use.set(doc.createNode("redteam"), doc.createNode(current.use.redteam));
  if (current.use.universe) use.set(doc.createNode("universe"), doc.createNode(current.use.universe));
  map.set(doc.createNode("use"), use);
  if (isMap(old) && old.commentBefore) map.commentBefore = old.commentBefore;
  doc.set("models", map);
}

function currentModels(doc: YamlDoc): ModelsConfig | undefined {
  const r = AppConfig.shape.models.safeParse((doc.toJS() as { models?: unknown }).models);
  return r.success ? r.data : undefined;
}

function mergePricing(doc: YamlDoc, pricing: Record<string, readonly [number, number]>): void {
  if (!Object.keys(pricing).length) return;
  if (!isMap(doc.get("pricing", true))) doc.set("pricing", new YAMLMap());
  for (const [model, price] of Object.entries(pricing)) {
    const old = doc.getIn(["pricing", model]) as unknown;
    if (JSON.stringify((old as { toJSON?: () => unknown } | undefined)?.toJSON?.() ?? old) === JSON.stringify(price)) continue; // keep "0.10" as written
    const n = doc.createNode([...price]);
    n.flow = true;
    doc.setIn(["pricing", model], n);
  }
}

/**
 * Replaces `models.pool` and merges prices into `pricing`, keeping comments. Fails (nothing written)
 * when a model that `models.use` refers to is removed.
 */
export function saveModelPool(loadedFrom: string, input: PoolInput): { file: string; created: boolean; config: AppConfig } {
  const m = PoolInput.parse(input);
  return editConfig(loadedFrom, (doc) => {
    const cur = currentModels(doc);
    if (cur) {
      const names = new Set(m.pool.map((x) => x.name));
      const gone = usedModelNames(cur).filter((n) => !names.has(n));
      if (gone.length) throw new Error(`${gone.join(", ")} はプロンプト画面のモデル設定で使われているので外せません。先に別のモデルに切り替えてください`);
      modernizeModels(doc, cur);
    } else {
      // first models section: everything votes, no escalation
      const vote = { vote: m.pool.slice(0, 2).map((x) => x.name) };
      modernizeModels(doc, { pool: m.pool, use: { event: vote, judge: vote } });
    }
    const seq = doc.createNode(m.pool.map((x) => flowSpec(doc, x)));
    const old = doc.getIn(["models", "pool"], true) as { comment?: string | null; commentBefore?: string | null } | undefined;
    if (old?.comment) seq.comment = old.comment;
    if (old?.commentBefore) seq.commentBefore = old.commentBefore;
    doc.setIn(["models", "pool"], seq);
    mergePricing(doc, m.pricing);
  });
}

/** What one family uses: voters + escalation (event / judge) or one model (redteam / universe; null = the default). */
export type ModelUseValue = { vote: string[]; escalation: string | null } | string | null;

/** Sets `models.use.<family>`, keeping comments. */
export function saveModelUse(loadedFrom: string, use: ModelUse, value: ModelUseValue): { file: string; created: boolean; config: AppConfig } {
  if (!MODEL_USES.includes(use)) throw new Error(`unknown use ${use}`);
  return editConfig(loadedFrom, (doc) => {
    modernizeModels(doc, currentModels(doc));
    if (use === "event" || use === "judge") {
      if (!value || typeof value !== "object" || !Array.isArray(value.vote)) throw new Error(`${use}: { vote: [...], escalation } が必要です`);
      const v = { vote: value.vote.map(String), ...(value.escalation && value.escalation !== NO_MODEL ? { escalation: String(value.escalation) } : {}) };
      doc.setIn(["models", "use", use], useNode(doc, v));
    } else if (value === null) {
      doc.deleteIn(["models", "use", use]);
    } else {
      if (typeof value !== "string") throw new Error(`${use}: モデル名（文字列）が必要です`);
      doc.setIn(["models", "use", use], value);
    }
  });
}
