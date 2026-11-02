import { explicitModelNames } from "../llm/roles.ts";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../config.ts";
import { isDiscordWebhookUrl } from "../notify/discord.ts";

/**
 * API keys and other per-machine settings entered in the web UI, kept in their own
 * SQLite file (`<dataDir>/settings.sqlite`, permission 600).
 *
 * Precedence: a variable exported in the shell > the settings file > `.env`.
 * Values are stored as plain text, like `.env`: protect the file, never commit or share
 * the data directory. Variables starting with STOCKAI_ (the real-money switch, the web
 * token) can never be stored here.
 */
export interface SettingDef {
  name: string;
  label: string;
  /** Secrets are never sent back to the browser (only whether they are set). */
  secret: boolean;
  help: string;
  url?: string;
  group: "llm" | "data" | "broker" | "notify" | "other";
  /** Referenced by the loaded config (model / broker key variables). */
  usedByConfig?: boolean;
}

export const KNOWN_SETTINGS: readonly SettingDef[] = [
  { name: "GEMINI_API_KEY", label: "Gemini API key", secret: true, group: "llm", help: "イベント抽出・判断（Gemini Flash-Lite / Flash）", url: "https://aistudio.google.com/apikey" },
  { name: "DEEPSEEK_API_KEY", label: "DeepSeek API key", secret: true, group: "llm", help: "多数決の2つ目（別ベンダー）", url: "https://platform.deepseek.com/api_keys" },
  { name: "OPENROUTER_API_KEY", label: "OpenRouter API key", secret: true, group: "llm", help: "別ベンダーを試す場合", url: "https://openrouter.ai/keys" },
  { name: "OPENAI_API_KEY", label: "OpenAI API key", secret: true, group: "llm", help: "別ベンダーを試す場合", url: "https://platform.openai.com/api-keys" },
  { name: "JQUANTS_API_KEY", label: "J-Quants API key", secret: true, group: "data", help: "日本株の日足（data.pricesJQuants）。Free プランは直近12週間が無いので日次運用には Light 以上", url: "https://jpx-jquants.com/" },
  { name: "TWELVEDATA_API_KEY", label: "Twelve Data API key", secret: true, group: "data", help: "米国株の日足（無料: 800 回/日, 8 回/分）", url: "https://twelvedata.com/pricing" },
  { name: "ALPHAVANTAGE_API_KEY", label: "Alpha Vantage API key", secret: true, group: "data", help: "米国株の決算予定・決算実績・アナリスト予想。無料: 25 回/日。予定は1日1回、実績は決算直後の銘柄だけ（最大5件）、予想は1銘柄週1回（最大4件）", url: "https://www.alphavantage.co/support/#api-key" },
  { name: "SEC_USER_AGENT", label: "SEC User-Agent", secret: false, group: "data", help: "SEC EDGAR の利用条件で必須。名前と連絡先メール（例: stockai taro@example.com）", url: "https://www.sec.gov/os/accessing-edgar-data" },
  { name: "DISCORD_WEBHOOK_URL", label: "Discord Webhook URL", secret: true, group: "notify", help: "承認待ち・失敗・発注・バックアップ失敗を通知。Discord のチャンネル設定 → 連携サービス → ウェブフック → URL をコピー", url: "https://support.discord.com/hc/ja/articles/228383668" },
  { name: "WEBULL_APP_KEY", label: "Webull App Key", secret: true, group: "broker", help: "ウィブル証券（docs/webull.md）", url: "https://developer.webull.co.jp/" },
  { name: "WEBULL_APP_SECRET", label: "Webull App Secret", secret: true, group: "broker", help: "ウィブル証券（docs/webull.md）", url: "https://developer.webull.co.jp/" },
];

const NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

/** Checks for values whose shape is known, so typos fail when saving instead of at 6 a.m. */
const VALIDATORS: Record<string, (v: string) => string | null> = {
  DISCORD_WEBHOOK_URL: (v) => (isDiscordWebhookUrl(v) ? null : "Discord のウェブフック URL ではありません（https://discord.com/api/webhooks/… の形）"),
  SEC_USER_AGENT: (v) => (/@/.test(v) ? null : "連絡先メールを含めてください（例: stockai you@example.com）"),
};

export function assertSettingName(name: string): void {
  if (!NAME.test(name)) throw new Error(`invalid setting name ${JSON.stringify(name)} (A-Z, 0-9, _)`);
  if (name.startsWith("STOCKAI_")) throw new Error(`${name} cannot be stored in settings (set it in the shell for the session that needs it)`);
}

/** Known settings plus every *_ENV variable the config refers to (custom model keys etc.). */
export function settingDefs(config?: AppConfig): SettingDef[] {
  const defs = new Map(KNOWN_SETTINGS.map((d) => [d.name, d]));
  const referenced: string[] = [];
  if (config) {
    // With "auto", any registered model may be chosen once its key is set.
    const m = config.models;
    const anyAuto = m ? Object.values(m.use).some((v) => v === "auto") : false;
    const used = m ? explicitModelNames(m) : [];
    const models = (m?.pool ?? []).filter((x) => anyAuto || used.includes(x.name));
    for (const m of models) if ("apiKeyEnv" in m && typeof m.apiKeyEnv === "string") referenced.push(m.apiKeyEnv);
    if (config.webull) referenced.push(config.webull.appKeyEnv, config.webull.appSecretEnv);
  }
  for (const n of referenced) {
    if (!NAME.test(n) || n.startsWith("STOCKAI_")) continue;
    const d = defs.get(n);
    defs.set(n, d ? { ...d, usedByConfig: true } : { name: n, label: n, secret: true, group: "other", help: "config.yaml が参照しているキー", usedByConfig: true });
  }
  return [...defs.values()];
}

