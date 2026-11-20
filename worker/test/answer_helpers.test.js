import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLang, isGreeting, isLocationQuestion, scoreRows, formatPrice, buildReply, parsePricesPayload } from '../src/answer.js';

test('detectLang', () => {
  assert.equal(detectLang('ሰላም'), 'am');
  assert.equal(detectLang('bosch drill ዋጋ'), 'am');
  assert.equal(detectLang('hello'), 'en');
  assert.equal(detectLang(''), 'en');
});

test('isGreeting', () => {
  for (const t of ['hi', 'Hello!', 'hey', 'selam', 'Selam!!', 'ሰላም', 'ሰላም ነው?', 'start', '/start', 'hiii']) assert.ok(isGreeting(t), t);
  for (const t of ['hi do you have drill', 'bosch drill', 'ዋጋ', '']) assert.ok(!isGreeting(t), t);
});

test('isLocationQuestion', () => {
  for (const t of ['where are you?', 'Location', 'address pls', 'አድራሻ', 'የት ነው?']) assert.ok(isLocationQuestion(t), t);
  assert.ok(!isLocationQuestion('bosch drill price'));
  assert.ok(!isLocationQuestion('where can I find a bosch 13mm impact drill with a hammer function today'));
});

test('formatPrice', () => {
  assert.equal(formatPrice(12500), '12,500');
  assert.equal(formatPrice(999), '999');
  assert.equal(formatPrice(1234567), '1,234,567');
  assert.equal(formatPrice('4500.4'), '4,500');
});

const rows = [
  { code: 'A1', name: 'Bosch Drill GSB 13', name_am: 'ቦሽ ድሪል', category: 'Drills', price: 8500, stock: 3 },
  { code: 'A2', name: 'Bosch Angle Grinder', category: 'Grinders', price: 6000, stock: 0 },
  { code: 'A3', name: 'Drill bit 13mm', category: 'Bits', price: 150, stock: 50 },
  { code: 'A4', name: 'Bosch Drill free', category: 'Drills', price: 0, stock: 1 },
  { code: 'A5', name: 'Hammer', category: 'Hand tools', price: 300, stock: 5 },
];

test('scoreRows ranks by keyword count, skips price 0 and score 0', () => {
  const r = scoreRows(rows, ['bosch', 'drill', '13']);
  assert.equal(r[0].code, 'A1');
  assert.ok(!r.find((x) => x.code === 'A4'));
  assert.ok(!r.find((x) => x.code === 'A5'));
  assert.ok(r.length <= 3);
  assert.deepEqual(scoreRows(rows, ['zzz']), []);
  assert.deepEqual(scoreRows(rows, []), []);
});

test('scoreRows is case-insensitive and finds Amharic', () => {
  assert.equal(scoreRows(rows, ['BOSCH'])[0].code, 'A1');
  assert.equal(scoreRows(rows, ['ድሪል'])[0].code, 'A1');
});

test('buildReply found / not found / photo / am', () => {
  const s = { phone_display: '0989897171' };
  const t = buildReply({ lang: 'en', kind: 'text', rows: [rows[0]], settings: s });
  assert.match(t, /Here's what we have:/);
  assert.match(t, /<b>Bosch Drill GSB 13<\/b> — 8,500 ETB/);
  assert.match(t, /call 0989897171/);
  assert.match(buildReply({ lang: 'en', kind: 'photo', rows: [rows[0]], settings: s }), /Is it one of these\?/);
  assert.match(buildReply({ lang: 'am', kind: 'text', rows: [rows[0]], settings: s }), /8,500 ብር/);
  assert.match(buildReply({ lang: 'en', rows: [], settings: s }), /couldn't find/);
  assert.match(buildReply({ lang: 'am', rows: [], settings: s }), /ይቅርታ/);
});

test('buildReply escapes HTML in names', () => {
  const t = buildReply({ lang: 'en', rows: [{ name: 'A <b> & C', price: 10 }], settings: {} });
  assert.match(t, /A &lt;b&gt; &amp; C/);
});

test('parsePricesPayload JSON', () => {
  const out = parsePricesPayload(JSON.stringify([{ code: 'x', name: 'Drill', price: 100.4, stock: '5' }, { name: 'no code' }]));
  assert.equal(out.length, 1);
  assert.equal(out[0].price, 100);
  assert.equal(out[0].stock, 5);
});

test('parsePricesPayload CSV with odd headers, quotes, commas in price', () => {
  const csv = '﻿Item Code,Item Name,Name AM,Category,Retail Price,Qty\r\nD1,"Drill, Bosch 13mm",ድሪል,Drills,"8,500",4\r\nD2,Hammer,,Hand,300,\r\n,Bad row,,,5,\r\n';
  const out = parsePricesPayload(csv);
  assert.equal(out.length, 2);
  assert.equal(out[0].name, 'Drill, Bosch 13mm');
  assert.equal(out[0].price, 8500);
  assert.equal(out[0].name_am, 'ድሪል');
  assert.equal(out[1].stock, null);
});

test('parsePricesPayload CSV semicolon and "sell price"; broken input gives []', () => {
  assert.equal(parsePricesPayload('code;name;sell price\nA;B;12')[0].price, 12);
  assert.deepEqual(parsePricesPayload('<html>error</html>'), []);
  assert.deepEqual(parsePricesPayload('code,name\nA,B'), []); // no price column
  assert.deepEqual(parsePricesPayload('[broken'), []);
});
