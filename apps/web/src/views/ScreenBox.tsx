import { useState } from "react";
import type { ScreenResult } from "@stockai/core";
import { post } from "../api.ts";
import type { NewRow } from "./SuggestBox.tsx";

type Toast = (m: string, err?: boolean) => void;

const SIZES: Array<[string, string]> = [["large", "大型（$10B〜）"], ["mid", "中型（$2B〜10B）"], ["small", "小型（$300M〜2B）"]];
const SECTORS: Array<[string, string]> = [
  ["tech", "テック"], ["semis", "半導体"], ["communication", "通信・メディア"], ["consumer", "一般消費財"], ["staples", "生活必需品"], ["healthcare", "ヘルスケア"],
  ["financials", "金融"], ["energy", "エネルギー"], ["industrials", "資本財"], ["materials", "素材"], ["utilities", "公益"], ["real_estate", "不動産"],
];
const GROWTH: Array<[string, string]> = [["", "売上の伸び: 条件なし"], ["0", "売上 増収"], ["0.1", "売上 +10% 以上"], ["0.2", "売上 +20% 以上"]];
const MARGIN: Array<[string, string]> = [["", "営業利益率: 条件なし"], ["0", "黒字"], ["0.1", "10% 以上"], ["0.2", "20% 以上"]];

const JP_SIZES: Array<[string, string]> = [["large", "大型（Core30・Large70）"], ["mid", "中型（Mid400）"], ["small", "小型（Small・TOPIX 外）"]];
const JP_SEGMENTS: Array<[string, string]> = [["prime", "プライム"], ["standard", "スタンダード"], ["growth", "グロース"]];
const JP_SECTORS = ["食品", "エネルギー資源", "建設・資材", "素材・化学", "医薬品", "自動車・輸送機", "鉄鋼・非鉄", "機械", "電機・精密", "情報通信・サービスその他", "電気・ガス", "運輸・物流", "商社・卸売", "小売", "銀行", "金融（除く銀行）", "不動産"];

/** Finds stocks from data (US: SEC and prices, any size; Japan: J-Quants listing and prices), not from the model's memory. */
export function ScreenBox({ onAdd, toast, market = "us" }: { onAdd: (rows: NewRow[]) => void; toast: Toast; market?: "us" | "jp" }) {
  const jp = market === "jp";
  const [segments, setSegments] = useState<Set<string>>(new Set(["prime", "standard"]));
  const [sizes, setSizes] = useState<Set<string>>(new Set(["mid", "small"]));
  const [sectors, setSectors] = useState<Set<string>>(new Set());
  const [growth, setGrowth] = useState("");
  const [margin, setMargin] = useState("");
  const [count, setCount] = useState(10);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ScreenResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const flip = (set: Set<string>, v: string) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    return n;
  };

  async function search() {
    if (busy || !sizes.size) return;
    setBusy(true);
    try {
      const r = await post<ScreenResult>("/api/universe/screen", jp
        ? { market: "jp", segments: [...segments], sizes: [...sizes], sectors: [...sectors], count }
        : {
            sizes: [...sizes], sectors: [...sectors], count,
            ...(growth !== "" ? { minRevenueGrowth: Number(growth) } : {}),
            ...(margin !== "" ? { minOperatingMargin: Number(margin) } : {}),
          });
      setResult(r);
      setPicked(new Set(r.candidates.map((c) => c.ticker)));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  function add() {
    if (!result) return;
    const rows = result.candidates.filter((c) => picked.has(c.ticker)).map((c) => ({ ticker: c.ticker, name: c.name, aliases: "", sector: c.sector }));
    onAdd(rows);
    toast(`${rows.length} 銘柄を一覧に加えました。ニュース照合用の名前を確認して「保存」を押してください`);
    setResult(null);
  }

  return (
    <div className="suggest">
      <div className="label">データで探す <span className="faint">{jp ? "（J-Quants の上場銘柄一覧と株価から。プライム〜グロース、小型株も。AI の記憶は使わない）" : "（SEC の財務・規模と株価から。小型株も。AI の記憶は使わない）"}</span></div>
      {jp && (
        <div className="chips">
          {JP_SEGMENTS.map(([v, label]) => <button key={v} type="button" className={`chip ${segments.has(v) ? "on" : ""}`} onClick={() => setSegments((s) => flip(s, v))}>{label}</button>)}
        </div>
      )}
      <div className="chips">
        {(jp ? JP_SIZES : SIZES).map(([v, label]) => <button key={v} type="button" className={`chip ${sizes.has(v) ? "on" : ""}`} onClick={() => setSizes((s) => flip(s, v))}>{label}</button>)}
      </div>
      <div className="chips">
        {(jp ? JP_SECTORS.map((x) => [x, x] as [string, string]) : SECTORS).map(([v, label]) => <button key={v} type="button" className={`chip ${sectors.has(v) ? "on" : ""}`} onClick={() => setSectors((s) => flip(s, v))}>{label}</button>)}
        <span className="faint">{sectors.size ? "" : "（業種を選ばなければ全業種）"}</span>
      </div>
      <form className="btn-row" onSubmit={(e) => { e.preventDefault(); void search(); }}>
        {!jp && <select className="input" value={growth} onChange={(e) => setGrowth(e.target.value)} aria-label="revenue growth">{GROWTH.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
        {!jp && <select className="input" value={margin} onChange={(e) => setMargin(e.target.value)} aria-label="operating margin">{MARGIN.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>}
        <select className="input" value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="count">{[5, 10, 15].map((n) => <option key={n} value={n}>{n} 銘柄</option>)}</select>
        <button className="btn primary" type="submit" disabled={busy || !sizes.size || (jp && !segments.size)}>{busy ? "探しています（株価の取得で数分）…" : "探す"}</button>
      </form>
      {result && (
        <div className="suggest-result">
          <p className="faint">{result.funnel.map((f) => `${f.step} ${f.count.toLocaleString()}`).join(" → ")}</p>
          {result.candidates.length === 0 ? <p className="dim">条件に合う銘柄がありませんでした。条件をゆるめてください。</p> : (
            <table className="t">
              <thead><tr><th /><th>{jp ? "コード" : "ティッカー"}</th><th>名前</th><th>セクター</th><th>数字</th></tr></thead>
              <tbody>
                {result.candidates.map((c) => (
                  <tr key={c.ticker}>
                    <td><input type="checkbox" checked={picked.has(c.ticker)} onChange={() => setPicked((p) => flip(p, c.ticker))} aria-label={c.ticker} /></td>
                    <td><b>{c.ticker}</b></td>
                    <td>{c.name}<div className="faint">{c.exchange}</div></td>
                    <td className="dim">{c.sector}</td>
                    <td className="fg2">{c.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="btn-row" style={{ marginTop: 6 }}>
            <button className="btn primary" type="button" disabled={!picked.size} onClick={add}>選んだ {picked.size} 銘柄を一覧に加える</button>
            <button className="btn" type="button" onClick={() => setResult(null)}>閉じる</button>
            <span className="faint">並び順の重み: {result.weightsFrom === "factor-research" ? "因子の検証の提案" : "既定"}。数字は{jp ? " J-Quants の株価" : " SEC の提出データと株価"}から計算。売買の推奨ではありません。</span>
          </div>
          {result.notes.map((n) => <p key={n} className="faint">· {n}</p>)}
        </div>
      )}
    </div>
  );
}
