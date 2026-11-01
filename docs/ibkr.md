# IBKR 接続ガイド

第一候補のブローカーは **インタラクティブ・ブローカーズ証券 (IBKR / IBSJ)**。
接続方式は **TWS API + IB Gateway** (Docker で常駐)。選定理由と他社比較は [research/brokers.md](research/brokers.md)。

## なぜ TWS API + IB Gateway か

| 方式 | 個人口座 | ログイン | 判断 |
|---|---|---|---|
| **TWS API + IB Gateway** | 可 | IBC による自動再起動で **2FA は週1回程度** | **採用** |
| Web API (Client Portal Gateway) | 可 (公式に個人はこの方式のみ) | ゲートウェイ機上でブラウザ認証、セッションは日次で切れる → ほぼ毎日 2FA | 不採用 |
| Web API (OAuth) | 公式には機関向け (個人で使えたという非公式報告あり) | — | 不採用 |

週1回の 2FA (スマホの IB Key で承認) は、「人が承認する」段階の運用と相性が良い。

## 構成

```
┌──────────── 常時起動の Linux マシン (自宅 PC / ミニPC / VPS) ────────────┐
│                                                                          │
│  cron (平日 引け後)                                                       │
│    └─ npm run stockai -- run workflows/ibkr-paper.yaml                   │
│          │  TWS API (127.0.0.1:4002 paper / 4001 live)                   │
│          ▼                                                               │
│  Docker: IB Gateway + IBC (毎日自動再起動、週1回 2FA)                     │
└──────────────────────────────────────────┬───────────────────────────────┘
                                           ▼
                                   IBKR (IBSJ) サーバー
```

## 手順

### 1. 口座

1. インタラクティブ・ブローカーズ証券で口座開設 (日本居住者は IBSJ)
2. 口座管理画面でペーパートレード口座を有効化し、ペーパー用のユーザー名を確認 (口座番号は `DU…` で始まる)
3. 2FA に IB Key (スマホアプリ) を設定

### 2. IB Gateway を起動

```bash
cd deploy/ibkr
cp .env.example .env                       # TWS_USERID をペーパー用ユーザー名に
mkdir -p secrets && printf '%s' 'パスワード' > secrets/tws_password && chmod 600 secrets/tws_password
docker compose up -d
docker compose logs -f                     # 初回はスマホに 2FA 通知 → 承認
```

- API ポートは `127.0.0.1` にのみ公開している。外部に開けないこと
- `.env` と `secrets/` は git 管理外

### 3. stockai の設定

`config/config.yaml` の `ibkr:` セクション (例は `config/config.example.yaml`):

```yaml
ibkr:
  port: 4002            # paper
  mode: paper
  accountId: DU1234567  # 推奨: ゲートウェイが別口座にログインしていたら停止する
  market: jp
  maxOrderValue: 2000000
```

### 4. 実行

```bash
npm run stockai -- run workflows/ibkr-paper.yaml      # 承認ゲートで停止し、注文案を表示
npm run stockai -- approve <runId> approve            # 内容を確認して承認 (または --reject)
npm run stockai -- resume <runId>                     # IBKR に指値注文を送信
```

cron の例 (平日 16:30 JST に実行し、承認待ちで止める):

```cron
30 16 * * 1-5  cd /path/to/stock && npm run -s stockai -- run workflows/ibkr-paper.yaml >> data/cron.log 2>&1
```

## 安全装置 (コードで強制)

| 装置 | 内容 |
|---|---|
| 口座とモードの照合 | `mode: paper` なのに口座番号が `D` で始まらなければ停止。`accountId` を設定すると、それ以外の口座では停止 |
| 本番の三重ロック | `mode: live` には `accountId` の設定 **と** 環境変数 `STOCKAI_LIVE_TRADING=yes-i-understand` **と** 実際に本番口座 (`D` 以外) にログインしていることが必要。どれか欠けたら停止 |
| 承認ゲート | `ibkr-paper.yaml` は `gate.approval` が `manual`。承認なしでは何も送られない |
| 指値のみ | 成行注文は送らない。指値 = 前日終値 ± `limitOffsetBps` を呼値の刻みに丸める (買いは切り下げ、売りは切り上げ) |
| 上限 | 1注文の金額上限 (`maxOrderValue`)、1回の注文数上限 (`maxOrdersPerRun`)、単元株の倍数のみ |
| 空売り禁止 | 保有数を超える売りは送らない |
| 二重発注防止 | 注文ごとに `sa-<日付>-<口座>-<銘柄>-<売買>` を orderRef として付け、同じ日に同じ注文は二度と送らない (ローカル台帳 + ブローカーの未約定注文の両方で確認) |
| 過去日付では送らない | 再生 (`--as-of` / `--from`) では実注文を拒否。`dryRun: true` なら注文案だけ出す |

その上流で、AI の判断に関係なく `portfolio.propose` のリスク制限 (ATR サイズ、銘柄・業種上限、損切り、ドローダウン停止) が必ず掛かる。

## 権限の段階 (DESIGN §8.4 を IBKR で具体化)

| 段階 | ワークフロー | ゲート | 口座 |
|---|---|---|---|
| 1 | demo-* / daily-* | auto | ローカルの疑似口座 (`broker.paper`) |
| 2 | **ibkr-paper** | manual → 実績が出たら auto | **IBKR ペーパー口座** (本物の約定ルール・手数料) |
| 3 | ibkr-live (後で作成) | manual | IBKR 本番口座・少額 (`maxOrderValue` を小さく) |
| 4 | ibkr-live | auto | 金額上限を段階的に引き上げ |

## ペーパー口座で最初に確認すること

以下は公式資料で確認しきれていない。ペーパー口座で実際に試してから本番に進む。

- [ ] 東証銘柄が `symbol=<銘柄コード>, exchange=TSEJ, currency=JPY` で発注できるか (必要なら `ibkr.contracts` で上書き)
- [ ] ポジションの `contract.symbol` が銘柄コード (例 `7203`) で返るか
- [ ] 発注単位: 単元 (100株) か 1株単位か → `risk.lotSize`
- [ ] 引け後に出した DAY 指値が翌営業日の寄付から有効になるか
- [ ] 呼値の刻み: TOPIX500 銘柄で細かい刻みが使えるか (現在は粗い標準刻みに丸めており、どちらでも有効)
- [ ] 手数料 (0.08%・最低80円との記載あり) と、ペーパー口座での手数料の再現
- [ ] 週1回の 2FA の曜日・時刻と、通知を見逃したときの挙動
- [ ] マーケットデータ購読が不要なこと (現在は価格を Twelve Data / J-Quants から取得し、IBKR のデータは使っていない)

## 既知の制約

- 約定の取り込み: 注文は翌日に約定するため、送信後の注文票は `submitted` のまま。次回実行時に口座のポジションとして反映される。約定明細 (価格・手数料) の取り込みは未実装
- IBKR のマーケットデータは未使用 (購読料が掛かる場合がある)
- 実機の IB Gateway に対する結合テストは未実施。単体テストは疑似ブローカーで行っている
