'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const SessionStore = require('express-session').Store;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','reviewer','editor')),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS zones (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  name                 TEXT NOT NULL UNIQUE,
  current_revision_id  INTEGER REFERENCES revisions(id),
  created_by           INTEGER NOT NULL REFERENCES users(id),
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 每个区域始终只有一条 current 修订版（工作草稿）；其余为历史修订
CREATE TABLE IF NOT EXISTS revisions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id      INTEGER NOT NULL REFERENCES zones(id),
  rev_no       INTEGER NOT NULL,
  is_current   INTEGER NOT NULL DEFAULT 0,
  content      TEXT NOT NULL,             -- 区域头 + 记录的 JSON
  content_hash TEXT NOT NULL,
  rollback_from_version INTEGER REFERENCES published_versions(id), -- 非空表示由回滚生成的草稿
  created_by   INTEGER NOT NULL REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (zone_id, rev_no)
);

-- 复核：每次保存草稿后旧复核整体失效（is_valid=0）
CREATE TABLE IF NOT EXISTS reviews (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL REFERENCES revisions(id),
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  comment     TEXT NOT NULL DEFAULT '',
  is_valid    INTEGER NOT NULL DEFAULT 1,  -- 编辑后由触发器置 0
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS published_versions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id      INTEGER NOT NULL REFERENCES zones(id),
  revision_id  INTEGER NOT NULL REFERENCES revisions(id),
  serial       INTEGER NOT NULL,
  content      TEXT NOT NULL,             -- 发布时规范化后的 JSON（不可变）
  content_hash TEXT NOT NULL,
  zone_file    TEXT NOT NULL,             -- 生成的 BIND 区域文件文本（不可变）
  published_by INTEGER NOT NULL REFERENCES users(id),
  action       TEXT NOT NULL DEFAULT 'publish', -- publish | rollback
  published_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id),
  username   TEXT,
  action     TEXT NOT NULL,
  detail     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid    TEXT PRIMARY KEY,
  sess   TEXT NOT NULL,
  expire REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire);

CREATE TRIGGER IF NOT EXISTS trg_invalidate_reviews_after_update
AFTER UPDATE OF content_hash ON revisions
FOR EACH ROW
BEGIN
  UPDATE reviews SET is_valid = 0 WHERE revision_id = OLD.id AND is_valid = 1;
END;

-- 已发布版本与审计日志仅追加：数据库层禁止修改/删除
CREATE TRIGGER IF NOT EXISTS trg_published_no_update
BEFORE UPDATE ON published_versions
BEGIN
  SELECT RAISE(ABORT, 'published_versions 为不可变表，禁止更新');
END;
CREATE TRIGGER IF NOT EXISTS trg_published_no_delete
BEFORE DELETE ON published_versions
BEGIN
  SELECT RAISE(ABORT, 'published_versions 为不可变表，禁止删除');
END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log 为不可变表，禁止更新');
END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log 为不可变表，禁止删除');
END;
`);

// ---- 会话存储（express-session 适配器）----
class SqliteSessionStore extends SessionStore {
  get(sid, cb) {
    const row = db.prepare('SELECT sess FROM sessions WHERE sid = ? AND expire > ?')
      .get(sid, Date.now());
    if (!row) return cb(null, null);
    try { cb(null, JSON.parse(row.sess)); } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    const maxAge = sess.cookie && sess.cookie.originalMaxAge ? sess.cookie.originalMaxAge : 86400000;
    db.prepare(`INSERT INTO sessions (sid, sess, expire) VALUES (?, ?, ?)
                ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expire = excluded.expire`)
      .run(sid, JSON.stringify(sess), Date.now() + maxAge);
    cb && cb(null);
  }
  destroy(sid, cb) {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    cb && cb(null);
  }
  touch(sid, sess, cb) {
    const maxAge = sess.cookie && sess.cookie.originalMaxAge ? sess.cookie.originalMaxAge : 86400000;
    db.prepare('UPDATE sessions SET expire = ? WHERE sid = ?').run(Date.now() + maxAge, sid);
    cb && cb(null);
  }
}
const sessionStore = new SqliteSessionStore();
setInterval(() => {
  try { db.prepare('DELETE FROM sessions WHERE expire <= ?').run(Date.now()); } catch (_) {}
}, 5 * 60 * 1000).unref();

// ---- 初始化本地账号 ----
function seedUsers() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) return;
  const accounts = [
    { username: process.env.ADMIN_USER || 'admin', password: process.env.ADMIN_PASSWORD || 'admin123', role: 'admin', display_name: '管理员' },
    { username: process.env.EDITOR_USER || 'editor', password: process.env.EDITOR_PASSWORD || 'editor123', role: 'editor', display_name: '编辑员' },
    { username: process.env.REVIEWER_USER || 'reviewer', password: process.env.REVIEWER_PASSWORD || 'reviewer123', role: 'reviewer', display_name: '复核员' }
  ];
  const stmt = db.prepare('INSERT INTO users (username, display_name, password_hash, role) VALUES (?, ?, ?, ?)');
  for (const a of accounts) {
    stmt.run(a.username, a.display_name, bcrypt.hashSync(a.password, 10), a.role);
  }
  console.log('[seed] 初始账号已创建：admin/admin123, editor/editor123, reviewer/reviewer123');
}
seedUsers();

function audit(userId, username, action, detail = '') {
  db.prepare('INSERT INTO audit_log (user_id, username, action, detail) VALUES (?, ?, ?, ?)')
    .run(userId == null ? null : userId, username, action, typeof detail === 'string' ? detail : JSON.stringify(detail));
}

module.exports = { db, sessionStore, audit, DB_PATH, DATA_DIR };
