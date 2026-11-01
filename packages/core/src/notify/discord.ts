/**
 * Discord incoming webhooks (https://discord.com/developers/docs/resources/webhook#execute-webhook).
 * Messages can carry text that came from news or model output, so mentions are always
 * disabled (`allowed_mentions: { parse: [] }`): an article cannot ping @everyone.
 */
export interface NoticeField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface Notice {
  title: string;
  description?: string;
  url?: string;
  /** "ok" green · "warn" amber · "fail" red · "info" blue */
  tone?: "ok" | "warn" | "fail" | "info";
  fields?: NoticeField[];
  timestamp?: string;
}

const COLORS = { ok: 0x7fd18b, warn: 0xffb547, fail: 0xff5f7e, info: 0x8fb8ff } as const;

const WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export function isDiscordWebhookUrl(url: string): boolean {
  return WEBHOOK.test(url.trim());
}

const cut = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Builds the webhook body within Discord's limits (title 256, description 4096, 25 fields of 1024, 6000 in total). */
export function discordPayload(n: Notice): Record<string, unknown> {
  let budget = 5800;
  const take = (s: string, n: number) => {
    const v = cut(s, Math.max(0, Math.min(n, budget)));
    budget -= v.length;
    return v;
  };
  const title = take(n.title, 256);
  const description = n.description ? take(n.description, 2000) : undefined;
  const fields: NoticeField[] = [];
  for (const f of (n.fields ?? []).slice(0, 25)) {
    if (budget < 80) break;
    const name = take(f.name || "-", 256);
    const value = take(f.value || "-", 1024);
    fields.push({ name, value, ...(f.inline ? { inline: true } : {}) });
  }
  return {
    username: "stockai",
    allowed_mentions: { parse: [] },
    embeds: [{
      title, ...(description ? { description } : {}), ...(n.url ? { url: n.url } : {}),
      color: COLORS[n.tone ?? "info"], ...(fields.length ? { fields } : {}), ...(n.timestamp ? { timestamp: n.timestamp } : {}),
    }],
  };
}

export interface DiscordOptions {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Sends one notice. Throws with a message that never contains the webhook URL (it is a secret). */
export async function sendDiscord(webhookUrl: string, n: Notice, o: DiscordOptions = {}): Promise<void> {
  if (!isDiscordWebhookUrl(webhookUrl)) throw new Error("DISCORD_WEBHOOK_URL is not a Discord webhook URL (https://discord.com/api/webhooks/…)");
  const fetchImpl = o.fetchImpl ?? ((i, init) => fetch(i, init));
  const sleep = o.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const body = JSON.stringify(discordPayload(n));
  for (let attempt = 0; attempt < 2; attempt++) {
    let res: Response;
    try {
      res = await fetchImpl(webhookUrl.trim(), { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
      throw new Error(`cannot reach Discord: ${e instanceof Error ? e.message : String(e)}${cause}`);
    }
    if (res.ok) return;
    if (res.status === 429 && attempt === 0) {
      const retry = Number(((await res.json().catch(() => ({}))) as { retry_after?: number }).retry_after ?? 2);
      await sleep(Math.min(10, Math.max(0.5, retry)) * 1000);
      continue;
    }
    const text = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`Discord answered HTTP ${res.status}${res.status === 401 || res.status === 404 ? " (the webhook was deleted or the URL is wrong)" : ""}${text ? `: ${text}` : ""}`);
  }
  throw new Error("Discord rate limit: try again later");
}
