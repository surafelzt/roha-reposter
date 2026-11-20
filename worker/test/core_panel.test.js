import test from 'node:test';
import assert from 'node:assert/strict';
import { isOwner, normalizeSource, clampStep, panelKeyboard, panelText, handleUpdate, LIMITS } from '../src/panel.js';
import { DEFAULTS, getSettings, setSetting } from '../src/db.js';
import { makeDb } from './core_helpers.js';

const env0 = { OWNER_ID: '111', REPOSTER_BOT_TOKEN: 'TOKEN', CHANNEL_ID: '@c', PUBLIC_URL: 'https://x.dev' };

function mockFetch() {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const method = String(url).split('/').pop();
    const body = JSON.parse(opts.body);
    calls.push({ method, body });
    const result = method === 'sendMessage' ? { message_id: 9, chat: { id: body.chat_id } } : true;
    return new Response(JSON.stringify({ ok: true, result }));
  };
  return calls;
}

test('isOwner', () => {
  assert.ok(isOwner({ message: { from: { id: 111 } } }, env0));
  assert.ok(isOwner({ callback_query: { from: { id: '111' } } }, env0));
  assert.ok(!isOwner({ message: { from: { id: 222 } } }, env0));
  assert.ok(!isOwner({ message: { from: { id: 111 } } }, {}));
  assert.ok(!isOwner({}, env0));
});

test('normalizeSource', () => {
  assert.equal(normalizeSource('@someshop'), '@someshop');
  assert.equal(normalizeSource('t.me/Some_Shop'), '@Some_Shop');
  assert.equal(normalizeSource('https://t.me/someshop'), '@someshop');
  assert.equal(normalizeSource('https://t.me/someshop/123'), '@someshop');
  assert.equal(normalizeSource('Some Tools Group'), 'Some Tools Group');
  assert.equal(normalizeSource('-1003913832398'), '-1003913832398');
  assert.equal(normalizeSource('https://t.me/+AbCdEf123'), null);
  assert.equal(normalizeSource('t.me/joinchat/AbCdEf'), null);
  assert.equal(normalizeSource('@ab'), null);
  assert.equal(normalizeSource(''), null);
});

test('clampStep and limits', () => {
  assert.equal(clampStep(0, 'd', 10, 0, 1000), 0);
  assert.equal(clampStep(0, 'u', 10, 0, 1000), 10);
  assert.equal(clampStep(1, 'd', 1, 1, 60), 1);
  assert.equal(clampStep(10, 'u', 1, 0, 10), 10);
  assert.equal(LIMITS.length, 4);
});

test('panel keyboard labels and callback size', () => {
  const kb = panelKeyboard({ ...DEFAULTS });
  const flat = kb.inline_keyboard.flat();
  assert.equal(flat[0].text, '▶️ Running');
  assert.equal(flat[1].text, '🔔 Sound: Auto 5/day');
  assert.ok(flat.every((b) => Buffer.byteLength(b.callback_data) <= 64));
  const off = panelKeyboard({ ...DEFAULTS, running: false, sound_mode: 'silent' }).inline_keyboard.flat();
  assert.equal(off[0].text, '⏸ Stopped');
  assert.equal(off[1].text, '🔕 All silent');
});

test('panel text has no secrets and shows numbers', () => {
  const t = panelText({ ...DEFAULTS }, { queued: 3, pending: 1, posted: 2, loud: 1, fb: 0, failed: 0, heartbeat: 1000, now: 1720, lastError: '' });
  assert.match(t, /3 waiting to post, 1 waiting for your OK/);
  assert.match(t, /with sound 1\/5/);
  assert.match(t, /12 min ago/);
});

test('non-owner update is ignored: no replies, no changes', async () => {
  const calls = mockFetch();
  const env = { ...env0, DB: makeDb() };
  await handleUpdate({ message: { from: { id: 999 }, chat: { id: 999 }, text: '/panel' } }, env, {});
  await handleUpdate({ callback_query: { id: 'c', from: { id: 999 }, data: 't:run', message: { chat: { id: 999 }, message_id: 1 } } }, env, {});
  assert.equal(calls.length, 0);
  assert.equal((await getSettings(env)).running, true);
});

test('owner: toggle, add and remove source, limits, approval', async () => {
  const calls = mockFetch();
  const env = { ...env0, DB: makeDb() };
  const cbq = (data) => ({ callback_query: { id: 'c1', from: { id: 111 }, data, message: { chat: { id: 111 }, message_id: 5 } } });

  await handleUpdate(cbq('t:run'), env, {});
  assert.equal((await getSettings(env)).running, false);
  assert.ok(calls.some((c) => c.method === 'editMessageText'));
  assert.ok(calls.some((c) => c.method === 'answerCallbackQuery'));

  await handleUpdate(cbq('t:snd'), env, {});
  assert.equal((await getSettings(env)).sound_mode, 'silent');

  // facebook not set up -> refuses to turn on
  await handleUpdate(cbq('t:fb'), env, {});
  assert.equal((await getSettings(env)).fb_enabled, false);
  assert.match(calls.filter((c) => c.method === 'answerCallbackQuery').pop().body.text, /not set up/);

  // add source flow
  await handleUpdate(cbq('as'), env, {});
  assert.equal((await getSettings(env)).await_input, 'add_source');
  await handleUpdate({ message: { from: { id: 111 }, chat: { id: 111 }, text: 'https://t.me/newshop' } }, env, {});
  let s = await getSettings(env);
  assert.ok(s.sources.includes('@newshop'));
  assert.equal(s.await_input, null);

  await handleUpdate(cbq('rs:newshop'), env, {});
  assert.ok(!(await getSettings(env)).sources.includes('@newshop'));

  // remove by position (new buttons); long Amharic names must fit Telegram's 64-byte limit
  await setSetting(env, 'sources', ['@a1', 'የመሳሪያዎች መሸጫ ቻናል አዲስ አበባ ሜክሲኮ ቁጥር አንድ', '@c3']);
  await handleUpdate(cbq('rx:1'), env, {});
  assert.deepEqual((await getSettings(env)).sources, ['@a1', '@c3']);

  // limits
  await handleUpdate(cbq('l:cap:u'), env, {});
  await handleUpdate(cbq('l:gap:d'), env, {});
  s = await getSettings(env);
  assert.equal(s.daily_cap, 10);
  assert.equal(s.publish_gap_min, DEFAULTS.publish_gap_min - 1);

  // /cancel clears await
  await handleUpdate(cbq('as'), env, {});
  await handleUpdate({ message: { from: { id: 111 }, chat: { id: 111 }, text: '/cancel' } }, env, {});
  assert.equal((await getSettings(env)).await_input, null);

  // approvals
  env.DB.raw.exec("INSERT INTO queue (created_at,status,name,file_ids) VALUES (1,'pending_approval','Drill','[\"a\"]')");
  await handleUpdate(cbq('ap:1'), env, {});
  assert.equal(env.DB.raw.prepare('SELECT status FROM queue WHERE id=1').get().status, 'queued');
  await handleUpdate(cbq('sk:1'), env, {}); // already decided -> ignored
  assert.equal(env.DB.raw.prepare('SELECT status FROM queue WHERE id=1').get().status, 'queued');
});
