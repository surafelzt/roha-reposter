// Answer bot: replies to customers in the owner's Telegram business chats.
// Rules: prices ONLY come from the D1 "prices" table. AI only extracts keywords.
import { tg } from './telegram.js';
import { getSettings, setSetting, logEvent } from './db.js';
import { escapeHtml } from './util.js';
import * as T from './answer_text.js';

const GEMINI_MODELS = ['gemini-flash-lite-latest', 'gemini-flash-latest'];
const GEMINI_TIMEOUT_MS = 20000;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_PRICE_ROWS = 3000; // keeps D1 batches under the 50 subrequest limit

// ---------- pure helpers ----------

// Amharic if any Ethiopic character, else English.
export function detectLang(text) {
  return /[ሀ-፿]/.test(String(text || '')) ? 'am' : 'en';
}

function tokens(text) {
  return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

const GREETING_PHRASES = new Set([
  'hi', 'hello', 'hey', 'selam', 'salam', 'start', 'hi there', 'hello there', 'hey there',
  'good morning', 'good afternoon', 'good evening', 'selam new', 'selam new',
  'ሰላም', 'ሰላም ነው', 'ሰላም ሰላም', 'ታዲያስ', 'እንደምን አደሩ', 'እንደምን ዋሉ',
]);

// True when the message is only a greeting.
export function isGreeting(text) {
  const t = tokens(text).join(' ');
  if (!t) return false;
  if (GREETING_PHRASES.has(t)) return true;
  return /^(hi+|hey+|hello+|selam+|salam+)( there)?$/.test(t);
}

const LOCATION_WORDS = new Set(['where', 'location', 'address', 'located', 'directions', 'direction', 'አድራሻ', 'አድራሻው', 'አድራሻችሁ', 'አድራሻዎ', 'የት']);

// Short message asking where the shop is. Long messages are treated as product questions.
export function isLocationQuestion(text) {
  const t = tokens(text);
  if (!t.length || t.length > 8) return false;
  return t.some((w) => LOCATION_WORDS.has(w));
}

// Thousands commas: 12500 -> "12,500".
export function formatPrice(n) {
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return '0';
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Pick top rows. score = how many keywords appear in name/name_am/code/category.
export function scoreRows(rows, keywords, limit = 3) {
  const kws = [...new Set((keywords || []).map((k) => String(k).trim().toLowerCase()).filter((k) => k.length >= 2))];
  if (!kws.length) return [];
  const scored = [];
  for (const r of rows || []) {
    if (!(Number(r.price) > 0)) continue;
    const hay = [r.name, r.name_am, r.code, r.category].map((x) => String(x ?? '').toLowerCase()).join(' | ');
    const score = kws.filter((k) => hay.includes(k)).length;
    if (score > 0) scored.push({ ...r, score });
  }
  scored.sort((a, b) =>
    b.score - a.score ||
    (Number(b.stock) > 0) - (Number(a.stock) > 0) ||
    String(a.name).length - String(b.name).length);
  return scored.slice(0, limit);
}

// Build the customer reply text. kind: 'text' | 'photo'. Empty rows -> NOT_FOUND.
export function buildReply({ lang = 'am', kind = 'text', rows = [], settings = {} } = {}) {
  const l = lang === 'en' ? 'en' : 'am';
  if (!rows.length) return T.NOT_FOUND[l];
  const lines = rows.map((r) => T.fill(T.LINE[l], { name: escapeHtml(r.name_am && l === 'am' ? r.name_am : r.name), price: formatPrice(r.price) }));
  const phone = escapeHtml(settings.phone_display || '0989897171');
  const head = T.FOUND_HEAD[kind === 'photo' ? 'photo' : 'text'][l];
  return `${head}\n${lines.join('\n')}\n\n${T.fill(T.FOOTER[l], { phone_display: phone })}`;
}

export function locationReply(lang, settings = {}) {
  const l = lang === 'en' ? 'en' : 'am';
  return T.fill(T.LOCATION[l], {
    address_en: escapeHtml(settings.address_en || ''),
    address_am: escapeHtml(settings.address_am || ''),
    phone_display: escapeHtml(settings.phone_display || '0989897171'),
  });
}

const STOPWORDS = new Set(['the', 'is', 'are', 'do', 'you', 'have', 'has', 'price', 'of', 'for', 'how', 'much', 'what', 'a', 'an', 'to', 'me', 'we', 'i', 'can', 'please', 'pls', 'ዋጋ', 'ስንት', 'ነው', 'አለ', 'አላችሁ']);

// Used when Gemini fails: just the words of the message.
export function fallbackKeywords(text) {
  return [...new Set(tokens(text).filter((w) => w.length >= 2 && !STOPWORDS.has(w)))].slice(0, 6);
}

function cleanKeywords(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((k) => String(k ?? '').trim().toLowerCase()).filter((k) => k.length >= 2 && k.length <= 40))].slice(0, 8);
}

