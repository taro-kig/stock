import { useEffect, useMemo, useState } from "react";
import type { AvailableModel, ModelList, ModelSpec, VendorId } from "@stockai/core";
import type { ModelsView } from "../../shared/types.ts";
import { get, post, put, useApi } from "../api.ts";
import { Empty, ErrorLine, Kbd, Pane } from "../components/ui.tsx";

type Toast = (m: string, err?: boolean) => void;
type Role = "tier1" | "tier2" | "redTeam";
type TestResult = { status: "ok" | "warn" | "fail" | "skip" | "busy"; detail: string; hint?: string };

interface Row {
  key: number;
  role: Role;
  vendor: VendorId;
  model: string;
  /** Config name: kept for existing members, derived from the model id for new / changed ones. */
  name: string;
  baseUrl: string;
  apiKeyEnv: string;
  priceIn: string;
  priceOut: string;
}

const ROLE: Record<Role, { label: string; help: string }> = {
  tier1: { label: "投票", help: "毎回呼ばれる。別ベンダーを混ぜると誤りが重なりにくい" },
  tier2: { label: "エスカレーション", help: "投票が割れ、しかも重要なときだけ呼ばれる" },
  redTeam: { label: "レッドチーム", help: "強気の結論に反論する役。未設定ならエスカレーション用を使う" },
};

const MARK: Record<TestResult["status"], [string, string]> = {
  ok: ["✓", "ok"], warn: ["!", "warn"], fail: ["✗", "fail"], skip: ["–", "faint"], busy: ["…", "dim"],
};

let nextKey = 1;
const slug = (model: string) =>
  (model.split("/").filter(Boolean).at(-1) ?? model).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "model";
const hostOf = (u: string | undefined) => {
  try {
    return u ? new URL(u).host : null;
  } catch {
    return null;
  }
};
const num = (x: number | undefined) => (x === undefined ? "" : String(x));

function vendorOf(spec: ModelSpec, vendors: ModelsView["vendors"]): VendorId {
  if (spec.provider === "gemini") return "gemini";
  const v = vendors.find((x) => x.id !== "custom" && x.baseUrl && hostOf(x.baseUrl) === hostOf(spec.baseUrl));
  return v?.id ?? "custom";
}

function toRows(d: ModelsView): Row[] {
  const one = (role: Role, s: ModelSpec): Row => ({
    key: nextKey++, role, vendor: vendorOf(s, d.vendors), model: s.model, name: s.name,
    baseUrl: s.provider === "openai_compat" ? s.baseUrl : "", apiKeyEnv: s.apiKeyEnv,
    priceIn: num(d.pricing[s.model]?.[0]), priceOut: num(d.pricing[s.model]?.[1]),
  });
  return [
    ...d.roles.tier1.map((s) => one("tier1", s)),
    ...(d.roles.tier2 ? [one("tier2", d.roles.tier2)] : []),
    ...(d.roles.redTeam ? [one("redTeam", d.roles.redTeam)] : []),
  ];
}

function specOf(r: Row, vendors: ModelsView["vendors"]): ModelSpec {
  const v = vendors.find((x) => x.id === r.vendor)!;
  const apiKeyEnv = r.vendor === "custom" ? r.apiKeyEnv.trim() : v.apiKeyEnv;
  if (v.provider === "gemini") return { provider: "gemini", name: r.name, model: r.model.trim(), apiKeyEnv };
  return { provider: "openai_compat", name: r.name, model: r.model.trim(), baseUrl: r.vendor === "custom" ? r.baseUrl.trim() : v.baseUrl!, apiKeyEnv };
}

function payload(rows: Row[], vendors: ModelsView["vendors"]) {
  const pick = (role: Role) => rows.filter((r) => r.role === role).map((r) => specOf(r, vendors));
  const pricing: Record<string, [number, number]> = {};
  for (const r of rows) {
    const a = Number(r.priceIn);
    const b = Number(r.priceOut);
    if (r.model.trim() && r.priceIn.trim() && r.priceOut.trim() && Number.isFinite(a) && Number.isFinite(b)) pricing[r.model.trim()] = [a, b];
  }
  return { tier1: pick("tier1"), tier2: pick("tier2")[0] ?? null, redTeam: pick("redTeam")[0] ?? null, pricing };
}

