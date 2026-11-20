// Test helper: a real SQLite database that looks like Cloudflare D1.
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, status TEXT NOT NULL,
  name TEXT, caption_html TEXT, file_ids TEXT NOT NULL,
  source TEXT, src_link TEXT, risky INTEGER DEFAULT 0, notes TEXT, hash TEXT,
  posted_at INTEGER, channel_msg_id INTEGER, silent INTEGER, fb_post_id TEXT,
  error TEXT, tries INTEGER DEFAULT 0, approval_chat_id INTEGER, approval_msg_id INTEGER);
CREATE TABLE IF NOT EXISTS reader_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS daily (day TEXT PRIMARY KEY, posted INTEGER DEFAULT 0, loud INTEGER DEFAULT 0,
  used_slots TEXT DEFAULT '[]', fb INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, level TEXT, msg TEXT);
`;

export function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(SCHEMA);
  const bound = (stmt, p) => ({
    async all() { return { results: stmt.all(...p) }; },
    async first(col) { const r = stmt.get(...p) ?? null; return col && r ? r[col] : r; },
    async run() { const r = stmt.run(...p); return { success: true, meta: { last_row_id: Number(r.lastInsertRowid), changes: Number(r.changes) } }; },
  });
  return {
    raw: db,
    prepare(sql) {
      const stmt = db.prepare(sql);
      const o = bound(stmt, []);
      o.bind = (...p) => bound(stmt, p);
      return o;
    },
    async batch(list) { const out = []; for (const s of list) out.push(await s.run()); return out; },
  };
}