// ---------- price list parsing ----------

function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delim = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

const norm = (h) => String(h ?? '').toLowerCase().replace(/[^a-z0-9ሀ-፿]/g, '');
const COLS = {
  code: ['code', 'sku', 'itemcode', 'id', 'productcode'],
  name: ['name', 'item', 'itemname', 'product', 'productname', 'description'],
  name_am: ['nameam', 'nameamharic', 'amharic', 'amharicname', 'አማርኛ'],
  category: ['category', 'group', 'type'],
  price: ['price', 'retail', 'retailprice', 'sellprice', 'sellingprice', 'saleprice', 'unitprice'],
  stock: ['stock', 'qty', 'quantity', 'instock'],
};

function toInt(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) && String(v).match(/\d/) ? Math.round(n) : null;
}

function normalizeItem(o) {
  const code = String(o.code ?? '').trim();
  const name = String(o.name ?? '').trim();
  if (!code || !name) return null;
  return {
    code, name,
    name_am: o.name_am ? String(o.name_am).trim() : null,
    category: o.category ? String(o.category).trim() : null,
    price: toInt(o.price),
    stock: toInt(o.stock),
  };
}

// Accepts a JSON array (string or object) or CSV text. Returns [{code,name,name_am,category,price,stock}].
export function parsePricesPayload(input) {
  let data = input;
  if (typeof input === 'string') {
    const s = input.replace(/^﻿/, '').trim();
    if (s.startsWith('[') || s.startsWith('{')) {
      try { data = JSON.parse(s); } catch { data = null; }
      if (data === null) return [];
    } else data = null;
    if (data === null) {
      const rows = parseCsv(s);
      if (rows.length < 2) return [];
      const head = rows[0].map(norm);
      const idx = {};
      for (const [field, names] of Object.entries(COLS)) idx[field] = head.findIndex((h) => names.includes(h));
      if (idx.code < 0 || idx.name < 0 || idx.price < 0) return [];
      const out = [];
      for (const r of rows.slice(1)) {
        const get = (f) => (idx[f] >= 0 ? r[idx[f]] : undefined);
        const item = normalizeItem({ code: get('code'), name: get('name'), name_am: get('name_am'), category: get('category'), price: get('price'), stock: get('stock') });
        if (item) out.push(item);
      }
      return out;
    }
  }
  if (data && !Array.isArray(data)) data = data.prices || data.items || data.rows || [];
  if (!Array.isArray(data)) return [];
  return data.map(normalizeItem).filter(Boolean);
}

// ---------- price sync ----------

