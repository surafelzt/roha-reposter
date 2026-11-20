// Cron jobs: publisher (1 post per tick), webhook check, health alert, price sync, log trim.
import { getSettings, setSetting, logEvent, getState, getDaily, nowSec } from './db.js';
import { tg, TgError, notifyOwner } from './telegram.js';
import { addisNow, decideSound, buildButtons, inWindow, agoText, hhmmToMin } from './util.js';
import { fbConfigured, postToFacebook } from './facebook.js';

export async function runCron(env, ctx) {
  const jobs = [
    ['publish', publishOne],
    ['webhooks', ensureWebhooks],
    ['health', healthCheck],
    ['prices', syncPricesJob],
    ['trim', trimLog],
  ];
  for (const [name, fn] of jobs) {
    try { await fn(env); } catch (e) { await logEvent(env, 'error', `cron ${name}: ${e.message}`); }
  }
}

// Post the oldest queued item if the rules allow. Returns a short status word.
export async function publishOne(env, now = new Date()) {
  const s = await getSettings(env);
  if (!s.running) return 'stopped';
  if (!env.REPOSTER_BOT_TOKEN || !env.CHANNEL_ID) return 'not set up';
  const { day, minutes } = addisNow(now);
  const t = Math.floor(now.getTime() / 1000);
  const daily = await getDaily(env, day);
  if (s.daily_cap > 0 && daily.posted >= s.daily_cap) return 'daily cap';

  // Last post time is kept in settings (a MAX() over all posted rows would eat the free D1 read quota).
  const lastT = Number(s.last_post_at) || 0;
  // 45 s of slack, because cron ticks never land on exact seconds
  if (lastT && lastT > t - s.publish_gap_min * 60 + 45) return 'gap';

  const item = await env.DB.prepare("SELECT * FROM queue WHERE status = 'queued' ORDER BY id LIMIT 1").first();
  if (!item) return 'empty';

  let fileIds;
  try { fileIds = JSON.parse(item.file_ids); } catch { fileIds = []; }
  if (!Array.isArray(fileIds) || fileIds.length < 1 || fileIds.length > 10) {
    await env.DB.prepare("UPDATE queue SET status = 'failed', error = ? WHERE id = ?").bind('bad file_ids', item.id).run();
    return 'bad item';
  }

  const sound = decideSound({
    minutes, sound_mode: s.sound_mode, sound_max: s.sound_max, sound_slots: s.sound_slots,
    quiet_start: s.quiet_start, quiet_end: s.quiet_end, loud_count: daily.loud, used_slots: daily.used_slots,
  });

  let msgId;
  try {
    msgId = await postToChannel(env, s, item, fileIds, sound.loud);
  } catch (e) {
    if (e instanceof TgError && e.code === 429) {
      await logEvent(env, 'warn', `telegram 429, retry after ${e.retry_after}s`);
      return 'rate limited';
    }
    const tries = (item.tries || 0) + 1;
    const failed = tries >= 3;
    await env.DB.prepare('UPDATE queue SET tries = ?, error = ?, status = ? WHERE id = ?')
      .bind(tries, String(e.message).slice(0, 300), failed ? 'failed' : 'queued', item.id).run();
    await logEvent(env, 'error', `post #${item.id} try ${tries}: ${e.message}`);
    if (failed) await notifyOwner(env, `⚠️ A post failed 3 times and was dropped (#${item.id} ${item.name || ''}).\n${String(e.message).slice(0, 200)}`);
    return 'error';
  }

  // Success: save it right away so it can never be posted twice.
  const used = [...new Set([...daily.used_slots, ...sound.use_slots])];
  await env.DB.batch([
    env.DB.prepare("UPDATE queue SET status = 'posted', posted_at = ?, channel_msg_id = ?, silent = ?, error = NULL WHERE id = ?")
      .bind(t, msgId, sound.loud ? 0 : 1, item.id),
    env.DB.prepare('UPDATE daily SET posted = posted + 1, loud = loud + ?, used_slots = ? WHERE day = ?')
      .bind(sound.loud ? 1 : 0, JSON.stringify(sound.loud ? used : daily.used_slots), day),
    env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .bind('last_post_at', JSON.stringify(t)),
  ]);

  await tryFacebook(env, s, item, fileIds, daily, day);
  return 'posted';
}

// Send to the channel. Returns the message id (first one for albums).
async function postToChannel(env, s, item, fileIds, loud) {
  const token = env.REPOSTER_BOT_TOKEN;
  const caption = item.caption_html || '';
  if (fileIds.length === 1) {
    const body = {
      chat_id: env.CHANNEL_ID, photo: fileIds[0], caption, parse_mode: 'HTML', disable_notification: !loud,
    };
    if (s.buttons_enabled) body.reply_markup = buildButtons(s, env.PUBLIC_URL);
    const r = await tg(token, 'sendPhoto', body);
    return r.message_id;
  }
  const media = fileIds.map((id, i) => (i === 0
    ? { type: 'photo', media: id, caption, parse_mode: 'HTML' }
    : { type: 'photo', media: id }));
  const r = await tg(token, 'sendMediaGroup', { chat_id: env.CHANNEL_ID, media, disable_notification: !loud });
  return r[0]?.message_id;
}

