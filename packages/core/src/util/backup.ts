import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config.ts";
import type { Db } from "./db.ts";
import type { SettingsStore } from "./settings.ts";

/**
 * Daily copies of the database. `VACUUM INTO` writes a consistent snapshot while the
 * server keeps running (no need to stop it). Files: <dir>/stockai-YYYYMMDD-HHMMSS.sqlite,
 * plus settings-….sqlite when includeSettings is on.
 */
export type BackupConfig = AppConfig["backup"];

export interface BackupFile {
  file: string;
  name: string;
  /** Local date-time encoded in the name. */
  at: string;
  size: number;
}

export interface BackupStatus {
  enabled: boolean;
  dir: string;
  at: string;
  includeSettings: boolean;
  keepDaily: number;
  keepMonthly: number;
  last: BackupFile | null;
  count: number;
  /** A backup for today's (local) date exists. */
  doneToday: boolean;
}

const NAME = /^stockai-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.sqlite$/;
const pad = (n: number) => String(n).padStart(2, "0");
const stamp = (d: Date) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const localDay = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function backupDir(config: AppConfig): string {
  return config.backup.dir ?? join(config.dataDir, "backups");
}

export function listBackups(dir: string): BackupFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => ({ name, m: NAME.exec(name) }))
    .filter((x): x is { name: string; m: RegExpExecArray } => x.m !== null)
    .map(({ name, m }) => ({ file: join(dir, name), name, at: `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`, size: statSync(join(dir, name)).size }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Which backups to keep: the newest of each of the last `keepDaily` days and of the last `keepMonthly` months. */
export function selectKept(files: readonly BackupFile[], keepDaily: number, keepMonthly: number): Set<string> {
  const newestFirst = [...files].sort((a, b) => b.at.localeCompare(a.at));
  const keep = new Set<string>();
  const days = new Set<string>();
  const months = new Set<string>();
  for (const f of newestFirst) {
    const day = f.at.slice(0, 10);
    const month = f.at.slice(0, 7);
    if (!days.has(day) && days.size < keepDaily) {
      days.add(day);
      keep.add(f.name);
    }
    if (!months.has(month) && months.size < keepMonthly) {
      months.add(month);
      keep.add(f.name);
    }
  }
  return keep;
}

export function backupStatus(config: AppConfig, now: Date = new Date()): BackupStatus {
  const dir = backupDir(config);
  const files = listBackups(dir);
  const last = files.at(-1) ?? null;
  return {
    enabled: config.backup.enabled, dir, at: config.backup.at, includeSettings: config.backup.includeSettings,
    keepDaily: config.backup.keepDaily, keepMonthly: config.backup.keepMonthly,
    last, count: files.length, doneToday: last !== null && last.at.slice(0, 10) === localDay(now),
  };
}

/** True when the daily backup is due: enabled, past `at` (local time) and none yet today. */
export function backupDue(config: AppConfig, now: Date = new Date()): boolean {
  if (!config.backup.enabled) return false;
  const [h, m] = config.backup.at.split(":").map(Number) as [number, number];
  if (now.getHours() * 60 + now.getMinutes() < h * 60 + m) return false;
  return !backupStatus(config, now).doneToday;
}

/** Writes a snapshot now and prunes old copies. Returns the new file. */
export function runBackup(config: AppConfig, db: Db, settings?: SettingsStore, now: Date = new Date()): BackupFile {
  const dir = backupDir(config);
  mkdirSync(dir, { recursive: true });
  const name = `stockai-${stamp(now)}.sqlite`;
  const file = join(dir, name);
  if (existsSync(file)) throw new Error(`${file} already exists`);
  db.prepare("VACUUM INTO ?").run(file);
  if (process.platform !== "win32") chmodSync(file, 0o600);
  if (config.backup.includeSettings && settings) {
    const sf = join(dir, `settings-${stamp(now)}.sqlite`);
    settings.backupTo(sf);
    if (process.platform !== "win32") chmodSync(sf, 0o600);
  }
  const all = listBackups(dir);
  const keep = selectKept(all, config.backup.keepDaily, config.backup.keepMonthly);
  for (const f of all) {
    if (keep.has(f.name)) continue;
    unlinkSync(f.file);
    const s = join(dir, f.name.replace(/^stockai-/, "settings-"));
    if (existsSync(s)) unlinkSync(s);
  }
  return all.find((f) => f.name === name)!;
}
