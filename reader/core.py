# -*- coding: utf-8 -*-
"""Reused pure helpers for the ROHA reader (caption cleaning, images, duplicates, Gemini).
Logging rule: this repo is public, so nothing here logs channel names, products, links or tokens."""

import asyncio
import html
import io
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone

import imagehash
import requests
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
log = logging.getLogger("roha")

CAPTION_SAFE_LIMIT = 1000   # Telegram allows 1024; keep a little room
DUPLICATE_DISTANCE = 6
GEMINI_MODELS = ["gemini-3.1-flash-lite", "gemini-flash-lite-latest", "gemini-flash-latest"]
GEMINI_GAP_SECONDS = 4


# --------------------------------------------------------------------------
# Time window (Addis Ababa = UTC+3, no DST)
# --------------------------------------------------------------------------
def addis_now(now_utc=None):
    now_utc = now_utc or datetime.now(timezone.utc)
    t = now_utc.astimezone(timezone(timedelta(hours=3)))
    return {"day": t.strftime("%Y-%m-%d"), "minutes": t.hour * 60 + t.minute, "hhmm": t.strftime("%H:%M")}


def hhmm_to_minutes(s):
    h, m = str(s).split(":")
    return int(h) * 60 + int(m)


def in_collect_window(minutes, start="06:00", end="22:00"):
    """True when `minutes` (0..1439, Addis) is inside [start, end). Window may cross midnight."""
    a, b = hhmm_to_minutes(start), hhmm_to_minutes(end)
    if a == b:
        return True
    if a < b:
        return a <= minutes < b
    return minutes >= a or minutes < b


# --------------------------------------------------------------------------
# Caption cleaning (no competitor contacts, links or prices)
# --------------------------------------------------------------------------
def norm_channel(name):
    return str(name).strip().lstrip("@").lower()


PHONE_RE = re.compile(r"(?:\+?251|\b0)[\s\-.()]*[79](?:[\s\-.()]*\d){8}\b|\b\d(?:[\s\-.]?\d){8,13}\b")
LINK_RE = re.compile(r"(?:https?://|www\.)\S+|\bt\.me/\S+|\btelegram\.me/\S+", re.I)
MENTION_RE = re.compile(r"@[A-Za-z0-9_]{3,}")
PRICE_RE = re.compile(
    r"(?:(?:ዋጋ(?:ው)?|price)\s*[:\-–=]?\s*)?\d[\d,.' ]*\s*(?:ብር|birr|br\.?|etb)(?![A-Za-z])"
    r"|(?:ዋጋ(?:ው)?|price)\s*[:\-–=]?\s*\d[\d,.' ]*",
    re.I,
)
DANGLING_RE = re.compile(r"(?i)[\s,]*(?:call|tel|phone|ይደውሉ(?:ልን)?)\s*[:\-]?\s*$")


def scrub(text, keep_digits=""):
    """Remove phone numbers, links, @usernames and prices."""
    if not text:
        return ""

    def phone_sub(m):
        digits = re.sub(r"\D", "", m.group(0))
        if keep_digits and digits.endswith(keep_digits[-9:]):
            return m.group(0)
        return ""

    text = LINK_RE.sub("", text)
    text = MENTION_RE.sub("", text)
    text = PRICE_RE.sub("", text)
    text = PHONE_RE.sub(phone_sub, text)
    lines = []
    for line in text.splitlines():
        line = DANGLING_RE.sub("", line)
        stripped = line.strip(" \t-–:|/,•·📞📱☎️📩✉️👉👇")
        if not stripped:
            continue
        if re.fullmatch(r"(?i)(phone|tel|call|contact|telegram|join|ይደውሉ|ስልክ|ለበለጠ መረጃ|አድራሻ)\s*:?", stripped):
            continue
        lines.append(line.rstrip())
    return "\n".join(lines).strip()


def u16len(s):
    """Length the way Telegram counts it (UTF-16 units)."""
    return len(s.encode("utf-16-le")) // 2


def esc(s):
    return html.escape(s, quote=False)


