// ROHA reposter Worker: routes + cron.
import { getSettings, getState, setState, logEvent, nowSec } from './db.js';
import { handleUpdate as panelUpdate, sendApproval } from './panel.js';
import { callPage } from './pages.js';
import { handleAnswerUpdate } from './answer.js';
import { runCron } from './publisher.js';
import { hmacSig, safeEqual, readerAuthOk } from './util.js';
import { fetchTgFile } from './telegram.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const text = (t, status = 200) => new Response(t, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

// Telegram sends our secret in this header.
function webhookOk(request, secret) {
  return Boolean(secret) && safeEqual(request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', secret);
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

// ---------- reader API ----------

const CONFIG_KEYS = [
  'running', 'sources', 'watermark', 'watermark_size', 'watermark_opacity', 'contact_block',
  'max_posts_per_run', 'max_posts_per_channel_per_run', 'first_run_take_last', 'duplicate_days',
  'collect_start', 'collect_end',
];

async function readerConfig(env) {
  const s = await getSettings(env);
  const out = {};
  for (const k of CONFIG_KEYS) out[k] = s[k];
  out.last_ids = await getState(env, 'last_ids', {});
  out.hashes = await getState(env, 'hashes', []);
  return json(out);
}

async function readerItem(request, env, ctx) {
  const b = await readJson(request);
  if (!b || typeof b !== 'object') return json({ error: 'bad json' }, 400);
  const ids = b.file_ids;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10 || !ids.every((x) => typeof x === 'string' && x)) {
    return json({ error: 'file_ids must be 1 to 10 strings' }, 400);
  }
  if (typeof b.caption_html !== 'string') return json({ error: 'caption_html required' }, 400);
  const s = await getSettings(env);
  const risky = b.risky ? 1 : 0;
  const pending = s.approval_mode || (risky && !s.auto_publish_risky);
  const status = pending ? 'pending_approval' : 'queued';
  const notes = Array.isArray(b.notes) ? b.notes.join('\n') : String(b.notes ?? '');
  const res = await env.DB.prepare(
    'INSERT INTO queue (created_at, status, name, caption_html, file_ids, source, src_link, risky, notes, hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
  ).bind(nowSec(), status, String(b.name ?? '').slice(0, 200), b.caption_html, JSON.stringify(ids),
    String(b.source ?? ''), String(b.src_link ?? ''), risky, notes.slice(0, 1000), String(b.hash ?? '')).run();
  const id = res.meta?.last_row_id;
  if (pending) {
    const item = { id, name: b.name, file_ids: ids, source: b.source, src_link: b.src_link, risky, notes };
    ctx.waitUntil(sendApproval(env, item).catch((e) => logEvent(env, 'error', `approval #${id}: ${e.message}`)));
  }
  return json({ id, status });
}

async function readerState(request, env) {
  const b = await readJson(request);
  if (!b || typeof b !== 'object') return json({ error: 'bad json' }, 400);
  const s = await getSettings(env);
  if (b.last_ids && typeof b.last_ids === 'object') {
    const merged = { ...(await getState(env, 'last_ids', {})), ...b.last_ids };
    await setState(env, 'last_ids', merged);
  }
  if (Array.isArray(b.hashes)) {
    const cutoff = nowSec() - s.duplicate_days * 86400;
    const map = new Map();
    for (const [h, t] of [...(await getState(env, 'hashes', [])), ...b.hashes]) {
      if (typeof h === 'string' && Number(t) >= cutoff && !(map.get(h) >= t)) map.set(h, Number(t));
    }
    await setState(env, 'hashes', [...map.entries()]);
  }
  await setState(env, 'heartbeat', nowSec());
  if (b.stats && typeof b.stats === 'object') await setState(env, 'last_stats', b.stats);
  return json({ ok: true });
}

// ---------- signed photo proxy ----------

async function imgProxy(url, env) {
  const fileId = decodeURIComponent(url.pathname.slice('/img/'.length));
  const sig = url.searchParams.get('s') || '';
  if (!fileId || !env.IMG_SIGN_KEY || !safeEqual(sig, await hmacSig(env.IMG_SIGN_KEY, fileId))) {
    return text('forbidden', 403);
  }
  try {
    const r = await fetchTgFile(env.REPOSTER_BOT_TOKEN, fileId);
    if (!r.ok) return text('not found', 404);
    return new Response(r.body, {
      headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' },
    });
  } catch {
    return text('not found', 404);
  }
}

// ---------- router ----------

async function handleFetch(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (method === 'GET' && path === '/') return text('ROHA reposter OK');

  if (method === 'POST' && path === '/tg/reposter') {
    if (!webhookOk(request, env.WEBHOOK_SECRET)) return text('forbidden', 403);
    const update = await readJson(request);
    if (update) ctx.waitUntil(panelUpdate(update, env, ctx).catch((e) => logEvent(env, 'error', `panel: ${e.message}`)));
    return text('ok');
  }

  if (method === 'POST' && path === '/tg/answer') {
    if (!webhookOk(request, env.ANSWER_WEBHOOK_SECRET)) return text('forbidden', 403);
    if (!env.ANSWER_BOT_TOKEN) return text('ok');
    const update = await readJson(request);
    if (update) ctx.waitUntil(handleAnswerUpdate(update, env, ctx).catch((e) => logEvent(env, 'error', `answer: ${e.message}`)));
    return text('ok');
  }

  if (path.startsWith('/api/reader/')) {
    if (!readerAuthOk(request.headers.get('Authorization'), env.READER_KEY)) return text('unauthorized', 401);
    if (method === 'GET' && path === '/api/reader/config') return readerConfig(env);
    if (method === 'POST' && path === '/api/reader/item') return readerItem(request, env, ctx);
    if (method === 'POST' && path === '/api/reader/state') return readerState(request, env);
    return text('not found', 404);
  }

  if (method === 'GET' && path === '/call') return callPage(await getSettings(env));
  if (method === 'GET' && path.startsWith('/img/')) return imgProxy(url, env);
  return text('not found', 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await handleFetch(request, env, ctx);
    } catch (e) {
      await logEvent(env, 'error', `fetch: ${e.message}`);
      return text('error', 500);
    }
  },
  async scheduled(event, env, ctx) {
    await runCron(env, ctx);
  },
};
