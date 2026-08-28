/**
 * Worker のテスト。
 *
 * D1の代わりに Node 内蔵の SQLite を使い、schema.sql をそのまま適用して
 * 本物と同じSQLを実行する。UNIONや重複排除まで実際に動かして確かめられる。
 *
 *   node test.mjs
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import worker from './src/index.js';

/* ---- D1 互換の薄い層 ---- */
function makeDB(sqlite) {
  const exec = (sql, params) => {
    const st = sqlite.prepare(sql);
    return { st, params };
  };
  const stmt = (sql) => ({
    sql,
    params: [],
    bind(...p) { this.params = p.map((v) => (v === undefined ? null : v)); return this; },
    async all() {
      const { st, params } = exec(this.sql, this.params);
      return { results: st.all(...params) };
    },
    async first() {
      const { st, params } = exec(this.sql, this.params);
      return st.get(...params) ?? null;
    },
    async run() {
      const { st, params } = exec(this.sql, this.params);
      st.run(...params);
      return { success: true };
    },
  });
  return {
    prepare: (sql) => stmt(sql),
    async batch(stmts) {
      const out = [];
      for (const s of stmts) {
        const st = sqlite.prepare(s.sql);
        out.push(/^\s*(SELECT|WITH)/i.test(s.sql)
          ? { results: st.all(...s.params) }
          : (st.run(...s.params), { results: [] }));
      }
      return out;
    },
  };
}

const sqlite = new DatabaseSync(':memory:');
for (const chunk of readFileSync('./schema.sql', 'utf8').split(';')) {
  if (chunk.trim()) sqlite.exec(chunk + ';');
}
sqlite.exec(`
  INSERT INTO listed (code,name) VALUES ('7203','トヨタ自動車'),('6861','キーエンス'),('1803','清水建設');
  INSERT INTO stocks (code,name,type,auto_fetch) VALUES
    ('1803','清水建設','holding',1),
    ('3382','セブン＆アイ・ホールディングス','holding',0),
    ('8267','イオン','watch',0);
  INSERT INTO earnings (code,date,fq,source) VALUES ('1803','2026-11-06','第２四半期','jquants');
  INSERT INTO manual_earnings (code,date) VALUES ('3382','2026-10-08');
`);

const env = { VIEW_PASSWORD: 'pw', SYNC_TOKEN: 'tk', DB: makeDB(sqlite) };

let pass = 0, fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  OK   ${name}`); }
  else { fail++; console.log(`  NG   ${name} ${extra}`); }
};
const req = (path, opt = {}) => worker.fetch(new Request(`https://x.dev${path}`, opt), env);
const form = (path, body, cookie) => req(path, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    ...(cookie ? { Cookie: cookie } : {}),
  },
  body: new URLSearchParams(body).toString(),
});
const count = (t) => sqlite.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;

console.log('\n=== 認証 ===');
let res = await req('/');
check('未ログインはログイン画面', (await res.text()).includes('合言葉を入力'));
check('未ログインで銘柄名が漏れない', !(await (await req('/stocks')).text()).includes('清水建設'));
check('未ログインでカレンダーも見えない', !(await (await req('/calendar')).text()).includes('清水建設'));

res = await form('/login', { password: 'pw' });
const cookie = res.headers.get('Set-Cookie').split(';')[0];
check('ログイン成功', res.status === 303);

const auth = { Cookie: cookie };
console.log('\n=== 未ログインでは書き込めないこと ===');
const before = count('stocks');
check('銘柄追加が拒否される', (await form('/stocks/add', { code: '7203' })).status === 200);
check('銘柄削除が拒否される', (await form('/stocks/delete', { code: '1803' })).status === 200);
check('日付追加が拒否される', (await form('/dates/add', { code: '3382', date: '2026-12-01' })).status === 200);
check('データが1件も変わっていない', count('stocks') === before && count('manual_earnings') === 1);

console.log('\n=== カレンダー（月表示）===');
let body = await (await req('/calendar?ym=2026-11', { headers: auth })).text();
check('月が正しく出る', body.includes('2026年11月'));
check('曜日の見出しがある', body.includes('<th class="sun">日</th>'));
check('その月の予定が出る', body.includes('清水建設'));
check('前月・翌月へ移動できる', body.includes('ym=2026-10') && body.includes('ym=2026-12'));
body = await (await req('/calendar?ym=2026-10', { headers: auth })).text();
check('手入力の日付もカレンダーに出る', body.includes('セブン＆アイ') && body.includes('手入力'));
check('別の月の予定は出ない', !body.includes('清水建設'));
body = await (await req('/calendar?ym=notamonth', { headers: auth })).text();
check('でたらめな月指定でも壊れない', body.includes('年') && body.includes('月'));

