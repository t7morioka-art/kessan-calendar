"""
J-Quants の上場銘柄一覧（/v2/equities/master）を丸ごと取得して JSON に落とす。

目的は「証券コード → 日本語社名」の対応表を作ること。
ここで扱うのはJPXが公開している全上場企業の情報だけで、
利用者の保有銘柄は一切含まれない（そのためActionsのログや成果物に出ても問題ない）。
"""

import json
import os
import sys

import requests

URL = "https://api.jquants.com/v2/equities/master"
USER_AGENT = "kessan-calendar-bot/1.0 (+https://github.com/t7morioka-art/kessan-calendar)"
OUT = "master.json"


def main() -> int:
    api_key = os.environ.get("JQUANTS_API_KEY", "").strip()
    if not api_key:
        print("NG  JQUANTS_API_KEY が未設定")
        return 1

    rows = []
    pagination_key = None

    while True:
        res = requests.get(
            URL,
            headers={
                "x-api-key": api_key,
                "User-Agent": USER_AGENT,
                "Accept": "application/json",
            },
            params={"pagination_key": pagination_key} if pagination_key else None,
            timeout=60,
        )
        if res.status_code != 200:
            print(f"NG  HTTP {res.status_code}: {res.text[:400]}")
            print("    無料プランでは利用できない可能性があります。")
            return 1

        body = res.json()
        rows.extend(body.get("data", []))
        pagination_key = body.get("pagination_key")
        print(f"    取得 {len(rows)} 件", flush=True)
        if not pagination_key:
            break

    if not rows:
        print("NG  0件でした")
        return 1

    print(f"\nOK  合計 {len(rows)} 件")
    print(f"フィールド名: {list(rows[0].keys())}")
    print(f"サンプル: {json.dumps(rows[0], ensure_ascii=False)}")

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False)
    print(f"\n{OUT} に書き出しました")
    return 0


if __name__ == "__main__":
    sys.exit(main())