// Download the price list and upsert it. Never wipes the table on a short or broken list.
export async function syncPrices(env, deps = {}) {
  const d = withDeps(deps);
  if (!env.PRICES_URL) return { skipped: true };
  const res = await withTimeout((signal) => d.fetch(env.PRICES_URL, { signal }), GEMINI_TIMEOUT_MS);
  if (!res.ok) throw new Error(`price download failed: HTTP ${res.status}`);
  const body = await res.text();
  // Same list as last time: skip the upsert (protects the free D1 daily write limit).
  const hash = await sha256Hex(body);
  const prev = await d.getSettings(env);
  if (prev.last_price_hash === hash) {
    await d.setSetting(env, 'last_price_sync', d.now());
    return { count: 0, unchanged: true };
  }
  let rows = parsePricesPayload(body);
  if (!rows.length) throw new Error('price list empty or unreadable; table not changed');
  const seen = new Map();
  for (const r of rows) seen.set(r.code, r); // last duplicate code wins
  rows = [...seen.values()].slice(0, MAX_PRICE_ROWS);

  const now = d.now();
  const sql = 'INSERT INTO prices (code, name, name_am, category, price, stock, updated_at) VALUES (?,?,?,?,?,?,?) ' +
    'ON CONFLICT(code) DO UPDATE SET name=excluded.name, name_am=excluded.name_am, category=excluded.category, ' +
    'price=excluded.price, stock=excluded.stock, updated_at=excluded.updated_at';
  for (let i = 0; i < rows.length; i += 250) { // a batch counts as 1 D1 query; keep the count low
    const stmts = rows.slice(i, i + 250).map((r) =>
      env.DB.prepare(sql).bind(r.code, r.name, r.name_am, r.category, r.price, r.stock, now));
    await env.DB.batch(stmts);
  }
  // Delete old rows only when the new list looks complete.
  let deleted = 0;
  const before = await env.DB.prepare('SELECT COUNT(*) AS n FROM prices WHERE updated_at < ?').bind(now).first();
  const stale = Number(before?.n || 0);
  // Safety: only delete when the new list is at least half of (new + old rows).
  if (rows.length >= 20 && stale > 0 && rows.length >= stale) {
    await env.DB.prepare('DELETE FROM prices WHERE updated_at < ?').bind(now).run();
    deleted = stale;
  } else if (stale > 0) {
    await safeLog(d, env, 'warn', `price sync: kept ${stale} old rows (new list has ${rows.length})`);
  }
  await d.setSetting(env, 'last_price_sync', now);
  await d.setSetting(env, 'last_price_hash', hash);
  return { count: rows.length, deleted };
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- Gemini ----------

async function withTimeout(fn, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try { return await fn(ctl.signal); } finally { clearTimeout(timer); }
}

function parseJsonLoose(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(s); } catch { /* try to cut out the braces */ }
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* fall through */ } }
  return null;
}

// Returns parsed JSON object or null when all models fail.
async function geminiJson(env, d, parts) {
  if (!env.GEMINI_API_KEY) return null;
  for (const model of GEMINI_MODELS) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      const body = JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } });
      const res = await withTimeout((signal) => d.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal }), GEMINI_TIMEOUT_MS);
      if (!res.ok) continue;
      const j = await res.json();
      const obj = parseJsonLoose(j?.candidates?.[0]?.content?.parts?.[0]?.text);
      if (obj && typeof obj === 'object') return obj;
    } catch { /* try next model */ }
  }
  return null;
}

