import { existsSync, statSync } from "node:fs";
import { LIVE_ENV_VAR } from "../execution/guards.ts";

/**
 * Loads KEY=VALUE pairs from a git-ignored `.env` (Node's built-in parser).
 * Variables already set in the environment win. Two safety rules:
 * - warn when the file is readable by group/others (it holds API keys)
 * - the real-money switch is never taken from a file: it must be set explicitly per session
 */
export function loadDotEnv(path = ".env", env: NodeJS.ProcessEnv = process.env): { loaded: boolean; warnings: string[] } {
  const warnings: string[] = [];
  if (!existsSync(path)) return { loaded: false, warnings };
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    warnings.push(`${path} is readable by other users; run: chmod 600 ${path}`);
  }
  const liveBefore = env[LIVE_ENV_VAR];
  process.loadEnvFile(path);
  if (liveBefore === undefined && env[LIVE_ENV_VAR] !== undefined) {
    delete env[LIVE_ENV_VAR];
    warnings.push(`${LIVE_ENV_VAR} in ${path} is ignored — set it explicitly in the shell for the session that should trade real money`);
  }
  return { loaded: true, warnings };
}
