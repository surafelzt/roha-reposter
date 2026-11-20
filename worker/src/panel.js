// Owner-only control panel for @Rohareposterbot, plus approval messages.
import { getSettings, setSetting, getDaily, getState, nowSec } from './db.js';
import { tg, TgError } from './telegram.js';
import { addisNow, agoText } from './util.js';
import { fbConfigured } from './facebook.js';

// Limits shown in the Limits view: [code, setting key, label, step, min, max]
export const LIMITS = [
  ['cap', 'daily_cap', 'Daily cap (0 = no cap)', 10, 0, 1000],
  ['gap', 'publish_gap_min', 'Minutes between posts', 1, 1, 60],
  ['snd', 'sound_max', 'Sound posts per day', 1, 0, 10],
  ['fb', 'fb_daily_max', 'Facebook posts per day', 1, 0, 50],
];

// ---------- pure helpers ----------

export function fromId(update) {
  return (update?.message || update?.callback_query || {}).from?.id;
}

export function isOwner(update, env) {
  const id = fromId(update);
  return Boolean(env.OWNER_ID) && id !== undefined && String(id) === String(env.OWNER_ID);
}

// "@name", "t.me/name", "https://t.me/name" -> "@name".
// A -100... id, or the exact name of a private channel/group (as the spare account sees it), is kept as is.
// Invite links are refused: the reader needs the name, not the link.
export function normalizeSource(text) {
  const t = String(text ?? '').trim();
  if (/(?:t|telegram)\.me\/(?:\+|joinchat\/)/i.test(t)) return null; // invite link
  const m = /^(?:https?:\/\/)?(?:(?:www\.)?(?:t|telegram)\.me\/)?@?([A-Za-z][A-Za-z0-9_]{3,31})(?:\/\S*)?$/.exec(t);
  if (m && !/\s/.test(t)) return '@' + m[1];
  if (/^-100\d{5,}$/.test(t)) return t;
  if (!t || t.startsWith('@') || t.startsWith('/') || /(?:t|telegram)\.me\//i.test(t) || t.length > 128) return null;
  return t;
}

export function clampStep(value, dir, step, min, max) {
  const v = Number(value) + (dir === 'u' ? step : -step);
  return Math.max(min, Math.min(max, v));
}

export function soundLabel(s) {
  if (s.sound_mode === 'silent') return '🔕 All silent';
  if (s.sound_mode === 'sound') return '🔔 All with sound';
  return `🔔 Sound: Auto ${s.sound_max}/day`;
}

const onOff = (b) => (b ? 'On' : 'Off');

export function panelKeyboard(s) {
  return {
    inline_keyboard: [
      [{ text: s.running ? '▶️ Running' : '⏸ Stopped', callback_data: 't:run' }],
      [{ text: soundLabel(s), callback_data: 't:snd' }],
      [{ text: `💧 Watermark: ${onOff(s.watermark)}`, callback_data: 't:wm' },
        { text: `✅ Approval: ${onOff(s.approval_mode)}`, callback_data: 't:ap' }],
      [{ text: '📡 Sources', callback_data: 'v:src' }, { text: '⚙️ Limits', callback_data: 'v:lim' }],
      [{ text: `📘 Facebook: ${onOff(s.fb_enabled)}`, callback_data: 't:fb' },
        { text: `🤖 Answer bot: ${onOff(s.answer_enabled)}`, callback_data: 't:an' }],
      [{ text: '📊 Status', callback_data: 'v:stat' }, { text: '🔄 Refresh', callback_data: 'v:main' }],
    ],
  };
}

// Panel text in plain words. `d` = numbers from the database.
export function panelText(s, d, detail = false) {
  const lines = ['ROHA Reposter', ''];
  lines.push(`Status: ${s.running ? '▶️ Running' : '⏸ Stopped'}`);
  lines.push(`Queue: ${d.queued} waiting to post, ${d.pending} waiting for your OK`);
  const loud = s.sound_mode === 'auto' ? `${d.loud}/${s.sound_max}` : String(d.loud);
  lines.push(`Posted today: ${d.posted} (with sound ${loud})`);
  lines.push(`Reader last ran: ${d.heartbeat ? agoText(d.now - d.heartbeat) : 'never'}`);
  if (d.lastError) lines.push(`Last problem: ${d.lastError}`);
  if (detail) {
    lines.push('');
    lines.push(`Sources: ${s.sources.length}`);
    lines.push(`Sound mode: ${soundLabel(s)}`);
    lines.push(`Gap: ${s.publish_gap_min} min, daily cap: ${s.daily_cap || 'none'}`);
    lines.push(`Facebook today: ${d.fb}/${s.fb_daily_max} (${onOff(s.fb_enabled)})`);
    lines.push(`Failed posts: ${d.failed}`);
    if (d.stats) {
      const st = d.stats;
      lines.push(`Last reader run: checked ${st.checked ?? 0}, queued ${st.queued ?? 0}, skipped ${st.skipped ?? 0}, errors ${st.errors ?? 0}`);
    }
  }
  return lines.join('\n');
}

export function sourcesView(s, note = '') {
  // By position, not name: Telegram allows only 64 bytes here and long (Amharic) names are bigger.
  const rows = s.sources.map((n, i) => [{ text: `❌ ${n}`, callback_data: `rx:${i}` }]);
  rows.push([{ text: '➕ Add source', callback_data: 'as' }]);
  rows.push([{ text: '⬅️ Back', callback_data: 'v:main' }]);
  const head = s.sources.length ? `Sources (${s.sources.length}). Tap a name to remove it.` : 'No sources yet.';
  return { text: (note ? note + '\n\n' : '') + head, markup: { inline_keyboard: rows } };
}

export function limitsView(s) {
  const lines = ['Limits', ''];
  const rows = [];
  for (const [code, key, label, , , ] of LIMITS) {
    lines.push(`${label}: ${s[key]}`);
    rows.push([
      { text: `➖ ${label.split(' (')[0]}`, callback_data: `l:${code}:d` },
      { text: '➕', callback_data: `l:${code}:u` },
    ]);
  }
  rows.push([{ text: '⬅️ Back', callback_data: 'v:main' }]);
  return { text: lines.join('\n'), markup: { inline_keyboard: rows } };
}

// ---------- database numbers ----------

async function panelData(env, s) {
  const { day } = addisNow();
  const daily = await getDaily(env, day);
  const counts = await env.DB.prepare('SELECT status, COUNT(*) AS n FROM queue GROUP BY status').all();
  const c = {};
  for (const r of counts.results || []) c[r.status] = r.n;
  const err = await env.DB.prepare("SELECT msg FROM log WHERE level = 'error' ORDER BY id DESC LIMIT 1").first();
  const hb = Number(await getState(env, 'heartbeat', 0)) || 0;
  return {
    queued: c.queued || 0, pending: c.pending_approval || 0, failed: c.failed || 0,
    posted: daily.posted || 0, loud: daily.loud || 0, fb: daily.fb || 0,
    heartbeat: hb, now: nowSec(), stats: await getState(env, 'last_stats', null),
    lastError: err?.msg ? String(err.msg).slice(0, 150) : '',
  };
}

async function mainView(env, s, detail = false) {
  const d = await panelData(env, s);
  return { text: panelText(s, d, detail), markup: panelKeyboard(s) };
}

// ---------- Telegram helpers ----------

async function editView(env, chatId, msgId, view) {
  try {
    await tg(env.REPOSTER_BOT_TOKEN, 'editMessageText', {
      chat_id: chatId, message_id: msgId, text: view.text, reply_markup: view.markup,
    });
  } catch (e) {
    if (!(e instanceof TgError && /not modified/i.test(e.description))) throw e;
  }
}

const send = (env, chatId, text, markup) =>
  tg(env.REPOSTER_BOT_TOKEN, 'sendMessage', { chat_id: chatId, text, ...(markup ? { reply_markup: markup } : {}) });

const HELP = 'Commands:\n/panel - open the control panel\n/status - short status\n/cancel - stop what I asked you to type\n/help - this list';

// ---------- entry point ----------

export async function handleUpdate(update, env, ctx) {
  if (!isOwner(update, env)) return; // silently ignore everybody else
  try {
    if (update.callback_query) await handleCallback(update.callback_query, env);
    else if (update.message) await handleMessage(update.message, env);
  } catch (e) {
    if (update.callback_query) {
      try { await tg(env.REPOSTER_BOT_TOKEN, 'answerCallbackQuery', { callback_query_id: update.callback_query.id, text: 'Something went wrong' }); } catch { /* ignore */ }
    }
  }
}

async function handleMessage(msg, env) {
  const chatId = msg.chat.id;
  const text = String(msg.text || '').trim();
  const cmd = text.startsWith('/') ? text.split(/[\s@]/)[0].toLowerCase() : '';
  const s = await getSettings(env);

  if (cmd === '/cancel') {
    await setSetting(env, 'await_input', null);
    return void (await send(env, chatId, 'Cancelled.'));
  }
  if (cmd === '/start' || cmd === '/panel') {
    await setSetting(env, 'await_input', null);
    const v = await mainView(env, s);
    return void (await send(env, chatId, v.text, v.markup));
  }
  if (cmd === '/status') {
    const v = await mainView(env, s, true);
    return void (await send(env, chatId, v.text));
  }
  if (cmd === '/help') return void (await send(env, chatId, HELP));

  if (s.await_input === 'add_source' && text) {
    const name = normalizeSource(text);
    if (!name) return void (await send(env, chatId, "That doesn't look right. Send @channelname, or the exact name of a private channel or group (not the invite link), or /cancel."));
    const exists = s.sources.some((x) => x.toLowerCase() === name.toLowerCase());
    if (!exists) s.sources.push(name);
    await setSetting(env, 'sources', s.sources);
    await setSetting(env, 'await_input', null);
    const v = sourcesView(s, exists ? `${name} was already in the list.` : `Added ${name}.`);
    return void (await send(env, chatId, v.text, v.markup));
  }
  if (text) await send(env, chatId, 'Send /panel to open the control panel.');
}

async function handleCallback(cb, env) {
  const data = String(cb.data || '');
  const chatId = cb.message?.chat?.id;
  const msgId = cb.message?.message_id;
  const token = env.REPOSTER_BOT_TOKEN;
  let toast = '';
  const s = await getSettings(env);

  const show = async (view) => { if (chatId && msgId) await editView(env, chatId, msgId, view); };
  const showMain = async (detail = false) => show(await mainView(env, s, detail));

  if (data.startsWith('t:')) {
    const k = data.slice(2);
    if (k === 'run') { s.running = !s.running; await setSetting(env, 'running', s.running); }
    else if (k === 'snd') {
      const next = { auto: 'silent', silent: 'sound', sound: 'auto' }[s.sound_mode] || 'auto';
      s.sound_mode = next; await setSetting(env, 'sound_mode', next);
    } else if (k === 'wm') { s.watermark = !s.watermark; await setSetting(env, 'watermark', s.watermark); }
    else if (k === 'ap') { s.approval_mode = !s.approval_mode; await setSetting(env, 'approval_mode', s.approval_mode); }
    else if (k === 'fb') {
      const ready = fbConfigured(env);
      if (!s.fb_enabled && !ready) toast = 'Facebook is not set up yet';
      else { s.fb_enabled = !s.fb_enabled; await setSetting(env, 'fb_enabled', s.fb_enabled); }
    } else if (k === 'an') {
      if (!s.answer_enabled && !env.ANSWER_BOT_TOKEN) toast = 'Answer bot is not set up yet';
      else { s.answer_enabled = !s.answer_enabled; await setSetting(env, 'answer_enabled', s.answer_enabled); }
    }
    await showMain();
  } else if (data === 'v:main') await showMain();
  else if (data === 'v:stat') await showMain(true);
  else if (data === 'v:src') await show(sourcesView(s));
  else if (data === 'v:lim') await show(limitsView(s));
  else if (data === 'as') {
    await setSetting(env, 'await_input', 'add_source');
    if (chatId) await send(env, chatId, 'Send the channel @username, or the exact name of a private channel or group (or /cancel).');
  } else if (data.startsWith('rx:')) {
    const i = Number(data.slice(3));
    const name = s.sources[i];
    if (name !== undefined) { s.sources.splice(i, 1); await setSetting(env, 'sources', s.sources); }
    await show(sourcesView(s, name !== undefined ? `Removed ${name}.` : 'List changed, try again.'));
  } else if (data.startsWith('rs:')) { // old buttons sent before 20 Nov
    const name = '@' + data.slice(3);
    const before = s.sources.length;
    s.sources = s.sources.filter((x) => x.toLowerCase() !== name.toLowerCase());
    if (s.sources.length !== before) await setSetting(env, 'sources', s.sources);
    await show(sourcesView(s, `Removed ${name}.`));
  } else if (data.startsWith('l:')) {
    const [, code, dir] = data.split(':');
    const lim = LIMITS.find((x) => x[0] === code);
    if (lim) {
      const [, key, , step, min, max] = lim;
      s[key] = clampStep(s[key], dir, step, min, max);
      await setSetting(env, key, s[key]);
    }
    await show(limitsView(s));
  } else if (data.startsWith('ap:') || data.startsWith('sk:')) {
    toast = await decideApproval(env, cb, Number(data.slice(3)), data.startsWith('ap:'));
  }

  await tg(token, 'answerCallbackQuery', { callback_query_id: cb.id, ...(toast ? { text: toast } : {}) });
}

// ---------- approvals ----------

// Owner taps ✅ or ❌. Returns a short toast text.
async function decideApproval(env, cb, id, approve) {
  const item = await env.DB.prepare('SELECT * FROM queue WHERE id = ?').bind(id).first();
  if (!item || item.status !== 'pending_approval') return 'Already decided';
  const res = await env.DB.prepare("UPDATE queue SET status = ? WHERE id = ? AND status = 'pending_approval'")
    .bind(approve ? 'queued' : 'skipped', id).run();
  if (res?.meta && res.meta.changes === 0) return 'Already decided';
  const text = approve ? `✅ Will be posted: ${item.name || '#' + id}` : `❌ Skipped: ${item.name || '#' + id}`;
  if (cb.message) {
    await tg(env.REPOSTER_BOT_TOKEN, 'editMessageText', {
      chat_id: cb.message.chat.id, message_id: cb.message.message_id, text, reply_markup: { inline_keyboard: [] },
    }).catch(() => {});
  }
  return approve ? 'Queued' : 'Skipped';
}

// Send photos + the ✅/❌ message to the owner for one pending item.
export async function sendApproval(env, item) {
  const token = env.REPOSTER_BOT_TOKEN;
  if (!token || !env.OWNER_ID) return;
  const ids = Array.isArray(item.file_ids) ? item.file_ids : JSON.parse(item.file_ids || '[]');
  if (ids.length === 1) await tg(token, 'sendPhoto', { chat_id: env.OWNER_ID, photo: ids[0] });
  else if (ids.length > 1) await tg(token, 'sendMediaGroup', { chat_id: env.OWNER_ID, media: ids.map((m) => ({ type: 'photo', media: m })) });
  const notes = Array.isArray(item.notes) ? item.notes.join('\n') : String(item.notes || '');
  const lines = [`🆕 Waiting for your OK (#${item.id})`, `Item: ${item.name || '(no name)'}`];
  if (item.src_link || item.source) lines.push(`From: ${item.src_link || item.source}`);
  if (item.risky) lines.push('⚠️ Marked risky');
  if (notes) lines.push(`Notes: ${notes}`);
  const sent = await tg(token, 'sendMessage', {
    chat_id: env.OWNER_ID,
    text: lines.join('\n').slice(0, 3800),
    reply_markup: { inline_keyboard: [[
      { text: '✅ Post', callback_data: `ap:${item.id}` },
      { text: '❌ Skip', callback_data: `sk:${item.id}` },
    ]] },
  });
  await env.DB.prepare('UPDATE queue SET approval_chat_id = ?, approval_msg_id = ? WHERE id = ?')
    .bind(sent.chat.id, sent.message_id, item.id).run();
}