// Facebook never blocks or fails the Telegram post.
async function tryFacebook(env, s, item, fileIds, daily, day) {
  if (!s.fb_enabled || !fbConfigured(env) || daily.fb >= s.fb_daily_max) return;
  try {
    const id = await postToFacebook(env, item, fileIds);
    await env.DB.batch([
      env.DB.prepare('UPDATE queue SET fb_post_id = ? WHERE id = ?').bind(String(id ?? ''), item.id),
      env.DB.prepare('UPDATE daily SET fb = fb + 1 WHERE day = ?').bind(day),
    ]);
  } catch (e) {
    await logEvent(env, 'error', `facebook #${item.id}: ${e.message}`);
    if (s.last_fb_alert !== day) {
      await setSetting(env, 'last_fb_alert', day);
      await notifyOwner(env, `⚠️ Facebook post did not work (Telegram post is fine).\n${String(e.message).slice(0, 200)}`);
    }
  }
}

// Once an hour: make sure each bot's webhook points at this Worker.
export async function ensureWebhooks(env) {
  const s = await getSettings(env);
  const t = nowSec();
  if (s.last_webhook_check && t - s.last_webhook_check < 3600) return;
  if (!env.PUBLIC_URL) return;
  // Not stamped until a bot is set up, so the first tick after the secrets are added sets the webhooks.
  if (!(env.REPOSTER_BOT_TOKEN && env.WEBHOOK_SECRET) && !(env.ANSWER_BOT_TOKEN && env.ANSWER_WEBHOOK_SECRET)) return;
  await setSetting(env, 'last_webhook_check', t);
  const base = String(env.PUBLIC_URL).replace(/\/+$/, '');
  const bots = [
    { token: env.REPOSTER_BOT_TOKEN, path: '/tg/reposter', secret: env.WEBHOOK_SECRET, allowed: ['message', 'callback_query'] },
    { token: env.ANSWER_BOT_TOKEN, path: '/tg/answer', secret: env.ANSWER_WEBHOOK_SECRET, allowed: ['message', 'business_connection', 'business_message'] },
  ];
  for (const b of bots) {
    if (!b.token || !b.secret) continue;
    try {
      const info = await tg(b.token, 'getWebhookInfo', {});
      if (info.url !== base + b.path) {
        await tg(b.token, 'setWebhook', {
          url: base + b.path, secret_token: b.secret, allowed_updates: b.allowed, drop_pending_updates: false,
        });
        await logEvent(env, 'info', `webhook set for ${b.path}`);
      }
    } catch (e) {
      await logEvent(env, 'error', `webhook ${b.path}: ${e.message}`);
    }
  }
}

// Tell the owner (max once per 6 hours) if the reader is silent or the queue is huge.
export async function healthCheck(env, now = new Date()) {
  const s = await getSettings(env);
  const t = Math.floor(now.getTime() / 1000);
  if (s.last_health_alert && t - s.last_health_alert < 6 * 3600) return;
  const problems = [];
  const { minutes } = addisNow(now);
  // Give the reader 150 min after the window opens (it does not run at night), so no false alarm each morning.
  const sinceOpen = (minutes - (hhmmToMin(s.collect_start) ?? 0) + 1440) % 1440;
  if (s.running && inWindow(minutes, s.collect_start, s.collect_end) && sinceOpen >= 150) {
    const hb = await getState(env, 'heartbeat', null);
    const beat = Number(hb);
    if (beat && t - beat > 150 * 60) {
      const hours = Math.round(((t - beat) / 3600) * 10) / 10;
      problems.push(`⚠️ Reposter reader hasn't run for ${hours} hours (last: ${agoText(t - beat)}).`);
    }
  }
  const q = await env.DB.prepare("SELECT COUNT(*) AS n FROM queue WHERE status = 'queued'").first();
  if ((q?.n || 0) > 200) problems.push(`⚠️ The queue has ${q.n} posts waiting. Posting may be too slow.`);
  if (!problems.length) return;
  await setSetting(env, 'last_health_alert', t);
  await notifyOwner(env, problems.join('\n'));
}

// Sync the price list for the answer bot (about once an hour).
async function syncPricesJob(env) {
  const s = await getSettings(env);
  if (!s.answer_enabled || !env.PRICES_URL) return;
  if (s.last_price_sync && nowSec() - s.last_price_sync < 3600) return;
  const { syncPrices } = await import('./answer.js');
  await syncPrices(env);
}

async function trimLog(env) {
  await env.DB.prepare('DELETE FROM log WHERE id <= (SELECT MAX(id) FROM log) - 500').run();
}
