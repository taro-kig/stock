/**
 * stockai as an MCP server over stdio (Claude Desktop, Claude Code, …).
 *
 *   node --disable-warning=ExperimentalWarning <repo>/apps/web/server/mcp-stdio.ts [--config PATH] [--read-only] [--fake]
 *
 * stdout carries the protocol: everything else must go to stderr.
 * Runs execute inside this process (one at a time); no schedule. If the web server is
 * running, prefer its /mcp endpoint so both share one run queue.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { builtinRegistry, loadConfig, loadDotEnv, Services, SettingsStore } from "@stockai/core";
import { createApp } from "./app.ts";
import { buildMcpServer } from "./mcp.ts";

const { values: opt } = parseArgs({
  options: {
    config: { type: "string" },
    root: { type: "string" },
    workflows: { type: "string", default: "workflows" },
    "read-only": { type: "boolean", default: false },
    fake: { type: "boolean", default: false },
  },
});

// MCP clients start servers from their own working directory: work from the repository.
process.chdir(opt.root ?? resolve(import.meta.dirname, "../../.."));

const dotenv = loadDotEnv();
for (const w of dotenv.warnings) console.error(`warning: ${w}`);
let configPath = opt.config ?? "config/config.yaml";
if (!opt.config && !existsSync(configPath)) configPath = "config/config.example.yaml";
const config = loadConfig(configPath);
const settings = new SettingsStore({ path: join(config.dataDir, "settings.sqlite"), shellKeys: dotenv.shellKeys });
const services = new Services(config, { fake: opt.fake, settings, configPath });
const registry = builtinRegistry();
const app = createApp({ services, registry, workflowsDir: opt.workflows, configPath, schedule: false, mcp: false }); // not listening: only its queue and helpers

const server = buildMcpServer({ app, services, registry, readOnly: opt["read-only"] });
await server.connect(new StdioServerTransport());
console.error(`stockai MCP (stdio) ready · config ${configPath}${opt["read-only"] ? " · read-only" : ""}${opt.fake ? " · FAKE models" : ""}`);

const stop = async () => {
  await app.queue.idle().catch(() => undefined);
  await server.close();
  process.exit(0);
};
process.stdin.on("close", () => void stop());
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
