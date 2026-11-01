import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { builtinRegistry, loadConfig, loadDotEnv, Services, SettingsStore } from "@stockai/core";

const dotenv = loadDotEnv();
for (const w of dotenv.warnings) console.error(`warning: ${w}`);
import { createApp } from "./app.ts";

const { values: opt } = parseArgs({
  options: {
    config: { type: "string" },
    fake: { type: "boolean", default: false },
    host: { type: "string", default: "127.0.0.1" },
    port: { type: "string", default: "4317" },
    workflows: { type: "string", default: "workflows" },
    "no-schedule": { type: "boolean", default: false },
    "no-mcp": { type: "boolean", default: false },
    "mcp-read-only": { type: "boolean", default: false },
  },
});

let configPath = opt.config ?? "config/config.yaml";
if (!opt.config && !existsSync(configPath)) {
  configPath = "config/config.example.yaml";
  console.error(`(using ${configPath}; copy it to config/config.yaml to customise)`);
}
const token = process.env["STOCKAI_WEB_TOKEN"] || undefined;
if (opt.host !== "127.0.0.1" && opt.host !== "localhost" && !token) {
  console.error("refusing to listen on a non-local address without STOCKAI_WEB_TOKEN (approvals can send orders)");
  process.exit(1);
}

const config = loadConfig(configPath);
// API keys entered on the settings screen (shell > settings > .env); changes apply without a restart.
const settings = new SettingsStore({ path: join(config.dataDir, "settings.sqlite"), shellKeys: dotenv.shellKeys });
const services = new Services(config, { fake: opt.fake, settings });
const app = createApp({
  services, registry: builtinRegistry(), workflowsDir: opt.workflows, configPath,
  staticDir: join(import.meta.dirname, "..", "dist"),
  ...(token ? { token } : {}),
  schedule: !opt["no-schedule"],
  mcp: opt["no-mcp"] ? false : { readOnly: opt["mcp-read-only"] },
});
app.server.listen(Number(opt.port), opt.host, () => {
  const sched = app.scheduler.status();
  console.log(`stockai web  http://${opt.host}:${opt.port}${opt.fake ? "  [FAKE models]" : ""}`);
  if (!opt["no-mcp"]) console.log(`  MCP          http://${opt.host}:${opt.port}/mcp${opt["mcp-read-only"] ? "  (read-only)" : ""}`);
  console.log(sched.length ? sched.map((x) => `  schedule ${x.at} ${x.workflow} next ${x.nextAt ?? "—"}`).join("\n") : "  no schedule (config.schedule)");
});
const stop = () => void app.close().then(() => process.exit(0));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
