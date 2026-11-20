// Facebook Page posting (Graph API). Called after the Telegram post worked.
import { hmacSig, stripHtml } from './util.js';

export function fbConfigured(env) {
  return Boolean(env.FB_PAGE_ID && env.FB_PAGE_TOKEN && env.IMG_SIGN_KEY && env.PUBLIC_URL);
}

// Signed link Facebook can fetch the photo from.
export async function signedImgUrl(env, fileId) {
  const sig = await hmacSig(env.IMG_SIGN_KEY, fileId);
  return `${String(env.PUBLIC_URL).replace(/\/+$/, '')}/img/${encodeURIComponent(fileId)}?s=${sig}`;
}

// POST a form to the Graph API. Errors never contain the token.
async function graph(env, path, params) {
  const ver = env.FB_API_VERSION || 'v26.0';
  const form = new URLSearchParams({ ...params, access_token: env.FB_PAGE_TOKEN });
  let res, data;
  try {
    res = await fetch(`https://graph.facebook.com/${ver}/${env.FB_PAGE_ID}/${path}`, { method: 'POST', body: form });
    data = await res.json();
  } catch {
    throw new Error('Facebook: network error');
  }
  if (!res.ok || data.error) {
    const msg = String(data?.error?.message || res.status).split(env.FB_PAGE_TOKEN).join('***');
    throw new Error(`Facebook: ${msg}`.slice(0, 300));
  }
  return data;
}

// Post one item. Returns the Facebook post id.
export async function postToFacebook(env, item, fileIds) {
  const text = stripHtml(item.caption_html);
  if (fileIds.length === 1) {
    const url = await signedImgUrl(env, fileIds[0]);
    const d = await graph(env, 'photos', { url, caption: text });
    return d.post_id || d.id;
  }
  // Album: upload each photo unpublished, then one feed post that attaches them.
  const ids = [];
  for (const fid of fileIds) {
    const url = await signedImgUrl(env, fid);
    const d = await graph(env, 'photos', { url, published: 'false' });
    ids.push(d.id);
  }
  const params = { message: text };
  ids.forEach((id, i) => { params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: id }); });
  const d = await graph(env, 'feed', params);
  return d.id;
}
