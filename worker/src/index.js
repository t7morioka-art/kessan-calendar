/**
 * 決算カレンダー — Cloudflare Worker（読み取り専用の画面）
 *
 * 責務:
 *   - 合言葉による閲覧制限（Cookieで30日保持）
 *   - D1に貯まった決算日をスマホ向けに表示
 *   - GitHub Actions 専用の同期API（Bearerトークン必須）
 *
 * 書き込みは GitHub Actions からの /api/sync/* のみ。
 * 画面側からD1を書き換える経路は一切作らない（守ること#5）。
 *
 * 必要な secret:
 *   VIEW_PASSWORD … 閲覧用の合言葉
 *   SYNC_TOKEN    … GitHub Actions が名乗るトークン
 */

const COOKIE_NAME = 'kc_auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30日

/* ---------------------------------------------------------------- 認証 */

const enc = new TextEncoder();

async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** タイミング攻撃を避けるため、長さに依存しない比較をする */
function safeEqual(a, b) {
  const abuf = enc.encode(a);
  const bbuf = enc.encode(b);
  // 長さが違っても即returnしない
  let diff = abuf.length ^ bbuf.length;
  const len = Math.max(abuf.length, bbuf.length);
  for (let i = 0; i < len; i++) diff |= (abuf[i] ?? 0) ^ (bbuf[i] ?? 0);
  return diff === 0;
}

/** Cookie値は「有効期限.署名」。署名鍵は合言葉そのものなので、合言葉を変えると全端末が再ログインになる */
async function issueCookie(env) {
  const exp = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE;
  return `${exp}.${await hmac(env.VIEW_PASSWORD, String(exp))}`;
}

async function isAuthed(request, env) {
  if (!env.VIEW_PASSWORD) return false;
  const raw = (request.headers.get('Cookie') || '')
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return false;

  const [exp, sig] = raw.slice(COOKIE_NAME.length + 1).split('.');
  if (!exp || !sig) return false;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return false;
  return safeEqual(sig, await hmac(env.VIEW_PASSWORD, exp));
}

/** GitHub Actions からの同期APIの認証 */
function isSyncAuthed(request, env) {
  const auth = request.headers.get('Authorization') || '';
  if (!auth.startsWith('Bearer ') || !env.SYNC_TOKEN) return false;
  return safeEqual(auth.slice(7), env.SYNC_TOKEN);
}

/* ------------------------------------------------------------ ユーティリティ */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function html(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...headers,
    },
  });
}

/** 日本時間の「今日」をYYYY-MM-DDで返す（WorkerのタイムゾーンはUTCなので+9時間する） */
function todayJST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const DOW = ['日', '月', '火', '水', '木', '金', '土'];

function formatDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return { md: `${m}/${d}`, dow, ym: `${y}年${m}月` };
}

function daysUntil(ymd, today) {
  const a = Date.UTC(...ymd.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)));
  const b = Date.UTC(...today.split('-').map(Number).map((v, i) => (i === 1 ? v - 1 : v)));
  return Math.round((a - b) / 86400000);
}

/* ------------------------------------------------------------------ 画面 */

