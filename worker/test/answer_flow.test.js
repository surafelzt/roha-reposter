// Flow tests: handleAnswerUpdate + syncPrices with injected fakes (no network, no real D1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleAnswerUpdate, syncPrices } from '../src/answer.js';

// Tiny fake D1 that understands only the SQL used by answer.js.
function fakeDB(priceRows = []) {
  const prices = new Map(priceRows.map((r) => [r.code, { updated_at: 0, ...r }]));
  const chats = new Map();
  const run = (sql, a) => {
    if (sql.startsWith('SELECT chat_id')) return chats.get(a[0]) || null;
    if (sql.startsWith('INSERT INTO chats') && sql.includes('WHERE chats.last_bot_at')) {
      const c = chats.get(a[0]);
      if (c && c.last_bot_at != null && c.last_bot_at >= a[2]) return { meta: { changes: 0 } };
      chats.set(a[0], { chat_id: a[0], ...(c || {}), last_bot_at: a[1] });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('INSERT INTO chats')) {
      const f = sql.match(/\(chat_id, (\w+)\)/)[1];
      chats.set(a[0], { chat_id: a[0], ...(chats.get(a[0]) || {}), [f]: a[1] });
      return null;
    }
    if (sql.startsWith('SELECT code, name')) {
      const likes = a.map((x) => x.replace(/^%|%$/g, '').replace(/\\(.)/g, '$1').toLowerCase());
      return { results: [...prices.values()].filter((r) => r.price > 0 && likes.some((k) => [r.name, r.name_am, r.code, r.category].some((v) => String(v ?? '').toLowerCase().includes(k)))) };
    }
    if (sql.startsWith('INSERT INTO prices')) {
      const [code, name, name_am, category, price, stock, updated_at] = a;
      prices.set(code, { code, name, name_am, category, price, stock, updated_at });
      return null;
    }
    if (sql.includes('COUNT(*)') && sql.includes('updated_at <')) return { n: [...prices.values()].filter((r) => r.updated_at < a[0]).length };
    if (sql.startsWith('DELETE FROM prices')) { for (const [k, r] of prices) if (r.updated_at < a[0]) prices.delete(k); return null; }
    throw new Error('unexpected sql ' + sql);
  };
  const stmt = (sql) => ({ bind: (...a) => ({ sql, a, first: async () => run(sql, a), all: async () => run(sql, a), run: async () => run(sql, a) }) });
  return { prices, chats, prepare: stmt, batch: async (list) => { for (const s of list) await s.run(); } };
}

const BASE = { ANSWER_BOT_TOKEN: 'tok', OWNER_ID: '111', GEMINI_API_KEY: 'g' };
function setup({ settings = {}, rows = [], gemini } = {}) {
  const sent = [], store = {
    answer_enabled: true, answer_handoff_minutes: 120, phone_display: '0989897171',
    address_en: 'Addis', address_am: 'አዲስ',
    answer_connection: { id: 'bc1', user_id: 111, can_reply: true, enabled: true }, ...settings,
  };
  const env = { ...BASE, DB: fakeDB(rows) };
  const deps = {
    tg: async (token, method, body) => { sent.push({ method, body }); return method === 'getFile' ? { file_path: 'p.jpg' } : {}; },
    getSettings: async () => ({ ...store }),
    setSetting: async (e, k, v) => { store[k] = v; },
    logEvent: async () => {},
    fetch: async (url) => {
      if (String(url).includes('generativelanguage')) {
        if (!gemini) return { ok: false, status: 500, json: async () => ({}) };
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(gemini) }] } }] }) };
      }
      return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer, text: async () => '' };
    },
    now: () => 1_000_000,
  };
  return { env, deps, sent, store };
}
const bmsg = (text, extra = {}) => ({ business_message: { business_connection_id: 'bc1', chat: { id: 5, type: 'private' }, from: { id: 222, first_name: 'Cust' }, text, ...extra } });
const replies = (sent) => sent.filter((s) => s.method === 'sendMessage');
const DRILL = [{ code: 'D1', name: 'Bosch Drill 13mm', category: 'Drills', price: 8500, stock: 2 }];

test('business_connection: only owner is accepted', async () => {
  const { env, deps, store } = setup({ settings: { answer_connection: undefined } });
  await handleAnswerUpdate({ business_connection: { id: 'x', user: { id: 999 }, is_enabled: true, rights: { can_reply: true } } }, env, {}, deps);
  assert.equal(store.answer_connection, undefined);
  await handleAnswerUpdate({ business_connection: { id: 'x', user: { id: 111 }, is_enabled: true, rights: { can_reply: true } } }, env, {}, deps);
  assert.deepEqual(store.answer_connection, { id: 'x', user_id: 111, can_reply: true, enabled: true });
});

