import html
import io
import json
import os
import sys
import time
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PIL import Image

import core
from core import (addis_now, build_caption_html, convert_old_state, in_collect_window,
                  is_duplicate, parse_json, phash, prune_hashes, scrub, u16len)

OLD_STATE = os.path.join(os.path.dirname(__file__), "..", "..", "..", "old", "state.json")


def test_scrub_removes_contacts_links_prices():
    t = "Bosch drill\nPrice: 5000 birr\nCall +251 91 234 5678\n@shop t.me/x https://a.com\nፎን 0912345678"
    out = scrub(t)
    assert "Bosch drill" in out
    for bad in ("5000", "251", "@shop", "t.me", "https", "0912345678"):
        assert bad not in out


def test_scrub_keeps_own_number():
    assert "0989897171" in scrub("Call 0989897171", keep_digits="0989897171")


def test_caption_html_escapes():
    c = build_caption_html("Tom & <Jerry> drill", "a < b & c > d", "📱 <phone> & more")
    assert "<b>Tom &amp; &lt;Jerry&gt; drill</b>" in c
    assert "a &lt; b &amp; c &gt; d" in c
    assert "&lt;phone&gt; &amp; more" in c
    assert c.startswith("🔧 <b>")


def test_caption_html_limit_counts_visible_text():
    body = "\n".join("አማርኛ መስመር & more <x> " + str(i) for i in range(200))
    contact = "👇 ለማዘዝ ይደውሉልን 👇\n📱 Phone: +251 98 989 7171"
    c = build_caption_html("Name", body, contact)
    import re
    visible = html.unescape(re.sub(r"</?b>", "", c))
    assert u16len(visible) <= 1000
    assert visible.endswith("+251 98 989 7171")


def test_caption_html_long_single_line_and_empty_name():
    c = build_caption_html("", "x" * 5000, "")
    visible = html.unescape(c.replace("<b>", "").replace("</b>", ""))
    assert u16len(visible) <= 1000
    assert "New item" in c


def test_window_normal_and_midnight():
    assert in_collect_window(6 * 60, "06:00", "22:00")
    assert in_collect_window(21 * 60 + 59, "06:00", "22:00")
    assert not in_collect_window(22 * 60, "06:00", "22:00")
    assert not in_collect_window(5 * 60, "06:00", "22:00")
    assert in_collect_window(23 * 60, "22:00", "06:00")
    assert in_collect_window(60, "22:00", "06:00")
    assert not in_collect_window(12 * 60, "22:00", "06:00")


def test_addis_now_is_utc_plus_3():
    t = addis_now(datetime(2026, 11, 18, 22, 30, tzinfo=timezone.utc))
    assert t["day"] == "2026-11-19" and t["hhmm"] == "01:30" and t["minutes"] == 90


def _img(color, text_block=False):
    im = Image.new("RGB", (200, 200), color)
    if text_block:
        for x in range(50, 150):
            for y in range(50, 150):
                im.putpixel((x, y), (255 - color[0], 0, 0))
    b = io.BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


def test_duplicate_check():
    a = phash(_img((10, 10, 10), True))
    now = time.time()
    assert is_duplicate(a, [[a, now]], 30)
    assert not is_duplicate(a, [[a, now - 40 * 86400]], 30)      # too old
    import random
    random.seed(1)
    noise = Image.effect_noise((200, 200), 60).convert("RGB")
    b = io.BytesIO()
    noise.save(b, "PNG")
    other = phash(b.getvalue())
    assert not is_duplicate(a, [[other, now]], 30)
    assert not is_duplicate(a, [], 30)


def test_prune_hashes():
    now = 1_000_000_000
    out = prune_hashes([["aa", now - 10], ["bb", now - 99 * 86400], ["bad"]], 30, now)
    assert out == [["aa", now - 10]]


def test_watermark_and_jpeg():
    jpg = core.to_jpeg(_img((100, 120, 140)))
    out = core.add_watermark(jpg, {"watermark": True})
    assert Image.open(io.BytesIO(out)).size == Image.open(io.BytesIO(jpg)).size
    assert core.add_watermark(jpg, {"watermark": False}) == jpg


def test_parse_json():
    assert parse_json('```json\n{"a": 1}\n```') == {"a": 1}
    assert parse_json("nope") is None


def test_group_messages():
    class M:
        def __init__(self, i, g=None):
            self.id, self.grouped_id = i, g
    posts = core.group_messages([M(1), M(2, 9), M(3, 9), M(4)])
    assert [[m.id for m in p] for p in posts] == [[1], [2, 3], [4]]


def test_largest_file_id():
    import reposter_run
    sizes = [{"file_id": "s", "file_size": 10}, {"file_id": "l", "file_size": 999}, {"file_id": "m", "file_size": 50}]
    assert reposter_run.largest_file_id(sizes) == "l"


def test_convert_old_state_real_file():
    with open(OLD_STATE, encoding="utf-8") as f:
        old = json.load(f)
    p = convert_old_state(old)
    assert p["last_ids"]["shegertools"] == 5965
    assert all(k == k.lower() and not k.startswith("@") for k in p["last_ids"])
    assert len(p["last_ids"]) == len(old["last_ids"])
    assert len(p["hashes"]) == len({h for h, _ in old["hashes"]}) > 0
    assert all(isinstance(h, str) and isinstance(t, float) for h, t in p["hashes"])
    assert set(p["stats"]) == {"checked", "queued", "skipped", "errors"}
    json.dumps(p)


def test_convert_merges_with_worker_values():
    old = {"last_ids": {"@Chan": 10}, "hashes": [["aa", 1.0]]}
    p = convert_old_state(old, {"chan": 50, "other": 3}, [["bb", 2.0], ["aa", 1.0]])
    assert p["last_ids"] == {"chan": 50, "other": 3}
    assert sorted(h for h, _ in p["hashes"]) == ["aa", "bb"]
