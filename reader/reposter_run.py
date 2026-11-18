# -*- coding: utf-8 -*-
"""ROHA reader: one run for GitHub Actions.
Reads new posts from source channels, makes a caption with AI, swaps watermarked photos,
adds the ROHA watermark, uploads the final photos to a private storage channel (Bot API),
and hands the item to the Worker. Public repo: logs hold only counts and short status words.
Add --verbose for more detail (local testing only)."""

import asyncio
import json
import logging
import os
import re
import sys
import time

import requests

import core
from core import (QuotaExhausted, add_watermark, addis_now, build_caption_html, download_image,
                  group_messages, in_collect_window, is_duplicate, norm_channel, phash,
                  prune_hashes, scrub, search_clean_photos, to_jpeg)

# One GitHub run keeps checking the sources for ~50 min, then the next scheduled run takes over.
# shortcut: polling every POLL_SECONDS, not a live listener; fine for ~20 channels.
RUN_BUDGET_SECONDS = 50 * 60
POLL_SECONDS = 60
REQUIRED_ENV = ["TG_API_ID", "TG_API_HASH", "TG_SESSION", "GEMINI_API_KEY",
                "REPOSTER_BOT_TOKEN", "STORAGE_CHAT_ID", "WORKER_URL", "READER_KEY"]
USERNAME_RE = re.compile(r"[A-Za-z][A-Za-z0-9_]{3,31}")
SOURCE_USERNAME = {}   # state key -> public username (None for private channels)
VERBOSE = False

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", stream=sys.stdout)
log = logging.getLogger("roha")
for noisy in ("telethon", "httpx", "httpcore", "google_genai", "urllib3", "ddgs", "primp"):
    logging.getLogger(noisy).setLevel(logging.WARNING)


def vlog(msg, *a):
    """Detail log: only with --verbose."""
    if VERBOSE:
        log.info("[v] " + msg, *a)


class WorkerError(Exception):
    pass


# --------------------------------------------------------------------------
# Worker API
# --------------------------------------------------------------------------
class Worker:
    def __init__(self, base, key):
        self.base = base.rstrip("/")
        self.h = {"Authorization": f"Bearer {key}"}

    def _call(self, method, path, **kw):
        last = None
        for attempt in range(3):
            try:
                r = requests.request(method, self.base + path, headers=self.h, timeout=30, **kw)
                if r.status_code < 400:
                    return r.json()
                last = r.status_code
                if r.status_code < 500:
                    break
            except requests.RequestException as e:
                last = type(e).__name__
            time.sleep(2 * (attempt + 1))
        raise WorkerError(f"worker call failed ({last})")

    def config(self):
        return self._call("GET", "/api/reader/config")

    def add_item(self, item):
        return self._call("POST", "/api/reader/item", json=item)

    def save_state(self, last_ids, hashes, stats):
        return self._call("POST", "/api/reader/state",
                          json={"last_ids": last_ids, "hashes": hashes, "stats": stats})


# --------------------------------------------------------------------------
# Bot API upload to the storage channel
# --------------------------------------------------------------------------
def largest_file_id(photo_sizes):
    best = max(photo_sizes, key=lambda p: (p.get("file_size") or 0, (p.get("width") or 0) * (p.get("height") or 0)))
    return best["file_id"]


def bot_call(token, method, data=None, files=None):
    url = f"https://api.telegram.org/bot{token}/{method}"
    for attempt in range(3):
        r = requests.post(url, data=data, files=files, timeout=90)
        try:
            j = r.json()
        except Exception:
            j = {}
        if j.get("ok"):
            return j["result"]
        if r.status_code == 429:
            time.sleep(min(int((j.get("parameters") or {}).get("retry_after", 5)) + 1, 60))
            continue
        raise WorkerError(f"bot api failed ({r.status_code})")
    raise WorkerError("bot api rate limited")


