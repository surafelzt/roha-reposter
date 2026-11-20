import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addisNow, escapeHtml, decideSound, buildButtons, stripHtml, hmacSig, safeEqual, readerAuthOk, inWindow, agoText,
} from '../src/util.js';
import { getSettings, setSetting, DEFAULTS } from '../src/db.js';
import { makeDb } from './core_helpers.js';

const base = {
  minutes: 10 * 60, sound_mode: 'auto', sound_max: 5, sound_slots: ['09:00', '12:00', '15:00'],
  quiet_start: '22:00', quiet_end: '07:00', loud_count: 0, used_slots: [],
};

test('addisNow adds 3 hours and rolls the day', () => {
  const r = addisNow(new Date('2026-11-18T21:30:00Z'));
  assert.deepEqual(r, { day: '2026-11-19', minutes: 30, hhmm: '00:30' });
  assert.equal(addisNow(new Date('2026-11-18T06:05:00Z')).hhmm, '09:05');
});

test('quiet hours cross midnight', () => {
  assert.ok(inWindow(23 * 60, '22:00', '07:00'));
  assert.ok(inWindow(3 * 60, '22:00', '07:00'));
  assert.ok(!inWindow(7 * 60, '22:00', '07:00'));
  assert.ok(inWindow(22 * 60, '22:00', '07:00'));
  assert.ok(!inWindow(12 * 60, '22:00', '07:00'));
  assert.ok(!inWindow(5, '10:00', '10:00'));
});

test('decideSound: quiet hours always silent, even in sound mode', () => {
  assert.equal(decideSound({ ...base, minutes: 23 * 60, sound_mode: 'sound' }).loud, false);
  assert.equal(decideSound({ ...base, minutes: 60, sound_slots: ['00:30'] }).loud, false);
});

test('decideSound: silent and sound modes', () => {
  assert.equal(decideSound({ ...base, sound_mode: 'silent' }).loud, false);
  const r = decideSound({ ...base, sound_mode: 'sound' });
  assert.deepEqual(r, { loud: true, use_slots: [] });
});

test('decideSound: auto uses passed slot', () => {
  const r = decideSound({ ...base, minutes: 9 * 60 + 5 });
  assert.deepEqual(r, { loud: true, use_slots: ['09:00'] });
});

test('decideSound: missed slots are all spent', () => {
  const r = decideSound({ ...base, minutes: 15 * 60 + 10 });
  assert.deepEqual(r, { loud: true, use_slots: ['09:00', '12:00', '15:00'] });
});

test('decideSound: used slots, max and no slot yet', () => {
  assert.equal(decideSound({ ...base, minutes: 11 * 60, used_slots: ['09:00'] }).loud, false);
  assert.equal(decideSound({ ...base, minutes: 8 * 60 }).loud, false);
  assert.equal(decideSound({ ...base, minutes: 10 * 60, loud_count: 5 }).loud, false);
  const r = decideSound({ ...base, minutes: 13 * 60, used_slots: ['09:00'] });
  assert.deepEqual(r.use_slots, ['12:00']);
});

test('buildButtons with and without website', () => {
  const s = { text_username: 'Rohatool', website_url: '', phone: '+251989897171' };
  const a = buildButtons(s, 'https://x.workers.dev/');
  assert.equal(a.inline_keyboard.length, 1);
  assert.deepEqual(a.inline_keyboard[0], [
    { text: '💬 Text', url: 'https://t.me/Rohatool' },
    { text: '📞 Call', url: 'https://t.me/+251989897171' },
  ]);
  const b = buildButtons({ ...s, website_url: 'https://roha.et' }, 'https://x.workers.dev');
  assert.deepEqual(b.inline_keyboard[1], [{ text: '🌐 Visit our website', url: 'https://roha.et' }]);
  assert.equal(buildButtons({ text_username: 'R' }, 'https://x.workers.dev').inline_keyboard[0][1].url, 'https://x.workers.dev/call');
});

test('stripHtml and escapeHtml', () => {
  assert.equal(stripHtml('🔧 <b>Drill &amp; bit</b>\n\n5 &lt; 6 &#39;x&#39; &quot;y&quot;'), "🔧 Drill & bit\n\n5 < 6 'x' \"y\"");
  assert.equal(escapeHtml('a<b>&c'), 'a&lt;b&gt;&amp;c');
  assert.equal(stripHtml('a<br/>b'), 'a\nb');
});

test('hmacSig is 32 hex, stable, key dependent', async () => {
  const a = await hmacSig('k1', 'file1');
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(a, await hmacSig('k1', 'file1'));
  assert.notEqual(a, await hmacSig('k2', 'file1'));
  assert.notEqual(a, await hmacSig('k1', 'file2'));
  // known value: HMAC-SHA256("key", "The quick brown fox jumps over the lazy dog")
  assert.equal(await hmacSig('key', 'The quick brown fox jumps over the lazy dog'), 'f7bc83f430538424b13298e6aa6fb143');
});

test('reader auth compare', () => {
  assert.ok(readerAuthOk('Bearer secret123', 'secret123'));
  assert.ok(!readerAuthOk('Bearer secret124', 'secret123'));
  assert.ok(!readerAuthOk('Bearer secret', 'secret123'));
  assert.ok(!readerAuthOk('secret123', 'secret123'));
  assert.ok(!readerAuthOk(null, 'secret123'));
  assert.ok(!readerAuthOk('Bearer ', ''));
  assert.ok(!readerAuthOk('Bearer x', undefined));
  assert.ok(safeEqual('a', 'a') && !safeEqual('a', 'b') && !safeEqual('a', 'ab'));
});

test('agoText', () => {
  assert.equal(agoText(30), 'just now');
  assert.equal(agoText(12 * 60), '12 min ago');
  assert.equal(agoText(3 * 3600), '3 h ago');
});

test('getSettings applies defaults and stored values', async () => {
  const env = { DB: makeDb() };
  let s = await getSettings(env);
  assert.deepEqual(s.sound_slots, DEFAULTS.sound_slots);
  assert.equal(s.running, true);
  assert.equal(s.publish_gap_min, 2);
  await setSetting(env, 'running', false);
  await setSetting(env, 'sources', ['@a']);
  await setSetting(env, 'daily_cap', 'oops'); // wrong type -> default
  await setSetting(env, 'await_input', 'add_source'); // internal key kept
  s = await getSettings(env);
  assert.equal(s.running, false);
  assert.deepEqual(s.sources, ['@a']);
  assert.equal(s.daily_cap, 0);
  assert.equal(s.await_input, 'add_source');
  s.sources.push('@mutated');
  assert.equal(DEFAULTS.sources.length, 0); // defaults not shared
});