/** Lists of the models each vendor offers (fetched with the user's key; built-in list otherwise). */
type Want = { vendor: VendorId; baseUrl: string; apiKeyEnv: string; keySet: boolean | null };
function useModelLists(wanted: Want[]) {
  const [lists, setLists] = useState<Record<string, ModelList>>({});
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  // A key saved above changes what the vendor returns: refetch then.
  const keyOf = (w: Want) => (w.vendor === "custom" ? `custom|${w.baseUrl}|${w.apiKeyEnv}` : `${w.vendor}|${w.keySet}`);
  const load = async (w: Want, refresh = false) => {
    const k = keyOf(w);
    setLoading((l) => ({ ...l, [k]: true }));
    try {
      const q = new URLSearchParams(w.vendor === "custom" ? { baseUrl: w.baseUrl, apiKeyEnv: w.apiKeyEnv } : {});
      if (refresh) q.set("refresh", "1");
      const list = await get<ModelList>(`/api/models/available/${w.vendor}${q.size ? `?${q}` : ""}`);
      setLists((ls) => ({ ...ls, [k]: list }));
    } catch (e) {
      setLists((ls) => ({ ...ls, [k]: { vendor: w.vendor, models: [], source: "builtin", error: e instanceof Error ? e.message : String(e) } }));
    } finally {
      setLoading((l) => ({ ...l, [k]: false }));
    }
  };
  const sig = [...new Set(wanted.filter((w) => w.vendor !== "custom" || /^https?:\/\/.+/.test(w.baseUrl)).map((w) => JSON.stringify(w)))];
  useEffect(() => {
    for (const s of sig) {
      const w = JSON.parse(s) as Want;
      if (!(keyOf(w) in lists) && !loading[keyOf(w)]) void load(w);
    }
  }, [sig.join("\n")]);
  return { lists, loading, keyOf, refresh: (w: Want) => load(w, true) };
}

