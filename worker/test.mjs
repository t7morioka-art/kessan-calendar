import { readFileSync } from 'node:fs';
import worker from './src/index.js';

const SC = '/private/tmp/claude-501/-Users-moritoshi-Desktop-claude/310bb731-fd15-47de-86b5-093b8f65b227/scratchpad';
const earnings = JSON.parse(readFileSync(`${SC}/q_earnings.json`, 'utf8'));
const stocks = JSON.parse(readFileSync(`${SC}/q_stocks.json`, 'utf8'));

// D1の代わり。実際にローカルD1で実行した結果をそのまま返す
const writes = [];
const env = {
  VIEW_PASSWORD: 'localtest-password',
  SYNC_TOKEN: 'localtest-token',
  DB: {
    prepare(sql) {
      const stmt = { sql, params: null, bind(...p) { this.params = p; return this; } };
      return stmt;
    },
    async batch(stmts) {
      return stmts.map((s) => {
        if (s.sql.includes('FROM earnings e')) return { results: earnings };
        if (s.sql.includes('FROM stocks ORDER BY type')) return { results: stocks };
        if (s.sql.includes('FROM sync_runs')) return { results: [] };
        writes.push(s);
        return { results: [] };
      });
    },
  },
};
env.DB.prepare = env.DB.prepare.bind(env.DB);
// .all() を使う経路（同期API）用
const origPrepare = env.DB.prepare;
env.DB.prepare = (sql) => {
  const stmt = origPrepare(sql);
  stmt.all = async () => {
    if (sql.includes('FROM stocks WHERE auto_fetch = 1')) {
      return { results: stocks.filter((s) => s.auto_fetch === 1) };
    }
    if (sql.includes('SELECT code, date FROM earnings')) {
      return { results: earnings.map((e) => ({ code: e.code, date: e.date })) };
    }
    return { results: [] };
  };
  return stmt;
};

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  NG   ${name} ${extra}`); }
};
const get = (path, headers = {}) =>
  worker.fetch(new Request(`https://x.dev${path}`, { headers }), env);

console.log('\n=== 1. 未ログインでは中身が見えないこと ===');
let res = await get('/');
let body = await res.text();
check('/ はログイン画面を返す', res.status === 200 && body.includes('合言葉を入力'));
check('銘柄名が漏れていない', !body.includes('清水建設'));

res = await get('/calendar');
body = await res.text();
check('/calendar も直接は開けない', body.includes('合言葉を入力') && !body.includes('清水建設'));

console.log('\n=== 2. 合言葉の判定 ===');
const login = (pw) => worker.fetch(new Request('https://x.dev/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: `password=${encodeURIComponent(pw)}`,
}), env);

res = await login('wrong-password');
body = await res.text();
check('間違った合言葉は401で拒否', res.status === 401 && body.includes('合言葉が違います'));
check('拒否時も中身は漏れない', !body.includes('清水建設'));

res = await login('localtest-password');
check('正しい合言葉は303でリダイレクト', res.status === 303);
const setCookie = res.headers.get('Set-Cookie') || '';
check('Cookieに HttpOnly が付く', setCookie.includes('HttpOnly'));
check('Cookieに Secure が付く', setCookie.includes('Secure'));
check('Cookieに SameSite が付く', setCookie.includes('SameSite=Lax'));
const cookie = setCookie.split(';')[0];

console.log('\n=== 3. 偽造Cookieを弾くこと ===');
res = await get('/', { Cookie: 'kc_auth=9999999999.deadbeef' });
check('署名が違うCookieは拒否', (await res.text()).includes('合言葉を入力'));
res = await get('/', { Cookie: 'kc_auth=1.' + cookie.split('.')[1] });
check('期限切れCookieは拒否', (await res.text()).includes('合言葉を入力'));

console.log('\n=== 4. ログイン後の画面 ===');
res = await get('/', { Cookie: cookie });
body = await res.text();
check('カレンダーが表示される', res.status === 200 && body.includes('決算カレンダー'));
check('日本語の銘柄名が出る', body.includes('清水建設') && body.includes('セブン＆アイ'));
check('「予定」の未確定バッジが出る', body.includes('class="prov"'));
check('保有/監視の色分けがある', body.includes('row holding') && body.includes('row watch'));
check('対象外セクションに件数が出る', body.includes('自動取得の対象外（15銘柄）'));
check('日付待ちセクションがある', /日付待ち（\d+銘柄）/.test(body));
check('スマホ用のviewport指定がある', body.includes('width=device-width'));
check('未同期の注記が出る', body.includes('まだ一度も同期が実行されていません'));

console.log('\n=== 5. 同期API（GitHub Actions用）===');
res = await get('/api/sync/stocks');
check('トークン無しは401', res.status === 401);
res = await get('/api/sync/stocks', { Authorization: 'Bearer wrong' });
check('違うトークンは401', res.status === 401);
res = await get('/api/sync/stocks', { Cookie: cookie });
check('閲覧Cookieでは同期APIを使えない', res.status === 401);

res = await get('/api/sync/stocks', { Authorization: 'Bearer localtest-token' });
const data = await res.json();
check('正しいトークンで銘柄マスタを取得', res.status === 200 && data.stocks.length === 33,
      `(${data.stocks?.length}件)`);
check('対象外銘柄は渡されない', data.stocks.every((s) => s.auto_fetch === 1));

console.log('\n=== 6. 書き込みAPI ===');
const post = (body, token = 'localtest-token') => worker.fetch(new Request('https://x.dev/api/sync/earnings', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}), env);

res = await post({ run: {}, earnings: [] }, 'wrong');
check('トークン無しでは書き込めない', res.status === 401);

writes.length = 0;
res = await post({
  run: { started_at: '2026-08-28T11:00:00Z', status: 'success', api_rows: 5, matched_rows: 1 },
  earnings: [
    { code: '1803', date: '2026-11-06', fq: '第２四半期', fy: '3月31日' },  // 既存と同じ
    { code: '9432', date: '2026-11-05', fq: '第２四半期', fy: '3月31日' },  // 新規
    { code: 'BAD',  date: '2026-11-05' },                                   // 不正コード
    { code: '7203', date: 'not-a-date' },                                   // 不正日付
  ],
});
const out = await res.json();
check('正常に受理される', res.status === 200 && out.ok === true);
check('不正な行は捨てられる', out.received === 4 && out.inserted === 1, JSON.stringify(out));
check('確定日ごとに重複排除が走る', writes.filter((w) => w.sql.includes('DELETE FROM earnings')).length === 2);
check('実行ログが必ず1行書かれる', writes.filter((w) => w.sql.includes('INSERT INTO sync_runs')).length === 1);

res = await get('/api/sync/unknown', { Authorization: 'Bearer localtest-token' });
check('未定義のAPIは404', res.status === 404);

console.log(`\n===== 合計 ${pass} 件成功 / ${fail} 件失敗 =====`);
process.exit(fail ? 1 : 0);
