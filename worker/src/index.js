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
.prov{
  font-size:9.5px; margin-left:6px; padding:1px 5px; border-radius:4px;
  background:var(--warn-bg); border:1px solid var(--warn-line);
  color:var(--muted); vertical-align:middle; font-weight:500;
}
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

/* ナビゲーション */
nav{display:flex; gap:6px; margin:14px 0 4px}
nav a{
  flex:1; text-align:center; text-decoration:none; font-size:13px; padding:9px 4px;
  border:1px solid var(--line); border-radius:8px; color:var(--muted); background:var(--card);
}
nav a.on{background:var(--accent); color:#fff; border-color:var(--accent); font-weight:600}

/* 月カレンダー */
.calhead{display:flex; align-items:center; justify-content:space-between; margin:18px 0 10px}
.calhead .ym{font-size:16px; font-weight:700}
.calhead a{
  text-decoration:none; color:var(--ink); background:var(--card);
  border:1px solid var(--line); border-radius:8px; padding:7px 14px; font-size:14px;
}
table.cal{width:100%; border-collapse:collapse; table-layout:fixed}
table.cal th{
  font-size:10px; color:var(--muted); font-weight:600; padding:5px 0;
  border-bottom:1px solid var(--line);
}
table.cal th.sun{color:var(--hold)} table.cal th.sat{color:var(--watch)}
table.cal td{
  height:46px; vertical-align:top; padding:3px 2px;
  border-bottom:1px solid var(--line); text-align:center;
}
table.cal td .d{font-size:11px; color:var(--muted)}
table.cal td.today{background:var(--warn-bg)}
table.cal td.today .d{color:var(--ink); font-weight:700}
table.cal td.other .d{opacity:.3}
.dots{display:flex; flex-wrap:wrap; gap:2px; justify-content:center; margin-top:3px}
.dot{width:6px; height:6px; border-radius:50%}
.dot.holding{background:var(--hold)} .dot.watch{background:var(--watch)}

/* フォーム */
form.box{
  background:var(--card); border:1px solid var(--line);
  border-radius:10px; padding:15px; margin-bottom:14px;
}
form.box label{display:block; font-size:12px; color:var(--muted); margin:9px 0 4px}
form.box input, form.box select{
  width:100%; padding:11px; font-size:16px; /* 16px未満だとiOSで拡大される */
  border:1px solid var(--line); border-radius:8px;
  background:var(--bg); color:var(--ink);
}
form.box button{margin-top:13px; padding:12px}
.msg{
  border-radius:8px; padding:11px 14px; font-size:13px; margin-bottom:14px;
  background:var(--card); border:1px solid var(--line);
}
.msg.ok{border-left:4px solid var(--watch)}
.msg.ng{border-left:4px solid var(--hold)}
.del{
  background:none; border:1px solid var(--line); color:var(--muted);
  border-radius:6px; padding:5px 9px; font-size:11px; width:auto; margin:0; cursor:pointer;
}
`;

/** 画面上部のナビゲーション。current は 'list' | 'cal' | 'stocks' */
function nav(current) {
  const item = (href, key, text) =>
    `<a href="${href}"${current === key ? ' class="on"' : ''}>${text}</a>`;
  return `<nav>${item('/', 'list', '一覧')}${item('/calendar', 'cal', 'カレンダー')}`
    + `${item('/stocks', 'stocks', '銘柄')}</nav>`;
}

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

/** 日付の出どころを示すバッジ。J-Quantsで確定したものには何も付けない */
function provBadge(source) {
  if (source === 'jquants') return '';
  if (source === 'manual') return '<span class="prov">手入力</span>';
  return '<span class="prov">予定</span>';
}

async function listPage(env) {
  const today = todayJST();

  const [earningsRs, stocksRs, runRs] = await env.DB.batch([
    env.DB.prepare(`
      SELECT e.date, e.fq, e.source, s.code, s.name, s.type
      FROM earnings e JOIN stocks s ON s.code = e.code
      UNION ALL
      SELECT m.date, NULL AS fq, 'manual' AS source, s.code, s.name, s.type
      FROM manual_earnings m JOIN stocks s ON s.code = m.code
      ORDER BY date ASC
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
        <div class="name">${esc(r.name)}${provBadge(r.source)}</div>
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
      <div class="big">${esc(n.name)}${provBadge(n.source)}</div>
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
${nav('list')}

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


/** 月カレンダー。?ym=YYYY-MM で表示する月を切り替える */
async function calendarGridPage(env, ymParam) {
  const today = todayJST();
  const ym = /^\d{4}-\d{2}$/.test(ymParam || '') ? ymParam : today.slice(0, 7);
  const [y, m] = ym.split('-').map(Number);

  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const from = `${ym}-01`;
  const to = `${ym}-${String(lastDay).padStart(2, '0')}`;

  const { results } = await env.DB.prepare(`
    SELECT e.date, e.fq, e.source, s.code, s.name, s.type
    FROM earnings e JOIN stocks s ON s.code = e.code
    WHERE e.date BETWEEN ?1 AND ?2
    UNION ALL
    SELECT m.date, NULL AS fq, 'manual' AS source, s.code, s.name, s.type
    FROM manual_earnings m JOIN stocks s ON s.code = m.code
    WHERE m.date BETWEEN ?1 AND ?2
    ORDER BY date ASC
  `).bind(from, to).all();

  const byDate = new Map();
  for (const r of results || []) {
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date).push(r);
  }

  // 前月・翌月へのリンク
  const shift = (delta) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };

  // 1日が何曜日から始まるかに合わせて、日曜始まりの格子を組む
  const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const cells = Math.ceil((firstDow + lastDay) / 7) * 7;

  let grid = '';
  for (let i = 0; i < cells; i++) {
    if (i % 7 === 0) grid += '<tr>';
    const dayNum = i - firstDow + 1;
    if (dayNum < 1 || dayNum > lastDay) {
      grid += '<td class="other"></td>';
    } else {
      const ymd = `${ym}-${String(dayNum).padStart(2, '0')}`;
      const items = byDate.get(ymd) || [];
      const dots = items.length
        ? `<div class="dots">${items.map((r) => `<span class="dot ${esc(r.type)}"></span>`).join('')}</div>`
        : '';
      grid += `<td class="${ymd === today ? 'today' : ''}"><div class="d">${dayNum}</div>${dots}</td>`;
    }
    if (i % 7 === 6) grid += '</tr>';
  }

  const label = (t) => (t === 'holding' ? '保有' : '監視');
  const monthList = (results || []).length
    ? `<ul>${(results || []).map((r) => {
        const { md, dow } = formatDate(r.date);
        return `<li class="row ${esc(r.type)}${r.date < today ? ' past' : ''}">
          <div class="date"><div class="md">${md}</div><div class="dow">${dow}</div></div>
          <div class="info">
            <div class="name">${esc(r.name)}${provBadge(r.source)}</div>
            <div class="meta">${esc(r.code)}${r.fq ? ` ・ ${esc(r.fq)}` : ''}</div>
          </div>
          <span class="tag ${esc(r.type)}">${label(r.type)}</span>
        </li>`;
      }).join('')}</ul>`
    : '<div class="empty">この月の予定はまだありません</div>';

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
${nav('cal')}