def build_caption_html(name, body, contact, limit=CAPTION_SAFE_LIMIT):
    """HTML caption: 🔧 <b>name</b> + body + contact. name/body/contact are escaped.
    The visible text (what Telegram counts) is kept under `limit`."""
    body = scrub(body).replace("**", "").replace("__", "")
    name = scrub(name).replace("*", "").strip() or "New item"
    if len(name) > 200:
        name = name[:200].rstrip()
    contact = (contact or "").strip()
    head_vis = f"🔧 {name}\n\n"
    tail_vis = f"\n\n{contact}" if contact else ""
    room = limit - u16len(head_vis) - u16len(tail_vis)
    if room < 0:                      # silly long contact block: drop the body
        body, room = "", 0
    if u16len(body) > room:
        cut = ""
        for line in body.split("\n"):
            nxt = (cut + "\n" + line) if cut else line
            if u16len(nxt) > room:
                break
            cut = nxt
        if not cut:                   # first line alone is too long: hard cut
            cut = body[: max(0, room - 1)]
            while cut and u16len(cut) > room - 1:
                cut = cut[:-1]
            cut = cut.rstrip() + ("…" if cut else "")
        body = cut.strip()
    out = f"🔧 <b>{esc(name)}</b>\n\n"
    if body:
        out += esc(body)
    if contact:
        out += (f"\n\n{esc(contact)}" if body else esc(contact))
    return out


# --------------------------------------------------------------------------
# Images
# --------------------------------------------------------------------------
def to_jpeg(data, max_side=1280):
    img = Image.open(io.BytesIO(data)).convert("RGB")
    img.thumbnail((max_side, max_side))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=88)
    return out.getvalue()


_WM = {}