async function understandText(env, d, text) {
  const prompt = T.UNDERSTAND_PROMPT.replace('<<<TEXT>>>', () => String(text).slice(0, 500));
  const r = await geminiJson(env, d, [{ text: prompt }]);
  if (!r) return null;
  return { intent: String(r.intent || 'other'), keywords: cleanKeywords([...(r.keywords || []), ...(r.keywords_am || [])]) };
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function understandPhoto(env, d, token, photos) {
  try {
    const best = photos[photos.length - 1];
    if (best.file_size && best.file_size > MAX_PHOTO_BYTES) return null;
    const file = await d.tg(token, 'getFile', { file_id: best.file_id });
    const res = await withTimeout((signal) => d.fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`, { signal }), GEMINI_TIMEOUT_MS);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_PHOTO_BYTES) return null;
    const r = await geminiJson(env, d, [{ text: T.PHOTO_PROMPT }, { inline_data: { mime_type: 'image/jpeg', data: toBase64(buf) } }]);
    if (!r) return null;
    const keywords = cleanKeywords([...(r.keywords || []), ...String(r.product || '').split(/\s+/)]);
    if (!String(r.product || '').trim()) return null; // spec: not a tool/hardware item -> unclear
    return { keywords };
  } catch { return null; }
}

// ---------- database helpers ----------

// Small candidate query, then JS scoring.
async function searchPrices(env, keywords) {
  const kws = cleanKeywords(keywords);
  if (!kws.length) return [];
  const esc = (k) => k.replace(/[\\%_]/g, (c) => '\\' + c);
  const cols = ['name', 'name_am', 'code', 'category'];
  const conds = [], params = [];
  for (const k of kws) for (const c of cols) { conds.push(`${c} LIKE ? ESCAPE '\\'`); params.push(`%${esc(k)}%`); }
  const sql = `SELECT code, name, name_am, category, price, stock FROM prices WHERE price > 0 AND (${conds.join(' OR ')}) LIMIT 300`;
  const { results } = await env.DB.prepare(sql).bind(...params).all();
  return scoreRows(results || [], kws, 3);
}

async function getChat(env, chatId) {
  return await env.DB.prepare('SELECT chat_id, last_owner_at, last_bot_at, lang FROM chats WHERE chat_id = ?').bind(String(chatId)).first();
}

async function touchChat(env, chatId, field, value) {
  const f = { owner: 'last_owner_at', bot: 'last_bot_at', lang: 'lang' }[field];
  await env.DB.prepare(`INSERT INTO chats (chat_id, ${f}) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET ${f} = excluded.${f}`).bind(String(chatId), value).run();
}

// ---------- main ----------

function withDeps(deps) {
  return {
    tg: deps.tg || tg,
    getSettings: deps.getSettings || getSettings,
    setSetting: deps.setSetting || setSetting,
    logEvent: deps.logEvent || logEvent,
    fetch: deps.fetch || ((...a) => globalThis.fetch(...a)),
    now: deps.now || (() => Math.floor(Date.now() / 1000)),
  };
}

async function safeLog(d, env, level, msg) {
  try { await d.logEvent(env, level, msg); } catch { /* logging must never break the bot */ }
}

function readConnection(settings) {
  let c = settings.answer_connection;
  if (typeof c === 'string') { try { c = JSON.parse(c); } catch { c = null; } }
  return c && typeof c === 'object' ? c : null;
}

async function notifyOwner(env, d, what, who) {
  if (!env.OWNER_ID) return;
  try {
    await d.tg(env.ANSWER_BOT_TOKEN, 'sendMessage', { chat_id: env.OWNER_ID, text: `🤖 Couldn't answer a customer: ${String(what).slice(0, 200)}${who ? ` (from ${String(who).slice(0, 40)})` : ''}` });
  } catch { /* owner may not have pressed /start yet */ }
}

// Works out the reply text for one customer message. Returns {text, notify} or null for "no reply".
async function composeReply(msg, env, d, settings, token) {
  const text = (msg.text || msg.caption || '').trim();
  const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
  if (!text && !hasPhoto) return null; // stickers, voice etc: stay quiet
  const chatId = msg.chat.id;
  const known = await getChat(env, chatId);
  const lang = text ? detectLang(text) : (known?.lang === 'en' ? 'en' : 'am');
  if (text && known?.lang !== lang) await touchChat(env, chatId, 'lang', lang);

  if (!hasPhoto) {
    if (isGreeting(text)) return { text: T.GREETING[lang] };
    if (isLocationQuestion(text)) return { text: locationReply(lang, settings) };
  }

  let keywords = [], kind = 'text';
  if (hasPhoto) {
    kind = 'photo';
    const p = await understandPhoto(env, d, token, msg.photo);
    if (!p || !p.keywords.length) return { text: T.PHOTO_UNCLEAR[lang], notify: text || 'photo' };
    keywords = p.keywords;
    if (text) keywords = cleanKeywords([...keywords, ...fallbackKeywords(text)]);
  } else {
    const u = await understandText(env, d, text);
    if (u && u.intent === 'greeting') return { text: T.GREETING[lang] };
    if (u && u.intent === 'location') return { text: locationReply(lang, settings) };
    // "ok thanks", "I'll come tomorrow"...: not a product question, stay quiet (owner sees the chat).
    if (u && u.intent === 'other' && !u.keywords.length) return null;
    keywords = u && u.keywords.length ? u.keywords : fallbackKeywords(text);
    if (u && u.keywords.length) keywords = cleanKeywords([...keywords, ...fallbackKeywords(text).filter((w) => /[ሀ-፿]/.test(w))]);
  }
  const rows = await searchPrices(env, keywords);
  const reply = buildReply({ lang, kind, rows, settings });
  return rows.length ? { text: reply } : { text: reply, notify: text || 'photo' };
}

export async function handleAnswerUpdate(update, env, ctx, deps = {}) {
  const d = withDeps(deps);
  const token = env.ANSWER_BOT_TOKEN;
  if (!token || !update) return;
  const ownerId = String(env.OWNER_ID || '');
  try {
    // Owner connected / changed the business connection.
    if (update.business_connection) {
      const bc = update.business_connection;
      if (!ownerId || String(bc.user?.id) !== ownerId) return;
      await d.setSetting(env, 'answer_connection', {
        id: bc.id, user_id: bc.user.id,
        can_reply: bc.rights?.can_reply ?? bc.can_reply ?? false,
        enabled: !!bc.is_enabled,
      });
      return;
    }

    const bm = update.business_message;
    const dm = update.message;
    const msg = bm || dm;
    if (!msg || !msg.chat || !msg.from) return;
    const settings = await d.getSettings(env);
    const fromOwner = ownerId && String(msg.from.id) === ownerId;

    if (bm) {
      if (!settings.answer_enabled) return;
      if (msg.sender_business_bot) return; // a bot's own reply sent on the owner's behalf
      const conn = readConnection(settings);
      if (!conn || !conn.enabled || conn.can_reply === false || msg.business_connection_id !== conn.id) return;
      if (fromOwner) { await touchChat(env, msg.chat.id, 'owner', d.now()); return; }
    } else {
      // Normal message to the answer bot itself.
      if (msg.chat.type && msg.chat.type !== 'private') return;
      if (fromOwner) {
        if ((msg.text || '').trim().toLowerCase().startsWith('/start')) {
          await d.tg(token, 'sendMessage', { chat_id: msg.chat.id, text: '✅ Notifications are on. I will message you here when I cannot answer a customer.' });
        }
        return;
      }
      if (!settings.answer_enabled) return;
    }
    if (msg.from.is_bot) return;

    const now = d.now();
    const chat = await getChat(env, msg.chat.id);
    const handoff = Number(settings.answer_handoff_minutes ?? 120) * 60;
    if (bm && chat?.last_owner_at && now - chat.last_owner_at < handoff) return; // owner is handling this chat
    // Albums arrive as many messages at the same moment: claim the chat first, answer only once.
    if (msg.media_group_id) {
      const claim = await env.DB.prepare('INSERT INTO chats (chat_id, last_bot_at) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET last_bot_at = excluded.last_bot_at WHERE chats.last_bot_at IS NULL OR chats.last_bot_at < ?')
        .bind(String(msg.chat.id), now, now - 30).run();
      if (!claim?.meta?.changes) return;
    }

    const out = await composeReply(msg, env, d, settings, token);
    if (!out) return;
    const body = { chat_id: msg.chat.id, text: out.text, parse_mode: 'HTML' };
    if (bm) body.business_connection_id = msg.business_connection_id;
    await d.tg(token, 'sendMessage', body);
    await touchChat(env, msg.chat.id, 'bot', now);
    if (out.notify) await notifyOwner(env, d, out.notify, msg.from.first_name);
  } catch (e) {
    await safeLog(d, env, 'error', `answer bot: ${String(e?.message || e).slice(0, 200)}`);
  }
}