<div class="calhead">
  <a href="/calendar?ym=${shift(-1)}">‹ 前月</a>
  <div class="ym">${y}年${m}月</div>
  <a href="/calendar?ym=${shift(1)}">翌月 ›</a>
</div>

<table class="cal">
  <tr>
    <th class="sun">日</th><th>月</th><th>火</th><th>水</th>
    <th>木</th><th>金</th><th class="sat">土</th>
  </tr>
  ${grid}
</table>

<h2>${y}年${m}月の予定（${(results || []).length}件）</h2>
${monthList}
</div></body></html>`);
}


/* --------------------------------------------------------- 銘柄の管理（画面側） */

// 画面に出すメッセージ。任意の文字列をURLから受け取らず、決まった文言だけを出す
const MESSAGES = {
  added: ['ok', '銘柄を追加しました'],
  deleted: ['ok', '銘柄を削除しました'],
  date_added: ['ok', '決算日を追加しました'],
  date_deleted: ['ok', '決算日を削除しました'],
  bad_code: ['ng', '4桁の証券コードを入力してください'],
  not_listed: ['ng', 'その証券コードは上場銘柄一覧に見つかりません。番号をご確認ください'],
  exists: ['ng', 'その銘柄はすでに登録されています'],
  bad_date: ['ng', '日付の形式が正しくありません'],
  no_stock: ['ng', '銘柄を選んでください'],
};

async function stocksPage(env, msgKey) {
  const [stocksRs, manualRs] = await env.DB.batch([
    env.DB.prepare(`
      SELECT code, name, type, auto_fetch, fy_note FROM stocks ORDER BY type DESC, code ASC
    `),
    env.DB.prepare(`
      SELECT m.id, m.date, m.code, s.name FROM manual_earnings m
      JOIN stocks s ON s.code = m.code ORDER BY m.date ASC
    `),
  ]);
  const stocks = stocksRs.results || [];
  const manual = manualRs.results || [];

  const msg = MESSAGES[msgKey]
    ? `<div class="msg ${MESSAGES[msgKey][0]}">${esc(MESSAGES[msgKey][1])}</div>`
    : '';

  const label = (t) => (t === 'holding' ? '保有' : '監視');

  const stockRows = stocks.map((s) => `<li class="row ${esc(s.type)}">
    <div class="info">
      <div class="name">${esc(s.name)}</div>
      <div class="meta">${esc(s.code)} ・ ${label(s.type)}${
        s.auto_fetch ? '' : ` ・ 自動取得の対象外${s.fy_note ? `（${esc(s.fy_note)}）` : ''}`
      }</div>
    </div>
    <form method="post" action="/stocks/delete" style="margin:0">
      <input type="hidden" name="code" value="${esc(s.code)}">
      <button class="del" type="submit">削除</button>
    </form>
  </li>`).join('');

  const manualRows = manual.length
    ? `<ul>${manual.map((m) => {
        const { md, dow } = formatDate(m.date);
        return `<li class="row">
          <div class="date"><div class="md">${md}</div><div class="dow">${dow}</div></div>
          <div class="info">
            <div class="name">${esc(m.name)}</div>
            <div class="meta">${esc(m.code)} ・ ${esc(m.date)}</div>
          </div>
          <form method="post" action="/dates/delete" style="margin:0">
            <input type="hidden" name="id" value="${esc(m.id)}">
            <button class="del" type="submit">削除</button>
          </form>
        </li>`;
      }).join('')}</ul>`
    : '<div class="empty">手入力の決算日はまだありません</div>';

  const options = stocks.map((s) =>
    `<option value="${esc(s.code)}">${esc(s.code)} ${esc(s.name)}</option>`).join('');

  return html(`<!doctype html><html lang="ja"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>銘柄の管理 — 決算カレンダー</title>