console.log('\n=== 銘柄の追加 ===');
res = await form('/stocks/add', { code: '7203', type: 'holding' }, cookie);
check('追加後に一覧へ転送される', res.status === 303 && res.headers.get('Location') === '/stocks?msg=added');
const added = sqlite.prepare("SELECT * FROM stocks WHERE code='7203'").get();
check('社名がコードから自動で入る', added?.name === 'トヨタ自動車', `(${added?.name})`);
check('既定では自動取得の対象になる', added?.auto_fetch === 1);

res = await form('/stocks/add', { code: '7203' }, cookie);
check('同じ銘柄は二重登録できない', res.headers.get('Location') === '/stocks?msg=exists');
res = await form('/stocks/add', { code: '9999' }, cookie);
check('上場していないコードは弾く', res.headers.get('Location') === '/stocks?msg=not_listed');
res = await form('/stocks/add', { code: 'abc' }, cookie);
check('4桁でないコードは弾く', res.headers.get('Location') === '/stocks?msg=bad_code');
res = await form('/stocks/add', { code: '6861', manual_only: '1' }, cookie);
check('対象外として追加できる',
      sqlite.prepare("SELECT auto_fetch FROM stocks WHERE code='6861'").get().auto_fetch === 0);

console.log('\n=== 手入力の決算日 ===');
res = await form('/dates/add', { code: '8267', date: '2026-10-08' }, cookie);
check('日付を追加できる', count('manual_earnings') === 2);
res = await form('/dates/add', { code: '8267', date: '2026-10-08' }, cookie);
check('同じ日付は重複しない', count('manual_earnings') === 2);
res = await form('/dates/add', { code: '8267', date: '10月8日' }, cookie);
check('日付の形式が違えば弾く', res.headers.get('Location') === '/stocks?msg=bad_date');
res = await form('/dates/add', { code: '1111', date: '2026-10-08' }, cookie);
check('未登録の銘柄には追加できない', res.headers.get('Location') === '/stocks?msg=no_stock');

console.log('\n=== 銘柄の削除 ===');
await form('/dates/add', { code: '7203', date: '2026-11-05' }, cookie);
const m1 = count('manual_earnings');
res = await form('/stocks/delete', { code: '7203' }, cookie);
check('銘柄が消える', sqlite.prepare("SELECT * FROM stocks WHERE code='7203'").get() === undefined);
check('その銘柄の手入力日付も一緒に消える', count('manual_earnings') === m1 - 1);

console.log('\n=== 一覧画面 ===');
body = await (await req('/', { headers: auth })).text();
check('J-Quants由来の日付に印は付かない', body.includes('清水建設') && !/清水建設<span/.test(body));
check('手入力の日付には「手入力」と出る', body.includes('手入力'));
check('ナビゲーションが出る', body.includes('href="/calendar"') && body.includes('href="/stocks"'));

console.log('\n=== 同期API（Actions側は今までどおり）===');
check('トークン無しは401', (await req('/api/sync/stocks')).status === 401);
check('閲覧Cookieでは使えない', (await req('/api/sync/stocks', { headers: auth })).status === 401);
res = await req('/api/sync/stocks', { headers: { Authorization: 'Bearer tk' } });
const list = (await res.json()).stocks;
check('自動取得対象のみ渡す', list.every((s) => s.auto_fetch === 1) && list.length === 1,
      `(${list.length}件)`);

console.log('\n=== 書き込みの分離（守ること#5）===');
const runsBefore = count('sync_runs');
res = await req('/api/sync/earnings', {
  method: 'POST',
  headers: { Authorization: 'Bearer tk', 'Content-Type': 'application/json' },
  body: JSON.stringify({
    run: { started_at: '2026-08-28T11:00:00Z', status: 'success', api_rows: 1, matched_rows: 1 },
    earnings: [{ code: '3382', date: '2026-10-09', fq: '第２四半期' }],
  }),
});
check('Actionsの書き込みは成功する', res.status === 200);
check('実行ログが1行増える', count('sync_runs') === runsBefore + 1);
check('Actionsは手入力データを消さない',
      sqlite.prepare("SELECT * FROM manual_earnings WHERE code='3382'").get() !== undefined);
check('Actionsは銘柄マスタを書き換えない',
      sqlite.prepare("SELECT name FROM stocks WHERE code='3382'").get().name === 'セブン＆アイ・ホールディングス');

console.log(`\n===== 合計 ${pass} 件成功 / ${fail} 件失敗 =====`);
process.exit(fail ? 1 : 0);
