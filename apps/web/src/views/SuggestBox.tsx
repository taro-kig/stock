import { useState } from "react";
import type { Candidate, SuggestResult } from "@stockai/core";
import { post } from "../api.ts";

type Toast = (m: string, err?: boolean) => void;

/** Themes for people who do not know US stocks yet: one click fills the box. */
const PRESETS: Array<[string, string]> = [
  ["半導体・AI インフラ", "半導体、半導体製造装置、AI 向けデータセンターのインフラ"],
  ["クラウド・ソフト", "クラウド、業務用ソフトウェア（SaaS）"],
  ["サイバーセキュリティ", "サイバーセキュリティ"],
  ["医療機器", "医療機器・ヘルスケアサービス"],
  ["製薬・バイオ", "大手製薬とバイオテクノロジー"],
  ["金融", "銀行・保険・決済・取引所"],
  ["ディフェンシブ", "景気の影響を受けにくい生活必需品・公益"],
  ["高配当・連続増配", "長期にわたって増配を続けている高配当株"],
  ["エネルギー・資源", "石油・ガス・電力・素材"],
  ["産業・防衛", "産業機械・航空宇宙・防衛・インフラ建設"],
  ["消費・旅行", "小売・外食・旅行・レジャー"],
  ["中型の成長株", "売上が伸びている中型の成長企業（業種は問わない）"],
];

const STATUS: Record<Candidate["status"], { text: string; cls: string }> = {
  ok: { text: "✓ 確認済み", cls: "ok" },
  unverified: { text: "? 未確認", cls: "warn" },
  rejected: { text: "✕ 除外", cls: "fail" },
};

export interface NewRow {
  ticker: string;
  name: string;
  aliases: string;
  sector: string;
}

export function SuggestBox({ onAdd, toast }: { onAdd: (rows: NewRow[]) => void; toast: Toast }) {
  const [theme, setTheme] = useState("");
  const [count, setCount] = useState(10);
  const [size, setSize] = useState("any");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SuggestResult | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());

  async function search() {
    if (theme.trim().length < 2 || busy) return;
    setBusy(true);
    try {
      const r = await post<SuggestResult>("/api/universe/suggest", { theme, count, size });
      setResult(r);
      setPicked(new Set(r.candidates.filter((c) => c.status === "ok").map((c) => c.ticker)));
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  function add() {
    if (!result) return;
    const rows = result.candidates
      .filter((c) => picked.has(c.ticker) && c.status !== "rejected")
      .map((c) => ({ ticker: c.ticker, name: c.name, aliases: c.aliases.join(", "), sector: c.sector }));
    onAdd(rows);
    toast(`${rows.length} 銘柄を一覧に加えました。内容を確認して「保存」を押してください`);
    setResult(null);
  }

  const toggle = (t: string) =>
    setPicked((p) => {
      const n = new Set(p);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });

  return (
    <div className="suggest">
      <div className="label">AI に銘柄を探してもらう <span className="faint">（テーマを選ぶか書く → 候補を確認して追加）</span></div>
      <div className="chips">
        {PRESETS.map(([label, text]) => (
          <button key={label} type="button" className={`chip ${theme === text ? "on" : ""}`} onClick={() => setTheme(text)}>{label}</button>
        ))}
      </div>
      <form
        className="btn-row"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input className="input" style={{ flex: 1, minWidth: "30ch" }} value={theme} onChange={(e) => setTheme(e.target.value)} placeholder="例: 電力需要の増加で恩恵を受ける会社" aria-label="theme" />
        <select className="input" value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="count">
          {[5, 10, 15, 20].map((n) => <option key={n} value={n}>{n} 銘柄</option>)}
        </select>
        <select className="input" value={size} onChange={(e) => setSize(e.target.value)} aria-label="size">
          <option value="any">規模: 指定なし</option>
          <option value="large">大型（$10B〜）</option>
          <option value="mid">中型（$2B〜10B）</option>
          <option value="small">小型（$300M〜2B）</option>
        </select>
        <button className="btn primary" type="submit" disabled={busy || theme.trim().length < 2}>{busy ? "探しています…" : "探す"}</button>
      </form>
      {result && (
        <div className="suggest-result">
          {result.verificationError && <p className="warn">{result.verificationError}</p>}
          <table className="t">
            <thead><tr><th /><th>ティッカー</th><th>名前</th><th>セクター</th><th>理由</th><th>確認</th></tr></thead>
            <tbody>
              {result.candidates.map((c) => (
                <tr key={c.ticker} className={c.status === "rejected" ? "disabled-row" : ""}>
                  <td><input type="checkbox" disabled={c.status === "rejected"} checked={picked.has(c.ticker)} onChange={() => toggle(c.ticker)} aria-label={c.ticker} /></td>
                  <td><b>{c.ticker}</b></td>
                  <td>{c.name}{c.listing && <div className="faint">{c.listing.name} · {c.listing.exchange}</div>}</td>
                  <td className="dim">{c.sector}</td>
                  <td className="fg2">{c.reason}</td>
                  <td className={`nowrap ${STATUS[c.status].cls}`} title={c.problem ?? ""}>{STATUS[c.status].text}{c.problem && !(c.status === "unverified" && result.verificationError) && <div className="faint" style={{ whiteSpace: "normal", maxWidth: "28ch" }}>{c.problem}</div>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="btn-row" style={{ marginTop: 6 }}>
            <button className="btn primary" type="button" disabled={![...picked].length} onClick={add}>選んだ {[...picked].filter((t) => result.candidates.some((c) => c.ticker === t && c.status !== "rejected")).length} 銘柄を一覧に加える</button>
            <button className="btn" type="button" onClick={() => setResult(null)}>閉じる</button>
            <span className="faint">モデル {result.model}。AI の知識は古いことがあります。理由は参考程度に、気になる銘柄は自分でも確認を。</span>
          </div>
        </div>
      )}
    </div>
  );
}