export function ModelsPane({ toast }: { toast: Toast }) {
  const { data, error, reload } = useApi<ModelsView>("/api/models");
  const [rows, setRows] = useState<Row[]>([]);
  const [base, setBase] = useState<string | null>(null);
  const [previous, setPrevious] = useState<ModelsView["roles"] | null>(null);
  const [tests, setTests] = useState<Record<number, TestResult>>({});
  const [busy, setBusy] = useState(false);
  const vendors = data?.vendors ?? [];
  const current = data ? JSON.stringify(payload(rows, vendors)) : "";
  const dirty = base !== null && current !== base;

  const load = (d: ModelsView) => {
    const r = toRows(d);
    setRows(r);
    setBase(JSON.stringify(payload(r, d.vendors)));
    setPrevious(d.roles);
    setTests({});
  };
  useEffect(() => {
    if (!data || dirty) return; // never clobber edits in progress
    load(data);
  }, [data]);

  const want = (r: Row): Want => r.vendor === "custom"
    ? { vendor: r.vendor, baseUrl: r.baseUrl.trim(), apiKeyEnv: r.apiKeyEnv.trim(), keySet: null }
    : { vendor: r.vendor, baseUrl: "", apiKeyEnv: "", keySet: vendors.find((v) => v.id === r.vendor)?.keySet ?? false };
  const { lists, loading, keyOf, refresh } = useModelLists(rows.map(want));
  const listFor = (r: Row) => lists[keyOf(want(r))];
  const infoFor = (r: Row): AvailableModel | undefined => listFor(r)?.models.find((m) => m.id === r.model.trim());

  const problems = useMemo(() => {
    const p: string[] = [];
    const t1 = rows.filter((r) => r.role === "tier1");
    if (data && t1.length < data.quorum) p.push(`多数決は ${data.quorum} 票の一致で採用するので、投票メンバーは ${data.quorum} つ以上必要です`);
    if (rows.some((r) => !r.model.trim())) p.push("モデルが空の行があります");
    if (rows.some((r) => r.vendor === "custom" && (!/^https?:\/\/.+/.test(r.baseUrl.trim()) || !/^[A-Z][A-Z0-9_]*$/.test(r.apiKeyEnv.trim()))))
      p.push("その他（OpenAI 互換）は Base URL（http(s)://…）とキーの名前（英大文字・数字・_）が必要です");
    const seen = new Set<string>();
    for (const r of t1) {
      const k = `${r.vendor}|${r.baseUrl}|${r.model.trim()}`;
      if (seen.has(k)) p.push(`投票に同じモデル（${r.model.trim()}）が 2 回入っています`);
      seen.add(k);
    }
    return p;
  }, [rows, data]);

  if (error) return <ErrorLine error={error} />;
  if (!data || base === null) return null;

  const uniqueName = (wantedName: string, key: number, spec: ModelSpec | null) => {
    // The same model may fill two roles under one name; otherwise names must differ.
    const taken = rows.filter((r) => r.key !== key).map((r) => ({ name: r.name, spec: JSON.stringify({ ...specOf(r, vendors), name: "" }) }));
    const same = (n: string) => taken.find((t) => t.name === n);
    const mine = spec ? JSON.stringify({ ...spec, name: "" }) : "";
    let n = wantedName;
    for (let i = 2; same(n) && same(n)!.spec !== mine; i++) n = `${wantedName.slice(0, 36)}-${i}`;
    return n;
  };
  const set = (key: number, patch: Partial<Row>) =>
    setRows((rs) =>
      rs.map((r) => {
        if (r.key !== key) return r;
        const next = { ...r, ...patch };
        if (patch.model !== undefined || patch.vendor !== undefined) {
          next.name = uniqueName(slug(next.model.trim() || next.vendor), key, specOf({ ...next, name: "" }, vendors));
          // Fill the price from the vendor list / the pricing table when the model changes.
          const known = data.pricing[next.model.trim()] ?? listFor(next)?.models.find((m) => m.id === next.model.trim())?.price;
          if (known) [next.priceIn, next.priceOut] = [String(known[0]), String(known[1])];
          else if (patch.model !== undefined) [next.priceIn, next.priceOut] = ["", ""];
        }
        return next;
      }),
    );
  const add = (role: Role) => {
    const v: VendorId = role === "tier1" && rows.some((r) => r.vendor === "gemini") ? "deepseek" : "gemini";
    const def = vendors.find((x) => x.id === v)!.models[role === "tier1" ? 0 : 1] ?? vendors.find((x) => x.id === v)!.models[0];
    const model = def?.id ?? "";
    const row: Row = {
      key: nextKey++, role, vendor: v, model, name: "", baseUrl: "", apiKeyEnv: "",
      priceIn: num(data.pricing[model]?.[0] ?? def?.price?.[0]), priceOut: num(data.pricing[model]?.[1] ?? def?.price?.[1]),
    };
    row.name = uniqueName(slug(model || v), row.key, specOf(row, vendors));
    setRows((rs) => {
      const at = role === "tier1" ? rs.filter((r) => r.role === "tier1").length : role === "tier2" ? rs.filter((r) => r.role !== "redTeam").length : rs.length;
      return [...rs.slice(0, at), row, ...rs.slice(at)];
    });
  };

  async function test(r: Row) {
    setTests((t) => ({ ...t, [r.key]: { status: "busy", detail: "呼び出し中" } }));
    try {
      const res = await post<TestResult>("/api/models/test", { spec: specOf(r, vendors) });
      setTests((t) => ({ ...t, [r.key]: res }));
    } catch (e) {
      setTests((t) => ({ ...t, [r.key]: { status: "fail", detail: e instanceof Error ? e.message : String(e) } }));
    }
  }

  async function save() {
    setBusy(true);
    try {
      const res = await put<{ file: string; created: boolean }>("/api/models", { ...payload(rows, vendors), previous });
      setBase(current);
      toast(`モデル設定を ${res.file} に保存しました${res.created ? "（新規作成）" : ""}。次の実行から使われます`);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  const t1 = rows.filter((r) => r.role === "tier1").length;
  const usedVendors = [...new Map(rows.map((r) => [keyOf(want(r)), r])).values()];
  const fb = data.fallbackPrice;
  return (
    <Pane title="モデル" aux={`投票 ${t1} · ${data.quorum} 票一致で採用${dirty ? " · 未保存" : ""}`} className={dirty ? "focus" : ""}>
      <p className="dim">
        役割ごとに使うモデルを選びます。モデルの候補はキーを使って各社の API から取得します（キーが無いときは代表的なものだけ）。
        保存先 <code>{data.file ?? "—"}</code> の <code>models</code> と <code>pricing</code>。直前の版は <Kbd>.bak</Kbd> に残り、再起動なしで次の実行から使われます。
      </p>
      {data.fake && <p className="warn">疑似モデル（--fake）で起動中のため、ここで選んだモデルは --fake なしで起動したときに使われます。</p>}
      <table className="t models">
        <thead>
          <tr>
            <th style={{ width: "15ch" }}>役割</th>
            <th style={{ width: "22ch" }}>ベンダー</th>
            <th>モデル</th>
            <th style={{ width: "19ch" }} title="USD / 100 万トークン">価格 $/1M 入力・出力</th>
            <th style={{ width: "13ch" }} />
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const v = vendors.find((x) => x.id === r.vendor)!;
            const info = infoFor(r);
            const list = listFor(r);
            const t = tests[r.key];
            const keySet = r.vendor === "custom" ? null : v.keySet;
            const removable = r.role !== "tier1" || t1 > 1;
            return (
              <tr key={r.key}>
                <td>
                  <span className="fg2" title={ROLE[r.role].help}>{ROLE[r.role].label}</span>
                  {r.role === "tier1" && t1 > 2 && rows.filter((x) => x.role === "tier1").indexOf(r) >= data.quorum && <div className="faint">割れたときだけ</div>}
                </td>
                <td>
                  <select className="input" value={r.vendor} onChange={(e) => set(r.key, { vendor: e.target.value as VendorId, model: vendors.find((x) => x.id === e.target.value)!.models[0]?.id ?? "" })} aria-label="vendor">
                    {vendors.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                  </select>
                  <div className={keySet === false ? "warn" : "faint"} title={r.vendor === "custom" ? undefined : `${v.apiKeyEnv}（上の LLM 欄で設定）`}>
                    {keySet === null ? "キーの名前は下に入力" : keySet ? "キー設定済み" : "キー未設定"}
                  </div>
                </td>
                <td>
                  <input
                    className={`input ${r.model.trim() ? "" : "bad"}`} style={{ width: "100%" }} list={`models-${r.key}`} value={r.model} spellCheck={false}
                    onChange={(e) => set(r.key, { model: e.target.value })} aria-label="model" placeholder={list?.models[0]?.id ?? "model id"}
                  />
                  <datalist id={`models-${r.key}`}>
                    {(list?.models ?? []).map((m) => <option key={m.id} value={m.id}>{[m.label, m.note, m.price ? `$${m.price[0]} / $${m.price[1]}` : ""].filter(Boolean).join(" · ")}</option>)}
                  </datalist>
                  {r.vendor === "custom" && (
                    <div className="btn-row" style={{ marginTop: 2 }}>
                      <input className="input" style={{ flex: 2 }} value={r.baseUrl} placeholder="https://…/v1" spellCheck={false} onChange={(e) => set(r.key, { baseUrl: e.target.value })} aria-label="base URL" />
                      <input className="input" style={{ flex: 1 }} value={r.apiKeyEnv} placeholder="KEY_NAME" spellCheck={false} onChange={(e) => set(r.key, { apiKeyEnv: e.target.value.toUpperCase() })} aria-label="API key name" />
                    </div>
                  )}
                  <div className="faint">
                    {info?.note ?? (list && !info && r.model.trim() ? (list.source === "api" ? "一覧に無い ID（テストで確認）" : "") : "")}
                    {r.name !== slug(r.model.trim()) && <span title="config.yaml での名前（履歴・評価の表示に使う）"> name: {r.name}</span>}
                  </div>
                </td>
                <td>
                  <div className="btn-row" style={{ gap: "0.5ch", flexWrap: "nowrap" }}>
                    <input className="input num" style={{ width: "7ch" }} inputMode="decimal" value={r.priceIn} placeholder={String(fb[0])} onChange={(e) => set(r.key, { priceIn: e.target.value })} aria-label="input price" />
                    <input className="input num" style={{ width: "7ch" }} inputMode="decimal" value={r.priceOut} placeholder={String(fb[1])} onChange={(e) => set(r.key, { priceOut: e.target.value })} aria-label="output price" />
                  </div>
                  {(!r.priceIn.trim() || !r.priceOut.trim()) && <div className="faint">未設定は ${fb[0]} / ${fb[1]} で計上</div>}
                </td>
                <td>
                  <button className="btn" type="button" disabled={!r.model.trim() || t?.status === "busy" || keySet === false} title="小さな JSON 応答を 1 回だけ頼む（数トークン）" onClick={() => void test(r)}>
                    テスト
                  </button>
                  {t && (
                    <div className={MARK[t.status][1]} title={[t.detail, t.hint].filter(Boolean).join("\n")}>
                      {MARK[t.status][0]} {t.status === "ok" ? t.detail.split(" · ")[1] ?? "ok" : t.detail.slice(0, 40)}
                    </div>
                  )}
                </td>
                <td>
                  {removable && <button className="btn icon" type="button" title="外す" aria-label={`${r.model} を外す`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>✕</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 && <Empty>config.yaml に models がありません</Empty>}
      <div className="btn-row" style={{ marginTop: "calc(var(--lh) * 0.5)" }}>
        <button className="btn" type="button" disabled={t1 >= 5} onClick={() => add("tier1")}>＋ 投票に追加</button>
        {!rows.some((r) => r.role === "tier2") && <button className="btn" type="button" onClick={() => add("tier2")}>＋ エスカレーション</button>}
        {!rows.some((r) => r.role === "redTeam") && <button className="btn" type="button" onClick={() => add("redTeam")}>＋ レッドチーム</button>}
        <span className="spacer" style={{ flex: 1 }} />
        {dirty && <button className="btn" type="button" onClick={() => load(data)}>元に戻す</button>}
        <button className="btn primary" type="button" disabled={!dirty || problems.length > 0 || busy || !data.editable} onClick={() => void save()}>保存</button>
      </div>
      {dirty && problems.map((p) => <p key={p} className="warn">{p}</p>)}
      <div className="model-sources">
        {usedVendors.map((r) => {
          const v = vendors.find((x) => x.id === r.vendor)!;
          const k = keyOf(want(r));
          const list = lists[k];
          return (
            <div key={k} className="faint">
              {v.label}: {loading[k] ? "取得中" : list ? (list.source === "api" ? `API から ${list.models.length} 件` : list.error ?? "組み込みの候補") : "—"}
              {" · "}
              <button className="link" type="button" disabled={loading[k]} onClick={() => void refresh(want(r))}>再取得</button>
              {v.priceUrl && <> · <a href={v.priceUrl} target="_blank" rel="noreferrer noopener">価格表 ↗</a></>}
            </div>
          );
        })}
      </div>
      <p className="faint">
        価格は 1 日の上限（${data.dailyBudgetUsd}）の計算に使います。候補に出る価格は参考値なので各社の価格表で確認してください。
        モデルを変えると LLM のキャッシュは効かなくなり、確度の記録はモデルごとに分かれます。プロンプトとの相性は「8 プロンプト」の評価で確かめられます。
      </p>
    </Pane>
  );
}