test('found: replies with price from table, business_connection_id set', async () => {
  const { env, deps, sent } = setup({ rows: DRILL, gemini: { intent: 'price', keywords: ['bosch', 'drill'], keywords_am: [] } });
  await handleAnswerUpdate(bmsg('bosch drill price?'), env, {}, deps);
  const r = replies(sent);
  assert.equal(r.length, 1);
  assert.equal(r[0].body.business_connection_id, 'bc1');
  assert.equal(r[0].body.chat_id, 5);
  assert.match(r[0].body.text, /8,500 ETB/);
  assert.equal(env.DB.chats.get('5').last_bot_at, 1_000_000);
});

test('Gemini fails -> fallback keywords still find item', async () => {
  const { env, deps, sent } = setup({ rows: DRILL });
  await handleAnswerUpdate(bmsg('do you have drill'), env, {}, deps);
  assert.match(replies(sent)[0].body.text, /8,500/);
});

test('AI cannot invent price: AI-supplied numbers never reach the reply', async () => {
  const { env, deps, sent } = setup({ rows: DRILL, gemini: { intent: 'price', keywords: ['drill'], keywords_am: [], price: 1 } });
  await handleAnswerUpdate(bmsg('drill'), env, {}, deps);
  assert.ok(!/\b1 ETB/.test(replies(sent)[0].body.text));
});