def upload_photos(token, chat_id, jpegs):
    """Upload 1 photo (sendPhoto) or 2-10 (sendMediaGroup) silently; return the file_ids."""
    if len(jpegs) == 1:
        res = bot_call(token, "sendPhoto", {"chat_id": chat_id, "disable_notification": "true"},
                       {"photo": ("p.jpg", jpegs[0], "image/jpeg")})
        return [largest_file_id(res["photo"])]
    media = [{"type": "photo", "media": f"attach://f{i}"} for i in range(len(jpegs))]
    files = {f"f{i}": (f"f{i}.jpg", b, "image/jpeg") for i, b in enumerate(jpegs)}
    res = bot_call(token, "sendMediaGroup",
                   {"chat_id": chat_id, "media": json.dumps(media), "disable_notification": "true"}, files)
    return [largest_file_id(m["photo"]) for m in res]


# --------------------------------------------------------------------------
# Telegram sources
# --------------------------------------------------------------------------
async def resolve_source(client, ch, dialogs_cache):
    """Public @username, private channel by exact name, or numeric id (-100...)."""
    from telethon.tl import types
    raw = ch.strip()
    name = raw.lstrip("@")
    if re.fullmatch(r"-?\d{5,}", name):
        n = int(name)
        cid = int(str(abs(n))[3:]) if str(abs(n)).startswith("100") and len(str(abs(n))) > 12 else abs(n)
        try:
            return await client.get_entity(types.PeerChannel(cid))
        except Exception:
            # a fresh StringSession knows no channels yet: look in the joined dialogs
            if not dialogs_cache:
                dialogs_cache.extend([d async for d in client.iter_dialogs() if d.is_channel or d.is_group])
            for d in dialogs_cache:
                if getattr(d.entity, "id", None) == cid:
                    return d.entity
            raise
    if USERNAME_RE.fullmatch(name):
        try:
            return await client.get_entity(name)
        except Exception:
            if raw.startswith("@"):
                raise
    if not dialogs_cache:
        dialogs_cache.extend([d async for d in client.iter_dialogs() if d.is_channel or d.is_group])
    want = name.lower()
    exact = [d for d in dialogs_cache if (d.name or "").strip().lower() == want]
    part = [d for d in dialogs_cache if want in (d.name or "").lower()]
    found = exact or (part if len(part) == 1 else [])
    if not found:
        raise ValueError("no joined channel with that name")
    return found[0].entity


def post_link(source, msg):
    user = SOURCE_USERNAME.get(source)
    if user:
        return f"https://t.me/{user}/{msg.id}"
    cid = getattr(msg.peer_id, "channel_id", None)
    return f"https://t.me/c/{cid}/{msg.id}" if cid else f"#{msg.id}"