export type SettingSource = "shell" | "settings" | "dotenv" | null;

export interface SettingStatus extends SettingDef {
  set: boolean;
  source: SettingSource;
  /** Non-secret values in full; secrets only as "…abcd" (last 4) when long enough. */
  preview: string | null;
  updatedAt: string | null;
}

export interface SettingsOptions {
  path: string;
  /** The live environment the rest of the program reads (process.env). */
  env?: NodeJS.ProcessEnv;
  /** Names exported in the shell before `.env` was loaded: these always win. */
  shellKeys?: ReadonlySet<string>;
}

export class SettingsStore {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #env: NodeJS.ProcessEnv;
  readonly #shell: ReadonlySet<string>;
  /** Values `.env` provided, to restore when a stored setting is cleared. */
  readonly #dotenv = new Map<string, string>();
  readonly #listeners = new Set<(name: string) => void>();

  constructor(o: SettingsOptions) {
    this.path = o.path;
    this.#env = o.env ?? process.env;
    this.#shell = o.shellKeys ?? new Set(Object.keys(this.#env));
    for (const [k, v] of Object.entries(this.#env)) if (!this.#shell.has(k) && v !== undefined) this.#dotenv.set(k, v);
    if (o.path !== ":memory:") {
      mkdirSync(dirname(o.path), { recursive: true });
      // Create the file 600 *before* SQLite opens it; SQLite gives its journal the same mode.
      if (!existsSync(o.path)) writeFileSync(o.path, "", { mode: 0o600 });
      if (process.platform !== "win32") chmodSync(o.path, 0o600);
    }
    this.#db = new DatabaseSync(o.path);
    this.#db.exec("PRAGMA journal_mode = DELETE; PRAGMA busy_timeout = 5000;");
    this.#db.exec("CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)");
    for (const r of this.#rows()) this.#applyOne(r.name, r.value);
  }

  #rows(): Array<{ name: string; value: string; updated_at: string }> {
    return this.#db.prepare("SELECT name, value, updated_at FROM settings ORDER BY name").all() as Array<{ name: string; value: string; updated_at: string }>;
  }

  #applyOne(name: string, value: string): void {
    if (this.#shell.has(name) || name.startsWith("STOCKAI_")) return;
    this.#env[name] = value;
  }

  /** Called with the setting name after every change (e.g. to drop cached API clients). */
  onChange(fn: (name: string) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  source(name: string, stored: boolean): SettingSource {
    if (this.#shell.has(name) && this.#env[name] !== undefined) return "shell";
    if (stored) return "settings";
    if (this.#env[name] !== undefined && this.#env[name] !== "") return "dotenv";
    return null;
  }

  status(defs: readonly SettingDef[]): SettingStatus[] {
    const rows = new Map(this.#rows().map((r) => [r.name, r]));
    return defs.map((d) => {
      const row = rows.get(d.name);
      const source = this.source(d.name, row !== undefined);
      const value = this.#env[d.name];
      const has = value !== undefined && value !== "";
      const preview = !has ? null : !d.secret ? value : value.length >= 16 ? `…${value.slice(-4)}` : "（設定済み）";
      return { ...d, set: has, source, preview, updatedAt: row?.updated_at ?? null };
    });
  }

  set(name: string, value: string): void {
    assertSettingName(name);
    const v = value.trim();
    if (!v) throw new Error("empty value (use clear to remove a setting)");
    if (v.length > 4096 || /[\r\n\0]/.test(v)) throw new Error("value must be a single line of at most 4096 characters");
    if (this.#shell.has(name)) throw new Error(`${name} is set in the shell environment, which takes precedence; unset it there first`);
    const invalid = VALIDATORS[name]?.(v);
    if (invalid) throw new Error(invalid);
    this.#db.prepare("INSERT OR REPLACE INTO settings VALUES (?,?,?)").run(name, v, new Date().toISOString());
    this.#applyOne(name, v);
    for (const l of this.#listeners) l(name);
  }

  clear(name: string): void {
    assertSettingName(name);
    this.#db.prepare("DELETE FROM settings WHERE name = ?").run(name);
    if (!this.#shell.has(name)) {
      const fallback = this.#dotenv.get(name);
      if (fallback !== undefined) this.#env[name] = fallback;
      else delete this.#env[name];
    }
    for (const l of this.#listeners) l(name);
  }

  /** Consistent copy of the settings file (used by backups when includeSettings is on). */
  backupTo(path: string): void {
    this.#db.prepare("VACUUM INTO ?").run(path);
  }

  close(): void {
    this.#db.close();
  }
}
