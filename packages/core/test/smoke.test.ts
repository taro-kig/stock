import { describe, expect, it } from "vitest";
import { redactText, smokeMarkdown } from "../src/smoke.ts";

describe("smoke report", () => {
  it("masks keys, e-mail addresses, keys in URLs, webhooks and the home folder", () => {
    const t = redactText(
      "key sk-abc123456 user stockai me@example.com url https://x.com/q?apikey=ZZZ&a=1 hook https://discord.com/api/webhooks/1/tok file /home/taro/stock/data",
      ["sk-abc123456"], "/home/taro",
    );
    expect(t).toBe("key *** user stockai <email> url https://x.com/q?apikey=***&a=1 hook https://discord.com/api/webhooks/*** file ~/stock/data");
  });

  it("renders steps with status marks and errors", () => {
    const md = smokeMarkdown({ at: "2026-11-03T06:42:00.000Z", env: ["Node v22"], steps: [
      { name: "接続チェック", status: "ok", ms: 1200, lines: ["✓ a"] },
      { name: "ワークフロー", status: "fail", ms: 3000, lines: [], error: "boom" },
    ] });
    expect(md).toContain("| ✓ | 接続チェック | 1.2 秒 |");
    expect(md).toContain("## ✕ ワークフロー\n\nエラー: boom");
  });
});