<style>${STYLES}</style></head><body><div class="wrap">
<header>
  <h1>銘柄の管理</h1>
  <div class="sub">MANAGE STOCKS</div>
</header>
${nav('stocks')}
${msg}

<h2>銘柄を追加</h2>
<form class="box" method="post" action="/stocks/add">
  <label for="code">証券コード（4桁）</label>
  <input id="code" name="code" inputmode="numeric" pattern="[0-9]{4}" maxlength="4"
         placeholder="7203" required>
  <label for="type">種別</label>
  <select id="type" name="type">
    <option value="holding">保有銘柄</option>
    <option value="watch">監視銘柄</option>
  </select>
  <label style="margin-top:14px">
    <input type="checkbox" name="manual_only" value="1" style="width:auto; margin-right:7px">
    3月期・9月期以外の決算（自動取得できない）
  </label>
  <button type="submit">追加する</button>
</form>
<div class="note" style="margin-bottom:8px">
  会社名は証券コードから<b>自動で入力</b>されます。決算期が分からない場合は
  チェックを入れずに追加してください。3月期・9月期なら決算シーズンに自動で日付が入り、
  そうでなければ日付が入らないだけで、害はありません。
</div>

<h2>決算日を手で追加</h2>
<form class="box" method="post" action="/dates/add">
  <label for="mcode">銘柄</label>
  <select id="mcode" name="code" required>${options}</select>
  <label for="mdate">決算発表日</label>
  <input id="mdate" name="date" type="date" required>
  <button type="submit">追加する</button>
</form>
<div class="note" style="margin-bottom:8px">
  自動取得の対象外の銘柄は、会社のIRページなどで日付を確認して、ここに入力してください。
  <b>J-Quantsが取得した日付とは別に管理される</b>ので、自動更新で消えることはありません。
</div>

<h2>手入力の決算日（${manual.length}件）</h2>
${manualRows}

