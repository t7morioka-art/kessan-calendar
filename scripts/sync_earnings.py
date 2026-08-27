"""
決算発表日の日次同期ジョブ（GitHub Actions から毎日1回実行）

流れ:
  1. Cloudflare D1（Worker経由）から銘柄マスタを読む
  2. J-Quants API から「翌営業日に決算発表する銘柄」を取得
  3. 証券コードを正規化して自分の登録銘柄と突合
  4. 一致したぶんをD1へ書き戻す（同時に実行ログも記録）

設計上の前提:
  - J-Quantsは翌営業日ぶんしか返さない → 先読みはできず、毎日少しずつ貯める積み上げ型
  - 対象は3月期・9月期決算の会社のみ → それ以外は auto_fetch=0 として最初から対象外
  - 書き込みはこのスクリプトだけ（Worker側の画面は読み取り専用）

秘密情報はすべて環境変数から読む。ログには絶対に出さない。
"""

from __future__ import annotations

import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

JQUANTS_URL = "https://api.jquants.com/v2/equities/earnings-calendar"

# 守ること#6: CloudflareのBot対策は既定の python-requests/urllib を弾くことがあるため、
# 自分のUser-Agentを明示する。J-Quants側にも同じものを名乗る。
USER_AGENT = "kessan-calendar-bot/1.0 (+https://github.com/t7morioka-art/kessan-calendar)"

TIMEOUT = 30
MAX_RETRY = 3


def log(msg: str) -> None:
    print(msg, flush=True)


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        log(f"NG  環境変数 {name} が設定されていません")
        sys.exit(1)
    return value


def to5(code: str) -> str:
    """
    J-Quantsは5桁（4桁コード + 末尾0）で返す。例: 4651 -> 46510
    突合はこの5桁表記に揃えて行い、保存は手元の4桁のまま行う。
    """
    code = str(code).strip()
    return code if len(code) == 5 else code + "0"


def request_with_retry(method: str, url: str, **kwargs) -> requests.Response:
    """一時的なエラー(5xx/429/タイムアウト)だけ指数バックオフで再試行する"""
    last_error = None
    for attempt in range(1, MAX_RETRY + 1):
        try:
            res = requests.request(method, url, timeout=TIMEOUT, **kwargs)
            if res.status_code in (429, 500, 502, 503, 504) and attempt < MAX_RETRY:
                wait = 2 ** attempt
                log(f"    HTTP {res.status_code} … {wait}秒待って再試行 ({attempt}/{MAX_RETRY})")
                time.sleep(wait)
                continue
            return res
        except requests.RequestException as e:
            last_error = e
            if attempt < MAX_RETRY:
                wait = 2 ** attempt
                log(f"    通信エラー … {wait}秒待って再試行 ({attempt}/{MAX_RETRY})")
                time.sleep(wait)
    raise RuntimeError(f"リトライ上限に到達しました: {last_error!r}")


# ------------------------------------------------------------------ D1 (Worker経由)

def fetch_stocks(sync_url: str, sync_token: str) -> list[dict]:
    res = request_with_retry(
        "GET",
        f"{sync_url}/api/sync/stocks",
        headers={
            "Authorization": f"Bearer {sync_token}",
            "User-Agent": USER_AGENT,
            "Accept": "application/json",
        },
    )
    if res.status_code != 200:
        raise RuntimeError(f"銘柄マスタの取得に失敗: HTTP {res.status_code} {res.text[:200]}")
    return res.json().get("stocks", [])


def push_result(sync_url: str, sync_token: str, run: dict, earnings: list[dict]) -> dict:
    res = request_with_retry(
        "POST",
        f"{sync_url}/api/sync/earnings",
        headers={
            "Authorization": f"Bearer {sync_token}",
            "User-Agent": USER_AGENT,
            "Content-Type": "application/json",
        },
        data=json.dumps({"run": run, "earnings": earnings}, ensure_ascii=False).encode("utf-8"),
    )
    if res.status_code != 200:
        raise RuntimeError(f"書き戻しに失敗: HTTP {res.status_code} {res.text[:200]}")
    return res.json()


