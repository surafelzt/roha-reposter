# -*- coding: utf-8 -*-
"""One-time helper (run on your own PC): logs in the SPARE Telegram account and prints a session string.
Run:  pip install telethon   then   python login.py
You need api_id and api_hash from https://my.telegram.org (API development tools)."""

import asyncio
import getpass

from telethon import TelegramClient
from telethon.sessions import StringSession


async def main():
    api_id = int(input("api_id: ").strip())
    api_hash = input("api_hash: ").strip()
    async with TelegramClient(StringSession(), api_id, api_hash) as client:
        await client.start(
            phone=lambda: input("Phone number of the SPARE account (+251...): ").strip(),
            code_callback=lambda: input("Login code Telegram sent you: ").strip(),
            password=lambda: getpass.getpass("2-step password (if any): "),
        )
        session = client.session.save()
    print("\n" + "=" * 60)
    print("WARNING: this text gives full access to the spare Telegram account.")
    print("Paste it ONCE into the GitHub secret named TG_SESSION. Never share it, never post it.")
    print("It is shown only now.")
    print("=" * 60)
    print(session)
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
