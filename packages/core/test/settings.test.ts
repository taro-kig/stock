import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppConfig } from "../src/config.ts";
import { Services } from "../src/services.ts";
import { settingDefs, SettingsStore } from "../src/util/settings.ts";

const tmp = () => join(mkdtempSync(join(tmpdir(), "settings-")), "settings.sqlite");

describe("SettingsStore", () => {
  it("persists values in a 600 file and applies them to the environment", () => {
    const path = tmp();
    const env: NodeJS.ProcessEnv = {};
    const a = new SettingsStore({ path, env, shellKeys: new Set() });
    a.set("GEMINI_API_KEY", "  AIza-test-key-0000000000wxyz \n".replace("\n", ""));
    expect(env["GEMINI_API_KEY"]).toBe("AIza-test-key-0000000000wxyz");
    a.close();
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const env2: NodeJS.ProcessEnv = {};
    new SettingsStore({ path, env: env2, shellKeys: new Set() });
    expect(env2["GEMINI_API_KEY"]).toBe("AIza-test-key-0000000000wxyz");
  });

  it("shell > settings > .env, and clearing restores the .env value", () => {
    const env: NodeJS.ProcessEnv = { FROM_SHELL: "s", DEEPSEEK_API_KEY: "from-dotenv" };
    const st = new SettingsStore({ path: ":memory:", env, shellKeys: new Set(["FROM_SHELL", "GEMINI_API_KEY"]) });
    st.set("DEEPSEEK_API_KEY", "from-settings-123456");
    expect(env["DEEPSEEK_API_KEY"]).toBe("from-settings-123456");
    expect(() => st.set("FROM_SHELL", "x")).toThrow(/shell/);
    st.clear("DEEPSEEK_API_KEY");
    expect(env["DEEPSEEK_API_KEY"]).toBe("from-dotenv");
    const status = st.status(settingDefs()).find((x) => x.name === "DEEPSEEK_API_KEY")!;
    expect(status.source).toBe("dotenv");
  });

  it("never stores STOCKAI_ variables or multi-line values, and never echoes secrets", () => {
    const env: NodeJS.ProcessEnv = {};
    const st = new SettingsStore({ path: ":memory:", env, shellKeys: new Set() });
    expect(() => st.set("STOCKAI_LIVE_TRADING", "yes-i-understand")).toThrow(/cannot be stored/);
    expect(() => st.set("bad name", "x")).toThrow(/invalid/);
    expect(() => st.set("GEMINI_API_KEY", "a\nb")).toThrow(/single line/);
    st.set("TWELVEDATA_API_KEY", "abcdefghijklmnop1234");
    st.set("SEC_USER_AGENT", "stockai me@example.com");
    st.set("WEBULL_APP_SECRET", "short");
    const by = Object.fromEntries(st.status(settingDefs()).map((x) => [x.name, x]));
    expect(by["TWELVEDATA_API_KEY"]!.preview).toBe("…1234");
    expect(by["WEBULL_APP_SECRET"]!.preview).toBe("（設定済み）");
    expect(by["SEC_USER_AGENT"]!.preview).toBe("stockai me@example.com");
    expect(JSON.stringify(st.status(settingDefs()))).not.toContain("abcdefghijklmnop");
  });

  it("lists key variables the config refers to", () => {
    const cfg = AppConfig.parse({ watchlist: {}, models: { tier1: [{ name: "x", provider: "openai_compat", baseUrl: "https://example.com/v1", model: "m", apiKeyEnv: "GROQ_API_KEY" }] } });
    const d = settingDefs(cfg).find((x) => x.name === "GROQ_API_KEY");
    expect(d).toMatchObject({ group: "other", secret: true, usedByConfig: true });
  });

  it("Services rebuild API clients after a key changes", () => {
    const env: NodeJS.ProcessEnv = {};
    const settings = new SettingsStore({ path: ":memory:", env, shellKeys: new Set() });
    settings.set("GEMINI_API_KEY", "old-key-0123456789");
    const cfg = AppConfig.parse({ watchlist: {}, models: { tier1: [{ name: "g", provider: "gemini", model: "gemini-2.5-flash-lite", apiKeyEnv: "GEMINI_API_KEY" }], tier2: { name: "g2", provider: "gemini", model: "gemini-2.5-flash", apiKeyEnv: "GEMINI_API_KEY" } } });
    const s = new Services(cfg, { dbPath: ":memory:", env, settings });
    const before = s.tier1();
    settings.set("GEMINI_API_KEY", "new-key-0123456789");
    expect(s.tier1()).not.toBe(before);
  });
});
