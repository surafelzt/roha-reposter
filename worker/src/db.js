// D1 helpers and settings with defaults.

export const DEFAULTS = {
  running: true,
  approval_mode: false,
  auto_publish_risky: false,
  watermark: true,
  watermark_size: 0.62,
  watermark_opacity: 0.15,
  // The real source list lives only in the database (panel: Sources), so this code can be public.
  sources: [],
  contact_block: '👇 ለማዘዝ ይደውሉልን 👇\n\n📱 Phone: 0989897171\n📩 Telegram: @Rohatool\n📍 Mexico, Senga tera Traders Union Building',
  sound_mode: 'auto',
  sound_max: 5,
  sound_slots: ['09:00', '12:00', '15:00', '18:00', '20:00'],
  quiet_start: '22:00',
  quiet_end: '07:00',
  publish_gap_min: 2,
  daily_cap: 0,
  buttons_enabled: true,
  phone: '+251989897171',
  phone_display: '0989897171',
  text_username: 'Rohatool',
  website_url: '',
  fb_enabled: false,
  fb_daily_max: 10,
  collect_start: '06:00',
  collect_end: '22:00',
  max_posts_per_run: 60,
  max_posts_per_channel_per_run: 20,
  first_run_take_last: 3,
  duplicate_days: 30,
  answer_enabled: false,
  answer_handoff_minutes: 120,
  address_en: 'Mexico, Senga Tera Traders Union Building, Addis Ababa',
  address_am: 'ሜክሲኮ፣ ሰንጋ ተራ ነጋዴዎች ማህበር ህንፃ፣ አዲስ አበባ',
};

export const nowSec = () => Math.floor(Date.now() / 1000);

function sameKind(a, b) {
  if (Array.isArray(a)) return Array.isArray(b);
  return typeof a === typeof b;
}

// All settings, defaults applied. Bad stored values fall back to the default.
export async function getSettings(env) {
  const out = structuredClone(DEFAULTS);
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  for (const r of rows.results || []) {
    let v;
    try { v = JSON.parse(r.value); } catch { continue; }
    if (r.key in DEFAULTS && !sameKind(DEFAULTS[r.key], v)) continue;
    out[r.key] = v;
  }
  return out;
}

export async function setSetting(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(key, JSON.stringify(value ?? null)).run();
}

// Write a log line; keep only the newest 500. Never throws.
export async function logEvent(env, level, msg) {
  try {
    await env.DB.prepare('INSERT INTO log (at, level, msg) VALUES (?, ?, ?)')
      .bind(nowSec(), level, String(msg).slice(0, 500)).run();
    await env.DB.prepare('DELETE FROM log WHERE id <= (SELECT MAX(id) FROM log) - 500').run();
  } catch { /* logging must never break the app */ }
}

// reader_state helpers (values are JSON).
export async function getState(env, key, fallback = null) {
  const row = await env.DB.prepare('SELECT value FROM reader_state WHERE key = ?').bind(key).first();
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}

export async function setState(env, key, value) {
  await env.DB.prepare(
    'INSERT INTO reader_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).bind(key, JSON.stringify(value)).run();
}

// Today's counters row (created if missing).
export async function getDaily(env, day) {
  await env.DB.prepare('INSERT OR IGNORE INTO daily (day) VALUES (?)').bind(day).run();
  const row = await env.DB.prepare('SELECT * FROM daily WHERE day = ?').bind(day).first();
  let used = [];
  try { used = JSON.parse(row.used_slots || '[]'); } catch { /* keep [] */ }
  return { ...row, used_slots: used };
}