<h2>登録済みの銘柄（${stocks.length}件）</h2>
<ul>${stockRows}</ul>
</div></body></html>`);
}

/* 以下は画面から stocks / manual_earnings に書き込む処理。
   GitHub Actions はこの2つのテーブルに書き込まないため、書き手は常に1つに保たれる。 */

async function handleAddStock(request, env) {
  const form = await request.formData();
  const code = String(form.get('code') || '').trim();
  const type = form.get('type') === 'watch' ? 'watch' : 'holding';
  const autoFetch = form.get('manual_only') === '1' ? 0 : 1;

  if (!/^\d{4}$/.test(code)) return redirectStocks('bad_code');

  const listed = await env.DB.prepare('SELECT name FROM listed WHERE code = ?1')
    .bind(code).first();
  if (!listed) return redirectStocks('not_listed');

  const dup = await env.DB.prepare('SELECT code FROM stocks WHERE code = ?1')
    .bind(code).first();
  if (dup) return redirectStocks('exists');

  await env.DB.prepare(`
    INSERT INTO stocks (code, name, type, auto_fetch, fy_note)
    VALUES (?1, ?2, ?3, ?4, ?5)
  `).bind(code, listed.name, type, autoFetch,
          autoFetch ? null : '3月期・9月期以外（手入力）').run();

  return redirectStocks('added');
}

async function handleDeleteStock(request, env) {
  const form = await request.formData();
  const code = String(form.get('code') || '').trim();
  if (!/^\d{4}$/.test(code)) return redirectStocks('bad_code');
  // 銘柄を消したら、その銘柄の手入力日付も一緒に片付ける
  await env.DB.batch([
    env.DB.prepare('DELETE FROM manual_earnings WHERE code = ?1').bind(code),
    env.DB.prepare('DELETE FROM stocks WHERE code = ?1').bind(code),
  ]);
  return redirectStocks('deleted');
}

async function handleAddDate(request, env) {
  const form = await request.formData();
  const code = String(form.get('code') || '').trim();
  const date = String(form.get('date') || '').trim();
  if (!/^\d{4}$/.test(code)) return redirectStocks('no_stock');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return redirectStocks('bad_date');

  const stock = await env.DB.prepare('SELECT code FROM stocks WHERE code = ?1')
    .bind(code).first();
  if (!stock) return redirectStocks('no_stock');

  await env.DB.prepare(`
    INSERT INTO manual_earnings (code, date) VALUES (?1, ?2)
    ON CONFLICT (code, date) DO NOTHING
  `).bind(code, date).run();
  return redirectStocks('date_added');
}

async function handleDeleteDate(request, env) {
  const form = await request.formData();
  const id = Number(form.get('id'));
  if (!Number.isInteger(id)) return redirectStocks('bad_date');
  await env.DB.prepare('DELETE FROM manual_earnings WHERE id = ?1').bind(id).run();
  return redirectStocks('date_deleted');
}

/** 二重送信を防ぐため、書き込み後は必ずGETへ転送する */
function redirectStocks(msg) {
  return new Response(null, { status: 303, headers: { Location: `/stocks?msg=${msg}` } });
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

    // J-Quantsが確定日を返したら、同じ銘柄の「未確定」データのうち近い日付のものを消す。
    // 別ソースの予想日とJ-Quantsの確定日が数日ずれていると、同じ決算が2行並んでしまうため。
    statements.push(
      env.DB.prepare(`
        DELETE FROM earnings
        WHERE code = ?1
          AND source <> 'jquants'
          AND date <> ?2
          AND ABS(julianday(date) - julianday(?2)) <= 14
      `).bind(code, date),
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
      if (!safeEqual(given, env.VIEW_PASSWORD)) {
        // 失敗時だけ約1秒待たせる。総当たり攻撃の試行速度を落とすための措置で、
        // D1に記録を残さずに済むため「書き込みはActionsのみ」の原則を崩さない。
        await new Promise((r) => setTimeout(r, 1000));
        return loginPage('合言葉が違います');
      }

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
    // 以降はすべてログイン必須。書き込みも同じ関門の内側にある。
    // Cookieは SameSite=Lax なので、他サイトからのPOSTでは送られない（CSRF対策）。
    const authed = await isAuthed(request, env);

    if (path === '/' || path === '/calendar' || path === '/stocks'
        || path.startsWith('/stocks/') || path.startsWith('/dates/')) {
      if (!authed) return loginPage();
    }

    if (path === '/') return listPage(env);
    if (path === '/calendar') return calendarGridPage(env, url.searchParams.get('ym'));
    if (path === '/stocks' && request.method === 'GET') {
      return stocksPage(env, url.searchParams.get('msg'));
    }

    if (request.method === 'POST') {
      if (path === '/stocks/add') return handleAddStock(request, env);
      if (path === '/stocks/delete') return handleDeleteStock(request, env);
      if (path === '/dates/add') return handleAddDate(request, env);
      if (path === '/dates/delete') return handleDeleteDate(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};
