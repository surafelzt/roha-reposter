# -*- coding: utf-8 -*-
"""One-time helper: copy the old PC program's state.json (last_ids + hashes) to the Worker,
so the new reader does not repost old items.
Run:  set WORKER_URL and READER_KEY, then  python import_old_state.py path/to/state.json
Add --dry-run to only show counts."""

import json
import os
import sys

import requests

from core import convert_old_state


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    dry = "--dry-run" in sys.argv
    path = args[0] if args else "state.json"
    with open(path, encoding="utf-8") as f:
        old = json.load(f)
    base = os.environ.get("WORKER_URL", "").rstrip("/")
    key = os.environ.get("READER_KEY", "")
    if not dry and (not base or not key):
        sys.exit("Set WORKER_URL and READER_KEY first (or use --dry-run).")
    headers = {"Authorization": f"Bearer {key}"}
    current = {}
    if not dry:
        r = requests.get(base + "/api/reader/config", headers=headers, timeout=30)
        r.raise_for_status()
        current = r.json()
    payload = convert_old_state(old, current.get("last_ids"), current.get("hashes"))
    print(f"{len(payload['last_ids'])} channels, {len(payload['hashes'])} picture hashes")
    if dry:
        return
    r = requests.post(base + "/api/reader/state", headers=headers, json=payload, timeout=60)
    r.raise_for_status()
    print("Done: state sent to the Worker.")


if __name__ == "__main__":
    main()