const STYLES = `
:root{
  --bg:#f4f1ea; --card:#fffdf8; --ink:#2b2620; --muted:#8a8073;
  --line:#e0d9cc; --hold:#c0392b; --watch:#2565ae; --accent:#6b5b45;
  --warn-bg:#fdf6e3; --warn-line:#e8d9a8;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#1a1714; --card:#242019; --ink:#ede7dc; --muted:#9a9083;
    --line:#3a342b; --hold:#e8705f; --watch:#6fa8e0; --accent:#c9bda8;
    --warn-bg:#2e2717; --warn-line:#4a3f24;
  }
}
*{box-sizing:border-box}
body{
  margin:0; background:var(--bg); color:var(--ink);
  font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;
  line-height:1.6; -webkit-text-size-adjust:100%;
}
.wrap{max-width:640px; margin:0 auto; padding:16px 14px 64px}
header{padding:20px 0 14px; border-bottom:2px solid var(--line); margin-bottom:18px}
h1{margin:0; font-size:21px; letter-spacing:.02em}
.sub{margin-top:4px; font-size:11px; color:var(--muted); letter-spacing:.14em}
h2{
  font-size:13px; color:var(--muted); letter-spacing:.1em; font-weight:600;
  margin:28px 0 10px; padding-bottom:6px; border-bottom:1px solid var(--line);
}
.next{
  background:var(--card); border:1px solid var(--line); border-left:4px solid var(--hold);
  border-radius:10px; padding:16px; margin-bottom:8px;
}
.next .when{font-size:12px; color:var(--muted); letter-spacing:.08em}
.next .big{font-size:26px; font-weight:700; margin:2px 0 6px}
.month{
  font-size:12px; font-weight:700; color:var(--accent); letter-spacing:.08em;
  margin:22px 0 8px; padding-left:2px;
}
ul{list-style:none; margin:0; padding:0}
li.row{
  display:flex; align-items:center; gap:12px;
  background:var(--card); border:1px solid var(--line); border-radius:10px;
  padding:12px 14px; margin-bottom:7px;
}
li.row.holding{border-left:4px solid var(--hold)}
li.row.watch{border-left:4px solid var(--watch)}
li.row.past{opacity:.45}
.date{min-width:62px; text-align:center; flex-shrink:0}
.date .md{font-size:17px; font-weight:700; line-height:1.15}
.date .dow{font-size:10px; color:var(--muted)}
.info{flex:1; min-width:0}
.name{font-size:15px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap}
.meta{font-size:11px; color:var(--muted); margin-top:1px}
.tag{
  font-size:10px; padding:2px 7px; border-radius:99px; flex-shrink:0;
  border:1px solid currentColor; letter-spacing:.06em;
}
.tag.holding{color:var(--hold)} .tag.watch{color:var(--watch)}
.note{
  background:var(--warn-bg); border:1px solid var(--warn-line);
  border-radius:10px; padding:13px 15px; font-size:12.5px; color:var(--muted);
}
.note b{color:var(--ink)}
.empty{color:var(--muted); font-size:13px; padding:14px 2px}
footer{margin-top:34px; padding-top:14px; border-top:1px solid var(--line); font-size:11px; color:var(--muted)}
footer a{color:var(--muted)}
/* ログイン画面 */
.login{max-width:340px; margin:16vh auto 0; padding:0 20px; text-align:center}
.login h1{font-size:19px; margin-bottom:6px}
.login p{font-size:12.5px; color:var(--muted); margin:0 0 22px}
input[type=password]{
  width:100%; padding:14px; font-size:16px; /* 16px未満だとiOSで拡大される */
  border:1px solid var(--line); border-radius:10px;
  background:var(--card); color:var(--ink); text-align:center;
}
button{
  width:100%; margin-top:10px; padding:14px; font-size:15px; font-weight:600;
  border:0; border-radius:10px; background:var(--accent); color:#fff; cursor:pointer;
}
.err{color:var(--hold); font-size:12.5px; margin-top:14px}
`;

function loginPage(error = '') {
  return html(`<!doctype html><html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>決算カレンダー</title>
<style>${STYLES}</style></head><body>
<form class="login" method="post" action="/login">
  <h1>決算カレンダー</h1>
  <p>合言葉を入力してください</p>
  <input type="password" name="password" autocomplete="current-password"
         autofocus inputmode="text" aria-label="合言葉">
  <button type="submit">ひらく</button>
  ${error ? `<div class="err">${esc(error)}</div>` : ''}
</form></body></html>`, error ? 401 : 200);
}

