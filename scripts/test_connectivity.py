"""
J-Quants API への到達確認だけを行う最小テスト。
- 外部への出口が塞がれていないか（DNS / TLS / HTTP）
- APIキーが有効か（登録済みの場合のみ）
標準ライブラリのみ使用（pip install 不要）。APIキーは絶対に出力しない。
"""
import json
import os
import socket
import ssl
import sys
import urllib.error
import urllib.request

HOST = "api.jquants.com"
URL = f"https://{HOST}/v2/equities/earnings-calendar"
UA = "kessan-calendar-bot/1.0 (+https://github.com/t7morioka-art/kessan-calendar)"


def step(title):
    print(f"\n=== {title} ===", flush=True)


def main():
    ok = True

    step("1. DNS 解決")
    try:
        addrs = sorted({ai[4][0] for ai in socket.getaddrinfo(HOST, 443)})
        print(f"OK  {HOST} -> {', '.join(addrs)}")
    except Exception as e:
        print(f"NG  DNS 解決に失敗: {e!r}")
        return 1

    step("2. TLS ハンドシェイク (443)")
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((HOST, 443), timeout=15) as sock:
            with ctx.wrap_socket(sock, server_hostname=HOST) as tls:
                print(f"OK  {tls.version()} / cipher={tls.cipher()[0]}")
    except Exception as e:
        print(f"NG  TLS 接続に失敗: {e!r}")
        return 1

    api_key = os.environ.get("JQUANTS_API_KEY", "").strip()
    step("3. HTTP リクエスト")
    if api_key:
        print(f"APIキー: 設定あり（長さ {len(api_key)} 文字 / 値は出力しません）")
    else:
        print("APIキー: 未設定 -> 認証なしで叩き、到達性のみ確認します")
        print("        （401/403 が返れば『サーバーには届いている』という判定）")

    req = urllib.request.Request(URL, method="GET")
    req.add_header("User-Agent", UA)
    req.add_header("Accept", "application/json")
    if api_key:
        req.add_header("x-api-key", api_key)

    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            status = res.status
            body = res.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        status = e.code
        body = e.read().decode("utf-8", errors="replace")
    except Exception as e:
        print(f"NG  リクエスト自体が失敗（ネットワーク到達不可）: {e!r}")
        return 1

    print(f"HTTP ステータス: {status}")

    if status == 200:
        print("OK  認証成功・データ取得成功")
        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            print(f"NG  JSON として解釈できません: {body[:300]}")
            return 1
        key = next((k for k in data if isinstance(data[k], list)), None)
        rows = data.get(key, []) if key else []
        print(f"レスポンスのキー: {list(data.keys())}")
        print(f"件数: {len(rows)} 件（翌営業日に決算発表する銘柄のみ）")
        if rows:
            print(f"フィールド名: {list(rows[0].keys())}")
            print("先頭3件（公開情報なのでそのまま表示）:")
            for r in rows[:3]:
                print(f"  {json.dumps(r, ensure_ascii=False)}")
        else:
            print("※ 0件。翌営業日に3月期/9月期銘柄の発表予定が無い日は空になります（異常ではない）")
    elif status in (401, 403):
        if api_key:
            print("NG  ネットワークは到達しているが、APIキーが拒否された")
            ok = False
        else:
            print("OK  ネットワーク到達を確認（キー未設定なので認証で弾かれるのは想定通り）")
        print(f"本文: {body[:300]}")
    else:
        print(f"NG  想定外のステータス。本文: {body[:300]}")
        ok = False

    step("結果")
    print("到達性: OK（GitHub Actions ランナーから api.jquants.com に出られる）")
    print(f"認証:   {'OK' if (api_key and status == 200) else ('NG' if api_key else '未検証（キー未設定）')}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
