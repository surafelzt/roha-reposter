CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  status TEXT NOT NULL,            -- 'pending_approval' | 'queued' | 'posted' | 'skipped' | 'failed'
  name TEXT, caption_html TEXT, file_ids TEXT NOT NULL,  -- JSON array of Telegram photo file_ids (1..10)
  source TEXT, src_link TEXT, risky INTEGER DEFAULT 0, notes TEXT, hash TEXT,
  posted_at INTEGER, channel_msg_id INTEGER, silent INTEGER, fb_post_id TEXT,
  error TEXT, tries INTEGER DEFAULT 0, approval_chat_id INTEGER, approval_msg_id INTEGER
);
CREATE INDEX IF NOT EXISTS queue_status ON queue(status, id);
CREATE TABLE IF NOT EXISTS reader_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, posted INTEGER DEFAULT 0, loud INTEGER DEFAULT 0,
  used_slots TEXT DEFAULT '[]', fb INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT, msg TEXT);
CREATE TABLE IF NOT EXISTS prices (code TEXT PRIMARY KEY, name TEXT NOT NULL, name_am TEXT, category TEXT,
  price INTEGER, stock INTEGER, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS chats (chat_id TEXT PRIMARY KEY, last_owner_at INTEGER, last_bot_at INTEGER, lang TEXT);
