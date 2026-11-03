import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { JUDGE_PROMPTS, RED_TEAM_PROMPTS, type DossierVariant } from "../ai/prompts.ts";
import type { Document } from "../signals/models.ts";
import { EVENT_PROMPTS } from "../signals/prompts.ts";
import { UNIVERSE_PROMPTS } from "../universe/suggest.ts";

/**
 * All prompt versions: built-ins (in code, read-only) and user versions written from the
 * UI to prompts/<family>/<version>.md (front matter + the instruction text, so they diff
 * nicely in Git). A version is never edited after it is created: results, caches and
 * graded judgments are attributed to the version name, so changing text under the same
 * name would make them meaningless. "Editing" creates a new version.
 *
 * Only the instruction text (system prompt) is editable. The input format (document
 * template, dossier layout) and the output schema are code, inherited from the built-in
 * the version descends from.
 */
export const PROMPT_FAMILIES = ["event", "judge", "redteam", "universe"] as const;
export type PromptFamily = (typeof PROMPT_FAMILIES)[number];

export const FAMILY_LABELS: Record<PromptFamily, string> = {
  event: "イベント抽出",
  judge: "売買判断",
  redteam: "反対役（拒否権）",
  universe: "銘柄探し",
};

const BUILTIN_NOTES: Record<string, string> = {
  "event-v1": "規則5つのみ（日本株）",
  "event-v2": "判定基準・日本の適時開示の読み方・例3件（日本株）",
  "event-us-v1": "米国株: 英語の 8-K・ニュース、Item の読み方、コンセンサス比とガイダンス",
  "judge-v1": "4区分の定義、チェック項目、根拠・撤回条件",
  "judge-v2": "基準率・確認の順序・確信度の目安。資料に20日リターンと52週高値からの位置を追加",
  "redteam-v1": "重大な理由を資料から探す",
  "redteam-v2": "確認する観点の一覧と重大度の基準",
  "universe-v1": "テーマに合う NYSE / Nasdaq の米国株を理由つきで挙げる",
  "universe-jp-v1": "テーマに合う東証（プライム・スタンダード・グロース）の日本株を理由つきで挙げる",
};

export interface PromptInfo {
  family: PromptFamily;
  version: string;
  builtin: boolean;
  /** The version this one was derived from (null for built-ins). */
  parent: string | null;
  /** The built-in at the root of the chain: decides the input format. */
  base: string;
  description: string;
  createdAt: string | null;
  system: string;
  file: string | null;
}

export interface EventPromptDef {
  version: string;
  system: string;
  user(doc: Document, candidates: Record<string, string>): string;
}
export interface JudgePromptDef {
  version: string;
  system: string;
  dossier: DossierVariant;
}
export interface SystemPromptDef {
  version: string;
  system: string;
}

export class UnknownPrompt extends Error {
  override name = "UnknownPrompt";
}

const BUILTINS: Record<PromptFamily, Record<string, { system: string }>> = {
  event: EVENT_PROMPTS,
  judge: JUDGE_PROMPTS,
  redteam: RED_TEAM_PROMPTS,
  universe: UNIVERSE_PROMPTS,
};

/** User version names: "<family>-<something>", e.g. event-us-v1-ja2. */
export function validVersionName(family: PromptFamily, version: string): boolean {
  return new RegExp(`^${family}-[a-z0-9][a-z0-9.-]{0,47}$`).test(version);
}

interface FrontMatter {
  parent?: string;
  description?: string;
  createdAt?: string;
}

function splitFrontMatter(text: string): { meta: FrontMatter; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  return { meta: (parseYaml(m[1]!) ?? {}) as FrontMatter, body: m[2]! };
}

export class PromptRegistry {
  readonly dir: string;

  constructor(dir = "prompts") {
    this.dir = dir;
  }

