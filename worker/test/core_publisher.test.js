import test from 'node:test';
import assert from 'node:assert/strict';
import { publishOne, healthCheck } from '../src/publisher.js';
import { setSetting } from '../src/db.js';
import { makeDb } from './core_helpers.js';

const env0 = { OWNER_ID: '111', REPOSTER_BOT_TOKEN: 'TOKEN', CHANNEL_ID: '@c', PUBLIC_URL: 'https://x.dev' };
// 2026-11-18 12:10 Addis = 09:10 UTC
const NOW = new Date('2026-11-18T09:10:00Z');

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const method = String(url).split('/').pop();
    const body = opts?.body && typeof opts.body === 'string' && opts.body.startsWith('{') ? JSON.parse(opts.body) : opts?.body;
    calls.push({ method, body });
    const r = handler(method, body);
    return new Response(JSON.stringify(r));
  };
  return calls;
}
const add = (env, ids, extra = '') => env.DB.raw.prepare(
  "INSERT INTO queue (created_at,status,name,caption_html,file_ids) VALUES (1,'queued','N',?,?)").run('<b>Hi</b>', JSON.stringify(ids));

test('single photo: loud on slot, buttons, daily counters', async () => {
  const env = { ...env0, DB: makeDb() };
  add(env, ['f1']);
  const calls = mockFetch(() => ({ ok: true, result: { message_id: 77 } }));
  assert.equal(await publishOne(env, NOW), 'posted');
  const c = calls[0];
  assert.equal(c.method, 'sendPhoto');
  assert.equal(c.body.disable_notification, false);
  assert.equal(c.body.reply_markup.inline_keyboard[0][1].url, 'https://t.me/+251989897171');
  const q = env.DB.raw.prepare('SELECT * FROM queue WHERE id=1').get();
  assert.equal(q.status, 'posted'); assert.equal(q.channel_msg_id, 77); assert.equal(q.silent, 0);
  const d = env.DB.raw.prepare('SELECT * FROM daily').get();
  assert.equal(d.posted, 1); assert.equal(d.loud, 1);
  assert.deepEqual(JSON.parse(d.used_slots), ['09:00', '12:00']);
  // gap rule: second item must wait
  add(env, ['f2']);
  assert.equal(await publishOne(env, new Date(NOW.getTime() + 60000)), 'gap');
  // after the gap: both passed slots are spent, so the next post is silent
  const calls2 = mockFetch(() => ({ ok: true, result: { message_id: 78 } }));
  assert.equal(await publishOne(env, new Date(NOW.getTime() + 7 * 60000)), 'posted');
  assert.equal(calls2[0].body.disable_notification, true);
});

test('album: sendMediaGroup, caption on first, no buttons', async () => {
  const env = { ...env0, DB: makeDb() };
  add(env, ['a', 'b', 'c']);
  const calls = mockFetch(() => ({ ok: true, result: [{ message_id: 5 }, { message_id: 6 }, { message_id: 7 }] }));
  await publishOne(env, NOW);
  assert.equal(calls[0].method, 'sendMediaGroup');
  assert.equal(calls[0].body.media[0].parse_mode, 'HTML');
  assert.equal(calls[0].body.media[1].caption, undefined);
  assert.equal(calls[0].body.reply_markup, undefined);
  assert.equal(env.DB.raw.prepare('SELECT channel_msg_id FROM queue').get().channel_msg_id, 5);
});

test('429 leaves item queued; 3 errors fail it; stopped does nothing', async () => {
  const env = { ...env0, DB: makeDb() };
  add(env, ['f1']);
  mockFetch(() => ({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 20 } }));
  assert.equal(await publishOne(env, NOW), 'rate limited');
  assert.equal(env.DB.raw.prepare('SELECT status, tries FROM queue').get().status, 'queued');
  mockFetch((m) => (m === 'sendMessage' ? { ok: true, result: {} } : { ok: false, error_code: 400, description: 'Bad Request' }));
  for (let i = 0; i < 3; i++) await publishOne(env, NOW);
  const q = env.DB.raw.prepare('SELECT status, tries FROM queue').get();
  assert.equal(q.status, 'failed'); assert.equal(q.tries, 3);
  await setSetting(env, 'running', false);
  add(env, ['f2']);
  assert.equal(await publishOne(env, NOW), 'stopped');
});

test('daily cap stops posting; facebook failure does not block', async () => {
  const env = { ...env0, DB: makeDb(), FB_PAGE_ID: 'p', FB_PAGE_TOKEN: 'FBTOKEN', IMG_SIGN_KEY: 'k' };
  await setSetting(env, 'fb_enabled', true);
  add(env, ['f1']);
  const calls = mockFetch((m) => (m === 'photos' ? { error: { message: 'bad FBTOKEN thing' } } : m === 'sendMessage' ? { ok: true, result: {} } : { ok: true, result: { message_id: 1 } }));
  assert.equal(await publishOne(env, NOW), 'posted');
  assert.equal(env.DB.raw.prepare('SELECT status FROM queue').get().status, 'posted');
  assert.ok(calls.some((c) => c.method === 'photos'));
  const logs = env.DB.raw.prepare('SELECT msg FROM log').all().map((r) => r.msg).join('|');
  assert.match(logs, /facebook/);
  assert.ok(!logs.includes('FBTOKEN'));
  await setSetting(env, 'daily_cap', 1);
  add(env, ['f2']);
  assert.equal(await publishOne(env, new Date(NOW.getTime() + 3600e3)), 'daily cap');
});

test('health: no false alarm early in the morning, alarm later the same morning', async () => {
  const env = { ...env0, DB: makeDb() };
  env.DB.raw.prepare("INSERT INTO reader_state (key, value) VALUES ('heartbeat', ?)").run(String(Date.parse('2026-11-17T18:17:00Z') / 1000));
  const sent = mockFetch(() => ({ ok: true, result: {} }));
  await healthCheck(env, new Date('2026-11-18T03:05:00Z')); // 06:05 Addis
  assert.equal(sent.length, 0);
  await healthCheck(env, new Date('2026-11-18T05:40:00Z')); // 08:40 Addis, reader still silent
  assert.equal(sent.length, 1);
  assert.match(sent[0].body.text, /hasn't run/);
});
