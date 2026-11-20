// Tiny Telegram Bot API client.

export class TgError extends Error {
  constructor(code, description, retry_after) {
    super(`Telegram ${code}: ${description}`);
    this.name = 'TgError';
    this.code = code;
    this.description = description;
    this.retry_after = retry_after || 0;
  }
}

// Call a Bot API method. Returns `result`, throws TgError.
export async function tg(token, method, body = {}) {
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new TgError(0, 'network error');
  }
  let data;
  try { data = await res.json(); } catch { throw new TgError(res.status, 'bad response'); }
  if (!data.ok) throw new TgError(data.error_code || res.status, data.description || 'error', data.parameters?.retry_after);
  return data.result;
}

// Download a file by file_id. Returns a fetch Response (never exposes the token).
export async function fetchTgFile(token, fileId) {
  const info = await tg(token, 'getFile', { file_id: fileId });
  if (!info?.file_path) throw new TgError(404, 'no file path');
  return fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);
}

// Send a plain message to the owner. Never throws.
export async function notifyOwner(env, text, extra = {}) {
  if (!env.REPOSTER_BOT_TOKEN || !env.OWNER_ID) return null;
  try {
    return await tg(env.REPOSTER_BOT_TOKEN, 'sendMessage', { chat_id: env.OWNER_ID, text: String(text).slice(0, 4000), ...extra });
  } catch {
    return null;
  }
}
