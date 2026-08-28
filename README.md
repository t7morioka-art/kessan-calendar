# 決算カレンダー

保有・監視している銘柄の決算発表日を自動で集めて、スマホから見られるようにするもの。

公開URL: https://kessan-calendar.t7morioka.workers.dev （合言葉が必要）

## 構成

```
GitHub Actions（毎日20:00 JST）        ← データを書く唯一の主体
  1. D1から銘柄マスタを読む             GET  /api/sync/stocks
  2. J-Quants API から決算予定を取得    GET  /v2/equities/earnings-calendar
  3. 証券コードを正規化して突合
  4. 結果と実行ログをD1へ書き戻す       POST /api/sync/earnings
        │
        ▼
Cloudflare D1（データの正本）
        │
        ▼
Cloudflare Workers（読み取り専用の画面）
```

**書き込みはGitHub Actionsのみ。** Workerの画面側にD1を書き換える経路は存在しない。

## データ元の制約

J-Quants API（JPX公式・無料プラン）の `/v2/equities/earnings-calendar` を使用。

- **翌営業日に決算発表する銘柄しか返さない。** 2週間先を先読みすることはできないため、
  毎日1回チェックして日付を貯めていく積み上げ型にしている。
- **3月期・9月期決算の会社のみが対象。** それ以外（2月期・12月期など）は
  `stocks.auto_fetch = 0` として、画面に「自動取得の対象外」と明示する。
- 証券コードは**5桁**（4桁 + 末尾0）で返る。突合は5桁に揃え、保存と表示は4桁で行う。
- 決算シーズン（4月下旬・7月下旬・10月下旬・1月下旬〜）以外はほぼ0件が返る。
  0件も失敗も `sync_runs` に記録し、後から区別できるようにしている。

## ファイル

| パス | 役割 |
|---|---|
| `scripts/sync_earnings.py` | 日次同期ジョブ本体 |
| `scripts/test_connectivity.py` | J-Quantsへの到達確認（手動実行） |
| `scripts/dump_master.py` | 上場銘柄一覧の取得（初期設定用・手動実行） |
| `worker/src/index.js` | Worker本体（認証・画面・同期API） |
| `worker/schema.sql` | D1のテーブル定義 |
| `worker/test.mjs` | Workerのテスト（`cd worker && node test.mjs`） |
| `.github/workflows/daily-sync.yml` | 毎日20:00 JSTの自動実行 |

`index.html` は旧GitHub Pages版の名残で、現在は新URLへの案内ページ。

## 秘密情報

コードやリポジトリには一切含めない。

| 名前 | 置き場所 | 用途 |
|---|---|---|
| `JQUANTS_API_KEY` | GitHub Secrets | J-Quants APIの認証 |
| `SYNC_URL` | GitHub Secrets | Workerの接続先（公開URLなので実質非機密） |
| `SYNC_TOKEN` | GitHub Secrets と Cloudflare secret の両方 | Actions→Workerの認証 |
| `VIEW_PASSWORD` | Cloudflare secret | 画面の合言葉 |

保有銘柄はD1にのみ存在し、このリポジトリには含まれない（`.gitignore` で `seed*.sql` を除外）。

## よくある操作

```bash
cd worker

# 銘柄を追加する
./node_modules/.bin/wrangler d1 execute kessan-calendar --remote \
  --command="INSERT INTO stocks (code,name,type,auto_fetch) VALUES ('7203','トヨタ自動車','holding',1)"

# 直近の実行ログを見る
./node_modules/.bin/wrangler d1 execute kessan-calendar --remote \
  --command="SELECT * FROM sync_runs ORDER BY id DESC LIMIT 5"

# 画面を修正して反映する
./node_modules/.bin/wrangler deploy

# 合言葉を変える（変更すると全端末で再ログインが必要になる）
./node_modules/.bin/wrangler secret put VIEW_PASSWORD
```

同期を今すぐ試したいときは、GitHubの Actions タブから「決算日の日次同期」を手動実行する。
`dry_run` を有効にすると、D1に書き込まずに取得と突合だけを確認できる。