test('not found: NOT_FOUND to customer + DM to owner', async () => {
  const { env, deps, sent } = setup({ rows: DRILL, gemini: { intent: 'search', keywords: ['crane'], keywords_am: [] } });
  await handleAnswerUpdate(bmsg('crane'), env, {}, deps);
  const r = replies(sent);
  assert.equal(r.length, 2);
  assert.match(r[0].body.text, /couldn't find/);
  assert.equal(r[1].body.chat_id, '111');
  assert.match(r[1].body.text, /Couldn't answer a customer: crane/);
});

test('greeting and location templates (no Gemini needed)', async () => {
  const { env, deps, sent } = setup();
  await handleAnswerUpdate(bmsg('ሰላም'), env, {}, deps);
  assert.match(replies(sent)[0].body.text, /እንኳን በደህና/);
  await handleAnswerUpdate(bmsg('where are you'), env, {}, deps);
  assert.match(replies(sent)[1].body.text, /Addis/);
});

test('silent when disabled, wrong connection, or disabled connection', async () => {
  let s = setup({ settings: { answer_enabled: false } });
  await handleAnswerUpdate(bmsg('hi'), s.env, {}, s.deps); assert.equal(s.sent.length, 0);
  s = setup();
  await handleAnswerUpdate({ business_message: { ...bmsg('hi').business_message, business_connection_id: 'other' } }, s.env, {}, s.deps);
  assert.equal(s.sent.length, 0);
  s = setup({ settings: { answer_connection: { id: 'bc1', enabled: false, can_reply: true } } });
  await handleAnswerUpdate(bmsg('hi'), s.env, {}, s.deps); assert.equal(s.sent.length, 0);
});

test('owner message records handoff; bot stays silent, then speaks after window', async () => {
  const s = setup();
  const owner = { business_message: { business_connection_id: 'bc1', chat: { id: 5 }, from: { id: 111 }, text: 'sure, 8000' } };
  await handleAnswerUpdate(owner, s.env, {}, s.deps);
  assert.equal(s.sent.length, 0);
  assert.equal(s.env.DB.chats.get('5').last_owner_at, 1_000_000);
  await handleAnswerUpdate(bmsg('hi'), s.env, {}, s.deps);
  assert.equal(s.sent.length, 0);
  s.deps.now = () => 1_000_000 + 121 * 60;
  await handleAnswerUpdate(bmsg('hi'), s.env, {}, s.deps);
  assert.equal(replies(s.sent).length, 1);
});

test('photo: Gemini keywords -> search; unclear -> PHOTO_UNCLEAR', async () => {
  let s = setup({ rows: DRILL, gemini: { product: 'Bosch drill', keywords: ['bosch', 'drill'], confidence: 'high' } });
  await handleAnswerUpdate(bmsg(undefined, { text: undefined, photo: [{ file_id: 'a' }, { file_id: 'b' }] }), s.env, {}, s.deps);
  assert.match(replies(s.sent)[0].body.text, /ከእነዚህ አንዱ ነው\?/); // no known lang -> Amharic
  s = setup({ rows: DRILL, gemini: { product: '', keywords: [], confidence: 'low' } });
  await handleAnswerUpdate(bmsg(undefined, { text: undefined, photo: [{ file_id: 'a' }] }), s.env, {}, s.deps);
  assert.match(replies(s.sent)[0].body.text, /send its name|ስም ይላኩልን/);
});

test('album: only one reply', async () => {
  const s = setup({ rows: DRILL, gemini: { product: 'drill', keywords: ['drill'] } });
  const m = bmsg(undefined, { text: undefined, photo: [{ file_id: 'a' }], media_group_id: 'g1' });
  await handleAnswerUpdate(m, s.env, {}, s.deps);
  await handleAnswerUpdate(m, s.env, {}, s.deps);
  assert.equal(replies(s.sent).filter((x) => x.body.chat_id === 5).length, 1);
});

test('direct message to answer bot: no business_connection_id; owner /start gets a note', async () => {
  const s = setup({ rows: DRILL });
  await handleAnswerUpdate({ message: { chat: { id: 7, type: 'private' }, from: { id: 333 }, text: 'drill' } }, s.env, {}, s.deps);
  assert.equal(replies(s.sent)[0].body.business_connection_id, undefined);
  await handleAnswerUpdate({ message: { chat: { id: 111, type: 'private' }, from: { id: 111 }, text: '/start' } }, s.env, {}, s.deps);
  assert.match(replies(s.sent)[1].body.text, /Notifications are on/);
});

test('errors never throw out of the handler', async () => {
  const s = setup();
  s.deps.tg = async () => { throw new Error('boom'); };
  await handleAnswerUpdate(bmsg('hi'), s.env, {}, s.deps);
});

// ---- syncPrices ----
const mkList = (n) => Array.from({ length: n }, (_, i) => ({ code: 'C' + i, name: 'Item ' + i, price: 100 + i }));
const feed = (body, ok = true) => ({ fetch: async () => ({ ok, status: ok ? 200 : 500, text: async () => body }) });

test('syncPrices upserts and deletes missing rows when list >= 20', async () => {
  const s = setup({ rows: [{ code: 'OLD', name: 'Old', price: 5 }, ...mkList(3)] });
  s.env.PRICES_URL = 'https://x/p.json';
  const r = await syncPrices(s.env, { ...s.deps, ...feed(JSON.stringify(mkList(25))) });
  assert.equal(r.count, 25);
  assert.equal(s.env.DB.prices.size, 25);
  assert.ok(!s.env.DB.prices.has('OLD'));
  assert.equal(s.store.last_price_sync, 1_000_000);
});

test('syncPrices does not delete when list is short (< 20)', async () => {
  const s = setup({ rows: [{ code: 'OLD', name: 'Old', price: 5 }] });
  s.env.PRICES_URL = 'https://x';
  await syncPrices(s.env, { ...s.deps, ...feed(JSON.stringify(mkList(5))) });
  assert.ok(s.env.DB.prices.has('OLD'));
  assert.equal(s.env.DB.prices.size, 6);
});

test('syncPrices does not delete when new list is much smaller than old table', async () => {
  const s = setup({ rows: Array.from({ length: 100 }, (_, i) => ({ code: 'O' + i, name: 'o', price: 1 })) });
  s.env.PRICES_URL = 'https://x';
  await syncPrices(s.env, { ...s.deps, ...feed(JSON.stringify(mkList(25))) });
  assert.equal(s.env.DB.prices.size, 125);
});

test('syncPrices throws and keeps table on HTTP error / garbage', async () => {
  const s = setup({ rows: mkList(30) });
  s.env.PRICES_URL = 'https://x';
  await assert.rejects(syncPrices(s.env, { ...s.deps, ...feed('', false) }));
  await assert.rejects(syncPrices(s.env, { ...s.deps, ...feed('<html>oops</html>') }));
  assert.equal(s.env.DB.prices.size, 30);
});

test('syncPrices without PRICES_URL is a no-op', async () => {
  const s = setup();
  assert.deepEqual(await syncPrices(s.env, s.deps), { skipped: true });
});

// ---- review fixes ----
test("bot's own business reply (sender_business_bot) never counts as the owner", async () => {
  const s = setup();
  await handleAnswerUpdate({ business_message: { business_connection_id: 'bc1', chat: { id: 5 }, from: { id: 111 }, sender_business_bot: { id: 9, is_bot: true }, text: 'Hello!' } }, s.env, {}, s.deps);
  assert.equal(s.sent.length, 0);
  assert.equal(s.env.DB.chats.get('5'), undefined);
});

test('small talk with no product words: bot stays quiet', async () => {
  const s = setup({ rows: DRILL, gemini: { intent: 'other', keywords: [], keywords_am: [] } });
  await handleAnswerUpdate(bmsg('ok thank you'), s.env, {}, s.deps);
  assert.equal(s.sent.length, 0);
});

test('syncPrices skips the upsert when the list did not change', async () => {
  const s = setup();
  s.env.PRICES_URL = 'https://x';
  const body = JSON.stringify(mkList(25));
  await syncPrices(s.env, { ...s.deps, ...feed(body) });
  s.env.DB.prices.clear();
  const r = await syncPrices(s.env, { ...s.deps, ...feed(body) });
  assert.equal(r.unchanged, true);
  assert.equal(s.env.DB.prices.size, 0);
});
