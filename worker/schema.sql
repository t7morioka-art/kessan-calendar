-- 決算カレンダー D1 スキーマ
-- 正本はこのD1。書き込みは GitHub Actions のみ（Workerは読み取り専用）。

-- 銘柄マスタ
CREATE TABLE IF NOT EXISTS stocks (
  code        TEXT PRIMARY KEY,             -- 4桁の証券コード（表示・管理はこちらが正）
  name        TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'holding'
              CHECK (type IN ('holding', 'watch')),
  auto_fetch  INTEGER NOT NULL DEFAULT 1,   -- 1=J-Quantsで自動取得可 / 0=対象外（3月期・9月期以外）
  fy_note     TEXT,                         -- 対象外の理由メモ 例: '2月期決算'
  url         TEXT,                         -- IRページ等（任意）
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 決算発表日（積み上げ型。毎日の取得結果をここに貯めていく）
CREATE TABLE IF NOT EXISTS earnings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT NOT NULL,
  date          TEXT NOT NULL,              -- YYYY-MM-DD
  fq            TEXT,                       -- 第１四半期 など
  fy            TEXT,                       -- 3月31日 など
  source        TEXT NOT NULL DEFAULT 'jquants',  -- jquants / manual
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  -- 同じ銘柄・同じ日付は1行だけ。APIが同じ内容を何日も返しても増えない（冪等性）
  UNIQUE (code, date)
);
CREATE INDEX IF NOT EXISTS idx_earnings_date ON earnings (date);
CREATE INDEX IF NOT EXISTS idx_earnings_code ON earnings (code);

-- 実行ログ（守ること#4: 実行状態の永続化）
-- 「0件だった」も必ず記録する。取得失敗と『そもそも予定が無い』を後から区別するため。
CREATE TABLE IF NOT EXISTS sync_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,              -- ISO8601 (UTC)
  finished_at   TEXT,
  status        TEXT NOT NULL,              -- success / error
  api_rows      INTEGER NOT NULL DEFAULT 0, -- APIが返した総件数（全上場企業ぶん）
  matched_rows  INTEGER NOT NULL DEFAULT 0, -- うち自分の登録銘柄と一致した件数
  inserted_rows INTEGER NOT NULL DEFAULT 0, -- 実際に新規登録された件数
  message       TEXT
);
CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs (started_at DESC);