def add_watermark(data, settings, path=None):
    """Faint ROHA logo + phone number across the middle. Returns JPEG bytes."""
    if not settings.get("watermark", True):
        return data
    path = path or os.path.join(HERE, "watermark.png")
    try:
        if path not in _WM:
            _WM[path] = Image.open(path).convert("RGBA")
        badge = _WM[path]
        img = Image.open(io.BytesIO(data)).convert("RGB")
        W, H = img.size
        size = float(settings.get("watermark_size", 0.62))
        w = int(min(W * size, min(W, H) * size * 1.3))
        h = round(badge.height * w / badge.width)
        b = badge.resize((w, h), Image.LANCZOS)
        opacity = float(settings.get("watermark_opacity", 0.15))
        b.putalpha(b.getchannel("A").point(lambda v: int(v * opacity)))
        img.paste(b, ((W - w) // 2, (H - h) // 2), b)
        out = io.BytesIO()
        img.save(out, "JPEG", quality=88)
        return out.getvalue()
    except Exception as e:
        log.warning("watermark skipped (%s)", type(e).__name__)
        return data


def phash(data):
    return str(imagehash.phash(Image.open(io.BytesIO(data)).convert("RGB")))


def prune_hashes(hashes, days, now=None):
    now = now or time.time()
    cutoff = now - days * 86400
    out = []
    for x in hashes or []:
        try:
            if float(x[1]) > cutoff:
                out.append([str(x[0]), float(x[1])])
        except Exception:
            continue
    return out


def is_duplicate(h, hashes, days=30, now=None):
    """True if the picture hash is within distance 6 of a hash seen in the last `days` days."""
    target = imagehash.hex_to_hash(h)
    for old, _ in prune_hashes(hashes, days, now):
        try:
            if target - imagehash.hex_to_hash(old) <= DUPLICATE_DISTANCE:
                return True
        except Exception:
            continue
    return False


def search_clean_photos(query, brand=""):
    """Free image search. Returns list of image URLs, brand/official sites first."""
    try:
        from ddgs import DDGS
        results = DDGS().images(query, max_results=15, safesearch="moderate")
    except Exception as e:
        log.warning("image search failed (%s)", type(e).__name__)
        return []
    bad_hosts = ("t.me", "telegram", "facebook", "fbcdn", "instagram", "tiktok", "pinterest", "youtube")
    scored = []
    for r in results:
        url = r.get("image") or ""
        page = (r.get("url") or "").lower()
        if not url.startswith("http") or any(b in url.lower() or b in page for b in bad_hosts):
            continue
        score = 0
        if brand and brand.lower().replace(" ", "") in (page + url.lower()).replace(" ", ""):
            score += 3
        try:
            if int(r.get("width") or 0) >= 600:
                score += 1
        except Exception:
            pass
        scored.append((score, url))
    scored.sort(key=lambda x: -x[0])
    return [u for _, u in scored[:8]]


def download_image(url):
    try:
        r = requests.get(url, timeout=(8, 12), headers={"User-Agent": "Mozilla/5.0"}, stream=True)
        if r.status_code != 200:
            return None
        data = r.raw.read(8 * 1024 * 1024 + 1, decode_content=True)
        if len(data) > 8 * 1024 * 1024:
            return None
        img = Image.open(io.BytesIO(data))
        if min(img.size) < 350:
            return None
        return to_jpeg(data)
    except Exception:
        return None


# --------------------------------------------------------------------------
# Albums
# --------------------------------------------------------------------------
def group_messages(messages):
    """Turn messages into posts; an album (several photos) becomes one post."""
    posts, albums = [], {}
    for m in messages:
        if m.grouped_id:
            if m.grouped_id not in albums:
                albums[m.grouped_id] = []
                posts.append(albums[m.grouped_id])
            albums[m.grouped_id].append(m)
        else:
            posts.append([m])
    return posts


# --------------------------------------------------------------------------
# Gemini (free tier)
# --------------------------------------------------------------------------
ANALYZE_PROMPT = """You help ROHA Tools, a hardware & power-tools shop in Addis Ababa, Ethiopia, repost products.
You get product photo(s) (numbered from 1) and maybe the original caption from another shop.

1. Identify the product as exactly as you can (brand, model number, type). If the caption is empty,
   identify it from the photo only; use Google Search if it helps you find the exact model.
2. Decide for EACH photo if it has a watermark, shop logo, channel name, phone number,
   @username or other text stamped on top of the picture (product's own printed brand name does NOT count).
3. Write a short caption body for Telegram:
   - 2 to 5 short lines.
   - Product names, brands, model numbers and technical specs (V, W, Ah, mm, RPM, inch) stay in ENGLISH.
   - Descriptions, uses and benefits are written in AMHARIC.
   - You may use 1 to 3 simple emojis (✅ ⚡ 🔋 🔩 💪).
   - NO prices, NO phone numbers, NO @usernames, NO links, NO shop names or addresses.
   - Do not invent specs you are not sure about; describe generally instead.
   - No markdown symbols like ** or #.
4. If it is not a product for sale (ad for a group, meme, announcement), set is_product to false.

Answer with ONLY this JSON, nothing else:
{"is_product": true,
 "product_name": "English name with brand and model, e.g. Bosch GSB 180-LI Cordless Drill 18V",
 "brand": "Bosch",
 "search_query": "best web image search query to find a clean official photo",
 "confidence": "high | medium | low",
 "watermarked_photos": [1],
 "body": "the caption body"}

Original caption (already cleaned, may be empty):
<<<CAPTION>>>"""

VERIFY_PROMPT = """Image 1 is a product photo from a shop post: <<<NAME>>>.
Images 2 to <<<N>>> are candidate replacement photos from the internet.
Pick the candidate that shows the SAME product (same model and look) AND is clean:
no watermark, no shop logo or channel name, no phone numbers or text stamped over it.
Prefer plain/white backgrounds and sharp, official-looking product shots.
If none fits, answer 0.
Answer with ONLY this JSON: {"best": <image number or 0>, "reason": "few words"}"""


def parse_json(text):
    if not text:
        return None
    text = text.strip()
    text = re.sub(r"^```(?:json)?|```$", "", text, flags=re.M).strip()
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except Exception:
        return None


class QuotaExhausted(Exception):
    pass


class Gemini:
    def __init__(self, api_key, models=None, gap=GEMINI_GAP_SECONDS):
        from google import genai
        from google.genai import types as gtypes
        self._gtypes = gtypes
        self.client = genai.Client(api_key=api_key, http_options=gtypes.HttpOptions(timeout=90_000))
        self.models = list(models or GEMINI_MODELS)
        self.gap = gap
        self._last = 0.0

    async def ask(self, parts, search=False):
        gt = self._gtypes
        tries = 0
        model_i = 0
        use_search = search
        while True:
            wait = self.gap - (time.time() - self._last)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last = time.time()
            config = gt.GenerateContentConfig(temperature=0.4)
            if use_search:
                config.tools = [gt.Tool(google_search=gt.GoogleSearch())]
            try:
                resp = await asyncio.wait_for(
                    self.client.aio.models.generate_content(
                        model=self.models[model_i], contents=parts, config=config),
                    timeout=100)
                return resp.text or ""
            except Exception as e:
                msg = str(e) or type(e).__name__
                tries += 1
                if isinstance(e, asyncio.TimeoutError):
                    msg = "503 timeout"
                busy = any(x in msg for x in ("429", "RESOURCE_EXHAUSTED", "503", "UNAVAILABLE", "500", "INTERNAL"))
                if use_search and busy:
                    use_search = False  # Google Search is not in the free tier: retry without it
                    continue
                if ("404" in msg or "not found" in msg.lower() or busy) and model_i + 1 < len(self.models):
                    model_i += 1
                    continue
                if "401" in msg or "API key not valid" in msg or "PERMISSION_DENIED" in msg:
                    log.error("AI key rejected")
                    raise QuotaExhausted("key rejected")
                if busy:
                    if tries >= 6:
                        raise QuotaExhausted("AI busy")
                    log.info("AI busy, waiting 60s")
                    await asyncio.sleep(60)
                    model_i = 0
                    continue
                if use_search:
                    use_search = False
                    continue
                if tries >= 3:
                    raise
                await asyncio.sleep(10)

    async def analyze(self, photos, caption):
        gt = self._gtypes
        parts = [gt.Part.from_bytes(data=p, mime_type="image/jpeg") for p in photos[:4]]
        parts.append(ANALYZE_PROMPT.replace("<<<CAPTION>>>", caption or "(empty)"))
        return parse_json(await self.ask(parts, search=True))

    async def pick_clean(self, original, candidates, name):
        gt = self._gtypes
        parts = [gt.Part.from_bytes(data=original, mime_type="image/jpeg")]
        parts += [gt.Part.from_bytes(data=c, mime_type="image/jpeg") for c in candidates]
        parts.append(VERIFY_PROMPT.replace("<<<NAME>>>", name).replace("<<<N>>>", str(len(candidates) + 1)))
        res = parse_json(await self.ask(parts)) or {}
        try:
            best = int(res.get("best", 0))
        except Exception:
            best = 0
        if 2 <= best <= len(candidates) + 1:
            return candidates[best - 2]
        return None


# --------------------------------------------------------------------------
# Old state -> Worker payload (used by import_old_state.py)
# --------------------------------------------------------------------------
def convert_old_state(old, current_last_ids=None, current_hashes=None):
    """Build the /api/reader/state body from the old PC state.json.
    Keys are lowercased; if the Worker already has a newer id/hash, it is kept."""
    last_ids = {}
    for k, v in (current_last_ids or {}).items():
        try:
            last_ids[norm_channel(k)] = int(v)
        except Exception:
            pass
    for k, v in (old.get("last_ids") or {}).items():
        try:
            key, val = norm_channel(k), int(v)
        except Exception:
            continue
        last_ids[key] = max(val, last_ids.get(key, 0))
    seen, hashes = set(), []
    for x in list(current_hashes or []) + list(old.get("hashes") or []):
        try:
            h, t = str(x[0]), float(x[1])
        except Exception:
            continue
        if h in seen:
            continue
        seen.add(h)
        hashes.append([h, t])
    return {"last_ids": last_ids, "hashes": hashes,
            "stats": {"checked": 0, "queued": 0, "skipped": 0, "errors": 0}}