# --------------------------------------------------------------------------
# One post
# --------------------------------------------------------------------------
class Run:
    def __init__(self, client, ai, worker, cfg, env):
        self.client, self.ai, self.worker, self.cfg, self.env = client, ai, worker, cfg, env
        self.last_ids = {norm_channel(k): int(v) for k, v in (cfg.get("last_ids") or {}).items()}
        self.hashes = prune_hashes(cfg.get("hashes"), cfg.get("duplicate_days", 30))
        self.stats = {"checked": 0, "queued": 0, "skipped": 0, "errors": 0}
        self.start = time.time()
        self.stopped = False          # AI limit or Worker problem: end the whole run
        self.entities = {}            # resolved sources, kept between passes
        self.dialogs_cache = []

    def push_state(self):
        try:
            self.worker.save_state(self.last_ids, self.hashes, self.stats)
        except WorkerError:
            log.warning("could not save state")

    def out_of_time(self):
        return time.time() - self.start > RUN_BUDGET_SECONDS

    async def process_post(self, source, msgs):
        """Returns (status word, queued?). Raises QuotaExhausted / WorkerError to stop the run."""
        cfg = self.cfg
        photo_msgs = [m for m in msgs if m.photo][:10]
        if not photo_msgs:
            return "skipped: no photo", False
        raw_caption = next((m.message for m in msgs if m.message), "") or ""
        caption_in = scrub(raw_caption)

        photos = []
        for m in photo_msgs:
            try:
                data = await asyncio.wait_for(self.client.download_media(m, file=bytes), timeout=60)
            except asyncio.TimeoutError:
                data = None
            if data:
                photos.append(to_jpeg(data))
        if not photos:
            return "skipped: download failed", False

        h = phash(photos[0])
        if is_duplicate(h, self.hashes, cfg.get("duplicate_days", 30)):
            return "skipped: duplicate", False

        info = await self.ai.analyze(photos, caption_in)
        if not info:
            return "skipped: no AI answer", False
        if not info.get("is_product", True):
            self.hashes.append([h, time.time()])
            return "skipped: not a product", False

        name = str(info.get("product_name") or "").strip()
        notes, risky = [], False
        wm = set()
        for i in info.get("watermarked_photos") or []:
            try:
                wm.add(int(i) - 1)
            except Exception:
                pass
        clean = [p for i, p in enumerate(photos) if i not in wm]

        if wm and not clean:
            query = info.get("search_query") or name
            try:
                urls = await asyncio.wait_for(
                    asyncio.to_thread(search_clean_photos, query, info.get("brand") or ""), timeout=40)
            except asyncio.TimeoutError:
                urls = []
            cands = []
            for u in urls:
                try:
                    d = await asyncio.wait_for(asyncio.to_thread(download_image, u), timeout=25)
                except asyncio.TimeoutError:
                    d = None
                if d:
                    cands.append(d)
                if len(cands) >= 6:
                    break
            found = await self.ai.pick_clean(photos[0], cands, name) if cands else None
            if found:
                clean = [found]
                notes.append("🔄 Watermarked photo replaced with a clean one from the internet")
            else:
                clean = photos
                notes.append("⚠️ Photo has a watermark and no clean photo was found — check before approving")
                risky = True
        elif wm:
            notes.append(f"✂️ Removed {len(wm)} watermarked photo(s), kept the clean ones")

        if str(info.get("confidence", "")).lower() == "low":
            notes.append("⚠️ AI is not sure about the product name — please check it")
            risky = True
        if not raw_caption.strip():
            notes.append("🔎 Original had no caption; name found from the photo")

        caption_html = build_caption_html(name, str(info.get("body") or ""), cfg.get("contact_block", ""))
        finals = [add_watermark(p, cfg) for p in clean[:10]]
        file_ids = await asyncio.to_thread(
            upload_photos, self.env["REPOSTER_BOT_TOKEN"], self.env["STORAGE_CHAT_ID"], finals)

        item = {"name": name or "New item", "caption_html": caption_html, "file_ids": file_ids,
                "source": source, "src_link": post_link(source, msgs[0]),
                "risky": risky, "notes": notes, "hash": h}
        await asyncio.to_thread(self.worker.add_item, item)
        self.hashes.append([h, time.time()])
        return "post queued", True

    async def collect(self):
        cfg = self.cfg
        total = 0
        for ch in cfg.get("sources", []):
            if total >= cfg.get("max_posts_per_run", 25) or self.out_of_time():
                break
            key = norm_channel(ch)
            try:
                entity = self.entities.get(key) or await resolve_source(self.client, ch, self.dialogs_cache)
                self.entities[key] = entity
            except Exception as e:
                log.warning("a source could not be opened (%s)", type(e).__name__)
                self.stats["errors"] += 1
                continue
            SOURCE_USERNAME[key] = getattr(entity, "username", None)

            try:
                if key not in self.last_ids:
                    # new source: only take the last few posts, not the whole history
                    recent = await self.client.get_messages(entity, limit=40)
                    posts = group_messages(list(reversed(recent)))
                    take = cfg.get("first_run_take_last", 3)
                    posts = posts[-take:] if take > 0 else []
                    self.last_ids[key] = recent[0].id if recent else 0
                    if posts:
                        self.last_ids[key] = min(m.id for m in posts[0]) - 1
                    self.push_state()

                new = [m async for m in self.client.iter_messages(
                    entity, min_id=self.last_ids[key], reverse=True, limit=300)]
            except Exception as e:
                # one bad source (flood wait, removed from channel...) must not stop the others
                log.warning("a source could not be read (%s)", type(e).__name__)
                self.stats["errors"] += 1
                continue
            done_here = 0
            for msgs in group_messages(new):
                if (done_here >= cfg.get("max_posts_per_channel_per_run", 8)
                        or total >= cfg.get("max_posts_per_run", 25)):
                    break
                if self.out_of_time():
                    log.info("time budget reached, stopping")
                    return
                self.stats["checked"] += 1
                try:
                    status, queued = await self.process_post(key, msgs)
                except (QuotaExhausted, WorkerError) as e:
                    log.warning("stopping run: %s", "AI limit reached" if isinstance(e, QuotaExhausted)
                                else "worker problem")
                    self.stats["errors"] += 1
                    self.stopped = True
                    self.push_state()      # this post is NOT marked done, so it is retried next run
                    return
                except Exception as e:
                    log.warning("post error (%s)", type(e).__name__)
                    vlog("detail: %r", e)
                    status, queued = "skipped: error", False
                    self.stats["errors"] += 1
                self.last_ids[key] = max(m.id for m in msgs)
                if queued:
                    self.stats["queued"] += 1
                    done_here += 1
                    total += 1
                elif not status.endswith("error"):
                    self.stats["skipped"] += 1
                self.push_state()
                log.info(status)
                vlog("source=%s msg=%s", key, msgs[0].id)