async function calendarPage(env) {
  const today = todayJST();

  const [earningsRs, stocksRs, runRs] = await env.DB.batch([
    env.DB.prepare(`
      SELECT e.date, e.fq, s.code, s.name, s.type
      FROM earnings e
      JOIN stocks s ON s.code = e.code
      ORDER BY e.date ASC
    `),
    env.DB.prepare(`
      SELECT code, name, type, auto_fetch, fy_note
      FROM stocks ORDER BY type DESC, code ASC
    `),
    env.DB.prepare(`
      SELECT started_at, status, api_rows, matched_rows, inserted_rows, message
      FROM sync_runs ORDER BY id DESC LIMIT 1
    `),
  ]);

  const rows = earningsRs.results || [];
  const stocks = stocksRs.results || [];
  const lastRun = (runRs.results || [])[0];

  const upcoming = rows.filter((r) => r.date >= today);
  const past = rows.filter((r) => r.date < today).slice(-8).reverse();
  const scheduled = new Set(upcoming.map((r) => r.code));

  const label = (t) => (t === 'holding' ? '保有' : '監視');

  const rowHtml = (r, isPast = false) => {
    const { md, dow } = formatDate(r.date);
    return `<li class="row ${esc(r.type)}${isPast ? ' past' : ''}">
      <div class="date"><div class="md">${md}</div><div class="dow">${dow}</div></div>
      <div class="info">
        <div class="name">${esc(r.name)}</div>
        <div class="meta">${esc(r.code)}${r.fq ? ` ・ ${esc(r.fq)}` : ''}</div>
      </div>
      <span class="tag ${esc(r.type)}">${label(r.type)}</span>
    </li>`;
  };

  /* 次の決算 */
  let nextHtml = '';
  if (upcoming.length) {
    const n = upcoming[0];
    const d = daysUntil(n.date, today);
    const when = d === 0 ? '本日' : d === 1 ? '明日' : `${d}日後`;
    const { md, dow } = formatDate(n.date);
    nextHtml = `<div class="next">
      <div class="when">つぎの決算発表 — ${when}</div>
      <div class="big">${esc(n.name)}</div>
      <div class="meta">${md}（${dow}）・${esc(n.code)}${n.fq ? ` ・ ${esc(n.fq)}` : ''}
        ・${label(n.type)}銘柄</div>
    </div>`;
  }

  /* 今後の予定を月ごとに */
  let upcomingHtml = '';
  if (upcoming.length) {
    let currentMonth = '';
    upcomingHtml = upcoming.map((r) => {
      const { ym } = formatDate(r.date);
      const head = ym !== currentMonth ? `<div class="month">${ym}</div>` : '';
      currentMonth = ym;
      return head + rowHtml(r);
    }).join('');
    upcomingHtml = `<ul>${upcomingHtml}</ul>`;
  } else {
    upcomingHtml = `<div class="empty">
      予定はまだありません。決算シーズン（4月下旬・7月下旬・10月下旬・1月下旬〜）に入ると自動で貯まっていきます。
    </div>`;
  }

  /* 日付待ちの銘柄 */
  const waiting = stocks.filter((s) => s.auto_fetch === 1 && !scheduled.has(s.code));
  const manual = stocks.filter((s) => s.auto_fetch === 0);

  const chipList = (list) => (list.length
    ? `<ul>${list.map((s) => `<li class="row ${esc(s.type)}">
        <div class="info">
          <div class="name">${esc(s.name)}</div>
          <div class="meta">${esc(s.code)}${s.fy_note ? ` ・ ${esc(s.fy_note)}` : ''}</div>
        </div>
        <span class="tag ${esc(s.type)}">${label(s.type)}</span>
      </li>`).join('')}</ul>`
    : '<div class="empty">なし</div>');

  /* 最終同期 */
  let footerHtml = '<footer>まだ一度も同期が実行されていません。</footer>';
  if (lastRun) {
    // started_at は UTC。'YYYY-MM-DD HH:MM:SS' と ISO8601('...Z') の両方を受ける
    let iso = lastRun.started_at.replace(' ', 'T');
    if (!iso.endsWith('Z')) iso += 'Z';
    const t = Date.parse(iso);
    const stamp = Number.isNaN(t)
      ? lastRun.started_at
      : new Date(t + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
    footerHtml = `<footer>
      最終同期: ${esc(stamp)} JST ・ ${lastRun.status === 'success' ? '正常' : '<b>エラー</b>'}<br>
      API取得 ${lastRun.api_rows} 件 / 登録銘柄と一致 ${lastRun.matched_rows} 件 / 新規 ${lastRun.inserted_rows} 件
      ${lastRun.message ? `<br>${esc(lastRun.message)}` : ''}
    </footer>`;
  }

  return html(`<!doctype html><html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>決算カレンダー</title>
<style>${STYLES}</style></head><body><div class="wrap">
<header>
  <h1>決算カレンダー</h1>
  <div class="sub">EARNINGS CALENDAR</div>
</header>

${nextHtml}

<h2>今後の予定</h2>
${upcomingHtml}

<h2>日付待ち（${waiting.length}銘柄）</h2>
<div class="note" style="margin-bottom:8px">
  J-Quantsは<b>翌営業日ぶんしか公表しません</b>。毎日1回チェックして、
  発表予定が出た時点でここから上へ移動します。
</div>
${chipList(waiting)}

<h2>自動取得の対象外（${manual.length}銘柄）</h2>
<div class="note" style="margin-bottom:8px">
  J-Quantsが対応するのは<b>3月期・9月期決算の会社のみ</b>です。
  下記は自動取得できないため、日付は手動での確認が必要です。
</div>
${chipList(manual)}

${past.length ? `<h2>最近おわった発表</h2><ul>${past.map((r) => rowHtml(r, true)).join('')}</ul>` : ''}

${footerHtml}
</div></body></html>`);
}

/* ------------------------------------------------- GitHub Actions 用 同期API */

/** 銘柄マスタを渡す（Actionsが突合に使う） */
async function handleGetStocks(env) {
  const { results } = await env.DB.prepare(
    'SELECT code, name, type, auto_fetch FROM stocks WHERE auto_fetch = 1 ORDER BY code',
  ).all();
  return json({ stocks: results || [] });
}

/**
 * 取得結果を書き戻す。ここがD1への唯一の書き込み経路。
 * 成功でも失敗でも sync_runs には必ず1行残す（守ること#4）。
 */
async function handlePostEarnings(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const run = payload.run || {};
  const items = Array.isArray(payload.earnings) ? payload.earnings : [];

  // 既存の (code, date) を先に取り、本当に新規だった件数を数える
  const { results: existingRows } = await env.DB.prepare(
    'SELECT code, date FROM earnings',
  ).all();
  const existing = new Set((existingRows || []).map((r) => `${r.code}|${r.date}`));

  const statements = [];
  let inserted = 0;

  for (const it of items) {
    const code = String(it.code || '').trim();
    const date = String(it.date || '').trim();
    if (!/^\d{4}$/.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    if (!existing.has(`${code}|${date}`)) inserted++;

    statements.push(
      env.DB.prepare(`
        INSERT INTO earnings (code, date, fq, fy, source)
        VALUES (?1, ?2, ?3, ?4, 'jquants')
        ON CONFLICT (code, date) DO UPDATE SET
          fq = excluded.fq,
          fy = excluded.fy,
          updated_at = datetime('now')
      `).bind(code, date, it.fq ?? null, it.fy ?? null),
    );
  }

  statements.push(
    env.DB.prepare(`
      INSERT INTO sync_runs
        (started_at, finished_at, status, api_rows, matched_rows, inserted_rows, message)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).bind(
      run.started_at || new Date().toISOString(),
      run.finished_at || new Date().toISOString(),
      run.status === 'error' ? 'error' : 'success',
      Number(run.api_rows) || 0,
      Number(run.matched_rows) || 0,
      inserted,
      run.message ? String(run.message).slice(0, 500) : null,
    ),
  );

  await env.DB.batch(statements);
  return json({ ok: true, received: items.length, inserted });
}

/* ---------------------------------------------------------------- ルーティング */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- 同期API（Bearerトークン。Cookie認証とは完全に別系統）---
    if (path.startsWith('/api/sync/')) {
      if (!isSyncAuthed(request, env)) return json({ error: 'unauthorized' }, 401);
      if (path === '/api/sync/stocks' && request.method === 'GET') {
        return handleGetStocks(env);
      }
      if (path === '/api/sync/earnings' && request.method === 'POST') {
        return handlePostEarnings(request, env);
      }
      return json({ error: 'not found' }, 404);
    }

    // --- ログイン ---
    if (path === '/login' && request.method === 'POST') {
      const form = await request.formData();
      const given = String(form.get('password') || '');
      if (!env.VIEW_PASSWORD) return loginPage('サーバー側の合言葉が未設定です');
      if (!safeEqual(given, env.VIEW_PASSWORD)) return loginPage('合言葉が違います');

      const cookie = await issueCookie(env);
      return new Response(null, {
        status: 303,
        headers: {
          Location: '/',
          'Set-Cookie': `${COOKIE_NAME}=${cookie}; Path=/; HttpOnly; Secure; `
            + `SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
        },
      });
    }

    if (path === '/logout') {
      return new Response(null, {
        status: 303,
        headers: {
          Location: '/',
          'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
        },
      });
    }

    // --- 画面（要ログイン）---
    if (path === '/' || path === '/calendar') {
      if (!(await isAuthed(request, env))) return loginPage();
      return calendarPage(env);
    }

    return new Response('Not Found', { status: 404 });
  },
};
