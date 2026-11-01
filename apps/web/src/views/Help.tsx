import { Kbd, Pane } from "../components/ui.tsx";

const ROWS: Array<[string, string]> = [
  ["1 – 7", "画面切替（概要 / 実行 / 承認 / 確度 / フロー / ノード / 設定）"],
  ["j / k, ↓ / ↑", "一覧の移動"],
  ["a", "承認（もう一度押して確定）"],
  ["x", "却下（もう一度押して確定）"],
  ["r", "ワークフローを実行（フロー画面）"],
  ["t", "テーマ切替（ink / paper）"],
  ["u", "値動きの色（日本式: 上昇=赤 / 米国式: 上昇=緑）"],
  ["Esc", "閉じる・取消"],
  ["?", "このヘルプ"],
];

export function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()}>
        <Pane title="キー操作" aux="Esc で閉じる">
          <table className="t">
            <tbody>{ROWS.map(([k, d]) => <tr key={k}><td className="nowrap" style={{ width: "16ch" }}><Kbd>{k}</Kbd></td><td className="fg2">{d}</td></tr>)}</tbody>
          </table>
          <hr className="rule" />
          <p className="dim">状態の記号: <span className="st-ok">● 完了</span>  <span className="st-cached">◆ キャッシュ</span>  <span className="st-fallback">◐ 代替/一部</span>  <span className="st-waiting">◌ 承認待ち</span>  <span className="st-skipped">○ 待機/skip</span>  <span className="st-failed">✕ 失敗</span></p>
          <p className="faint">AI は「何を・いつ」を判断し、ルールが「いくら・どこまで損するか」を決めます。承認ゲートでは人が最終確認します。</p>
        </Pane>
      </div>
    </div>
  );
}