# --------------------------------------------------------------------- J-Quants

def fetch_earnings_calendar(api_key: str) -> list[dict]:
    """翌営業日の決算発表予定を全件取得する（ページングあり）"""
    rows: list[dict] = []
    pagination_key = None

    while True:
        params = {"pagination_key": pagination_key} if pagination_key else None
        res = request_with_retry(
            "GET",
            JQUANTS_URL,
            headers={
                "x-api-key": api_key,
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
            },
            params=params,
        )
        if res.status_code != 200:
            raise RuntimeError(f"J-Quants API エラー: HTTP {res.status_code} {res.text[:200]}")

        body = res.json()
        rows.extend(body.get("data", []))

        pagination_key = body.get("pagination_key")
        if not pagination_key:
            break
        log(f"    次ページを取得します（ここまで {len(rows)} 件）")

    return rows


# ------------------------------------------------------------------------- main

def main() -> int:
    started_at = utcnow()

    api_key = require_env("JQUANTS_API_KEY")
    sync_url = require_env("SYNC_URL").rstrip("/")
    sync_token = require_env("SYNC_TOKEN")
    dry_run = os.environ.get("DRY_RUN", "").lower() in ("1", "true", "yes")

    log(f"=== 決算日同期 開始 {started_at} ===")
    if dry_run:
        log("※ DRY_RUN: D1への書き戻しは行いません")

    api_rows = 0
    matched: list[dict] = []

    try:
        log("\n[1/4] D1から銘柄マスタを取得")
        stocks = fetch_stocks(sync_url, sync_token)
        if not stocks:
            raise RuntimeError("銘柄マスタが空です。先に銘柄を投入してください。")
        by5 = {to5(s["code"]): s for s in stocks}
        log(f"    自動取得対象: {len(stocks)} 銘柄")

        log("\n[2/4] J-Quants API から翌営業日の発表予定を取得")
        rows = fetch_earnings_calendar(api_key)
        api_rows = len(rows)
        log(f"    APIの返却件数: {api_rows} 件（全上場企業ぶん）")
        if api_rows == 0:
            log("    ※ 0件。決算シーズン外は正常な状態です。")

        log("\n[3/4] 証券コードを正規化して突合")
        for r in rows:
            code5 = to5(r.get("Code", ""))
            date = (r.get("Date") or "").strip()
            stock = by5.get(code5)
            if not stock or not date:
                continue
            matched.append({
                "code": stock["code"],
                "date": date,
                "fq": r.get("FQ"),
                "fy": r.get("FY"),
            })
            log(f"    HIT  {stock['code']} {stock['name']} → {date} {r.get('FQ', '')}")
        log(f"    一致: {len(matched)} 件")

        log("\n[4/4] D1へ書き戻し")
        run = {
            "started_at": started_at,
            "finished_at": utcnow(),
            "status": "success",
            "api_rows": api_rows,
            "matched_rows": len(matched),
            "message": None if matched else "一致なし（発表予定が無い日は正常）",
        }
        if dry_run:
            log(f"    DRY_RUN のためスキップ。送信予定の内容: {json.dumps(run, ensure_ascii=False)}")
            return 0

        result = push_result(sync_url, sync_token, run, matched)
        log(f"    書き戻し完了: 受理 {result.get('received')} 件 / 新規 {result.get('inserted')} 件")

        log("\n=== 正常終了 ===")
        return 0

    except Exception as e:
        # 失敗しても実行ログだけはD1に残す（守ること#4）。
        # ここで握りつぶさず、最後にちゃんと異常終了させる。
        log(f"\nNG  {e}")
        if not dry_run:
            try:
                push_result(sync_url, sync_token, {
                    "started_at": started_at,
                    "finished_at": utcnow(),
                    "status": "error",
                    "api_rows": api_rows,
                    "matched_rows": len(matched),
                    "message": str(e)[:500],
                }, [])
                log("    エラーを実行ログとしてD1に記録しました")
            except Exception as e2:
                log(f"    エラーログの記録にも失敗: {e2}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
