// Small pure helpers: time, sound rule, buttons, html, signing.

const ADDIS_OFFSET_MS = 3 * 3600 * 1000; // Addis Ababa = UTC+3, no DST

// Current Addis date and time.
export function addisNow(date = new Date()) {
  const d = new Date(date.getTime() + ADDIS_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return {
    day: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
    minutes: h * 60 + m,
    hhmm: `${p(h)}:${p(m)}`,
  };
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// "HH:MM" -> minutes since midnight (null if bad).
export function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}

// Is `minutes` inside the window [start, end)? The window may cross midnight.
export function inWindow(minutes, start, end) {
  const a = hhmmToMin(start), b = hhmmToMin(end);
  if (a === null || b === null || a === b) return false;
  return a < b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
}

// Decide if a post should have sound. Pure function.
export function decideSound({
  minutes, sound_mode, sound_max, sound_slots, quiet_start, quiet_end, loud_count, used_slots,
}) {
  if (inWindow(minutes, quiet_start, quiet_end)) return { loud: false, use_slots: [] };
  if (sound_mode === 'silent') return { loud: false, use_slots: [] };
  if (sound_mode === 'sound') return { loud: true, use_slots: [] };
  // auto mode
  if ((loud_count || 0) >= (sound_max ?? 0)) return { loud: false, use_slots: [] };
  const used = new Set(used_slots || []);
  const passed = (sound_slots || []).filter((t) => {
    const m = hhmmToMin(t);
    return m !== null && m <= minutes && !used.has(t);
  });
  if (passed.length === 0) return { loud: false, use_slots: [] };
  return { loud: true, use_slots: passed };
}

// Buttons under a single-photo post.
export function buildButtons(settings, publicUrl) {
  const base = String(publicUrl || '').replace(/\/+$/, '');
  const user = String(settings.text_username || '').replace(/^@/, '');
  // t.me/+<phone> opens the shop's Telegram profile in-app (no 'Open this link?' popup);
  // tapping the number there gives 'Call via Carrier'. Needs the number visible to everyone.
  const phone = String(settings.phone || '').replace(/[^0-9]/g, '');
  const rows = [[
    { text: '💬 Text', url: `https://t.me/${user}` },
    { text: '📞 Call', url: phone ? `https://t.me/+${phone}` : `${base}/call` },
  ]];
  if (settings.website_url) rows.push([{ text: '🌐 Visit our website', url: settings.website_url }]);
  return { inline_keyboard: rows };
}

// Turn caption HTML into plain text (for Facebook).
export function stripHtml(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

// First 32 hex chars of HMAC-SHA256(key, data).
export async function hmacSig(key, data) {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(String(key)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(String(data)));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// Constant-time string compare.
export function safeEqual(a, b) {
  a = String(a ?? ''); b = String(b ?? '');
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Check "Authorization: Bearer <key>" against the secret.
export function readerAuthOk(authHeader, key) {
  if (!key) return false;
  const m = /^Bearer\s+(.+)$/i.exec(String(authHeader || ''));
  if (!m) return false;
  return safeEqual(m[1].trim(), key);
}

// "12 min ago" style text from seconds.
export function agoText(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return 'never';
  if (seconds < 90) return 'just now';
  const min = Math.round(seconds / 60);
  if (min < 90) return `${min} min ago`;
  const h = Math.round(seconds / 3600);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}