  #userFiles(family: PromptFamily): PromptInfo[] {
    const d = join(this.dir, family);
    if (!existsSync(d)) return [];
    const out: PromptInfo[] = [];
    for (const f of readdirSync(d).filter((x) => x.endsWith(".md")).sort()) {
      const version = f.slice(0, -3);
      if (!validVersionName(family, version) || version in BUILTINS[family]) continue;
      const { meta, body } = splitFrontMatter(readFileSync(join(d, f), "utf8"));
      out.push({
        family, version, builtin: false, parent: meta.parent ?? null, base: "", description: meta.description ?? "",
        createdAt: meta.createdAt ?? null, system: body.trim(), file: join(d, f),
      });
    }
    return out;
  }

  list(family?: PromptFamily): PromptInfo[] {
    const fams = family ? [family] : [...PROMPT_FAMILIES];
    const out: PromptInfo[] = [];
    for (const fam of fams) {
      const builtins = Object.entries(BUILTINS[fam]).map(([version, p]) => ({
        family: fam, version, builtin: true, parent: null, base: version, description: BUILTIN_NOTES[version] ?? "",
        createdAt: null, system: p.system, file: null,
      }));
      const users = this.#userFiles(fam);
      const all = [...builtins, ...users];
      const byName = new Map(all.map((p) => [p.version, p]));
      // resolve each user version's built-in root (and drop broken chains)
      for (const u of users) {
        const seen = new Set<string>();
        let cur: PromptInfo | undefined = u;
        while (cur && !cur.builtin && cur.parent && !seen.has(cur.version)) {
          seen.add(cur.version);
          cur = byName.get(cur.parent);
        }
        u.base = cur?.builtin ? cur.version : "";
      }
      out.push(...builtins, ...users.filter((u) => u.base).sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")));
    }
    return out;
  }

  info(family: PromptFamily, version: string): PromptInfo {
    const p = this.list(family).find((x) => x.version === version);
    if (!p) throw new UnknownPrompt(`unknown ${family} prompt version "${version}" (have: ${this.list(family).map((x) => x.version).join(", ")})`);
    return p;
  }

  event(version: string): EventPromptDef {
    const p = this.info("event", version);
    const base = EVENT_PROMPTS[p.base as keyof typeof EVENT_PROMPTS];
    return { version, system: p.system, user: base.user };
  }

  judge(version: string): JudgePromptDef {
    const p = this.info("judge", version);
    return { version, system: p.system, dossier: JUDGE_PROMPTS[p.base as keyof typeof JUDGE_PROMPTS].dossier };
  }

  redTeam(version: string): SystemPromptDef {
    return { version, system: this.info("redteam", version).system };
  }

  universe(version: string): SystemPromptDef {
    return { version, system: this.info("universe", version).system };
  }

  /** Writes a new user version derived from `parent`. Refuses existing names. */
  create(family: PromptFamily, v: { version: string; parent: string; system: string; description?: string }, now: Date = new Date()): PromptInfo {
    if (!validVersionName(family, v.version)) throw new Error(`version name must look like "${family}-…" (lower case letters, digits, '.', '-')`);
    if (this.list(family).some((x) => x.version === v.version)) throw new Error(`${v.version} already exists: versions are never overwritten, pick a new name`);
    this.info(family, v.parent); // parent must exist
    const system = v.system.replace(/\r\n/g, "\n").trim();
    if (system.length < 20) throw new Error("the prompt text is too short");
    if (system.length > 30_000) throw new Error("the prompt text is too long (30,000 characters max)");
    const d = join(this.dir, family);
    mkdirSync(d, { recursive: true });
    const meta = stringifyYaml({ parent: v.parent, description: (v.description ?? "").slice(0, 300), createdAt: now.toISOString() }).trim();
    writeFileSync(join(d, `${v.version}.md`), `---\n${meta}\n---\n${system}\n`, { encoding: "utf8", flag: "wx" });
    return this.info(family, v.version);
  }
}