async def main():
    global VERBOSE
    VERBOSE = "--verbose" in sys.argv
    env = {k: os.environ.get(k, "").strip() for k in REQUIRED_ENV}
    missing = [k for k, v in env.items() if not v]
    if missing:
        print("Missing settings (GitHub secrets): " + ", ".join(missing))
        return 1

    worker = Worker(env["WORKER_URL"], env["READER_KEY"])
    try:
        cfg = worker.config()
    except WorkerError:
        print("Could not reach the Worker (check WORKER_URL and READER_KEY).")
        return 1
    if not cfg.get("running", True):
        log.info("nothing to do: stopped")
        return 0
    now = addis_now()
    if not in_collect_window(now["minutes"], cfg.get("collect_start", "06:00"), cfg.get("collect_end", "22:00")):
        log.info("nothing to do: outside collect window")
        return 0

    from telethon import TelegramClient
    from telethon.sessions import StringSession
    client = TelegramClient(StringSession(env["TG_SESSION"]), int(env["TG_API_ID"]), env["TG_API_HASH"])
    await client.connect()
    try:
        if not await client.is_user_authorized():
            print("The Telegram session is not valid. Run login.py again and update TG_SESSION.")
            return 1
        ai = core.Gemini(env["GEMINI_API_KEY"])
        run = Run(client, ai, worker, cfg, env)
        log.info("run started: %d sources", len(cfg.get("sources", [])))
        while True:
            try:
                await run.collect()
            finally:
                run.push_state()
            if run.stopped or run.out_of_time():
                break
            await asyncio.sleep(POLL_SECONDS)
            try:
                cfg = worker.config()   # picks up panel changes (sources, stop) without a restart
            except WorkerError:
                continue
            if not cfg.get("running", True) or not in_collect_window(
                    addis_now()["minutes"], cfg.get("collect_start", "06:00"), cfg.get("collect_end", "22:00")):
                log.info("stopping: paused or outside collect window")
                break
            run.cfg = cfg
        s = run.stats
        log.info("run done: checked %d, queued %d, skipped %d, errors %d",
                 s["checked"], s["queued"], s["skipped"], s["errors"])
        return 0
    finally:
        await client.disconnect()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
