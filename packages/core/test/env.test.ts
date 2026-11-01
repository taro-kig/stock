import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LIVE_ENV_VALUE, LIVE_ENV_VAR } from "../src/execution/guards.ts";
import { loadDotEnv } from "../src/util/env.ts";

describe("loadDotEnv", () => {
  const file = (text: string, mode = 0o600) => {
    const p = join(mkdtempSync(join(tmpdir(), "env-")), ".env");
    writeFileSync(p, text);
    chmodSync(p, mode);
    return p;
  };

  it("loads keys, keeps shell values, never takes the live-trading switch from a file", () => {
    process.env["STOCKAI_T_KEEP"] = "shell";
    delete process.env["STOCKAI_T_NEW"];
    delete process.env[LIVE_ENV_VAR];
    const r = loadDotEnv(file(`STOCKAI_T_NEW=fromfile\nSTOCKAI_T_KEEP=file\n${LIVE_ENV_VAR}=${LIVE_ENV_VALUE}\n`));
    expect(r.loaded).toBe(true);
    expect(process.env["STOCKAI_T_NEW"]).toBe("fromfile");
    expect(process.env["STOCKAI_T_KEEP"]).toBe("shell");
    expect(process.env[LIVE_ENV_VAR]).toBeUndefined();
    expect(r.warnings.join()).toMatch(/is ignored/);
  });

  it("warns about loose permissions and tolerates a missing file", () => {
    expect(loadDotEnv(file("A_B_C=1\n", 0o644)).warnings.join()).toMatch(/chmod 600/);
    expect(loadDotEnv("/nonexistent/.env")).toEqual({ loaded: false, warnings: [] });
  });
});
