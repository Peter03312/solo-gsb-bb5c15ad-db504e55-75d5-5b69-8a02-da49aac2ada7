'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { hashPassword } = require('./auth');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dnszone.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  primary_ns TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  default_ttl INTEGER NOT NULL DEFAULT 3600,
  soa_refresh INTEGER NOT NULL DEFAULT 7200,
  soa_retry INTEGER NOT NULL DEFAULT 3600,
  soa_expire INTEGER NOT NULL DEFAULT 1209600,
  soa_minimum INTEGER NOT NULL DEFAULT 300,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  rev_no INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','in_review','approved','rejected','published','superseded')),
  content_hash TEXT NOT NULL,
  base_serial INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  primary_ns TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  default_ttl INTEGER NOT NULL,
  soa_refresh INTEGER NOT NULL,
  soa_retry INTEGER NOT NULL,
  soa_expire INTEGER NOT NULL,
  soa_minimum INTEGER NOT NULL,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (zone_id, rev_no)
);

CREATE TABLE IF NOT EXISTS revision_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  ttl INTEGER,
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  revision_id INTEGER NOT NULL REFERENCES revisions(id),
  reviewer_id INTEGER NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve','reject')),
  comment TEXT,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS published_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  serial INTEGER NOT NULL,
  revision_id INTEGER REFERENCES revisions(id),
  content TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  settings TEXT NOT NULL,
  note TEXT,
  published_by INTEGER NOT NULL REFERENCES users(id),
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (zone_id, serial)
);

CREATE TABLE IF NOT EXISTS published_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  published_file_id INTEGER NOT NULL REFERENCES published_files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  ttl INTEGER NOT NULL,
  value TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER,
  actor_id INTEGER,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_revision_records_rev ON revision_records(revision_id);
CREATE INDEX IF NOT EXISTS idx_reviews_rev ON reviews(revision_id);
CREATE INDEX IF NOT EXISTS idx_published_files_zone ON published_files(zone_id, serial);
CREATE INDEX IF NOT EXISTS idx_published_records_file ON published_records(published_file_id);
CREATE INDEX IF NOT EXISTS idx_audit_zone ON audit_log(zone_id, id);
`);

// 已发布文件与审计历史不可改：触发器拦截 UPDATE/DELETE
db.exec(`
CREATE TRIGGER IF NOT EXISTS trg_published_files_no_update BEFORE UPDATE ON published_files
BEGIN SELECT RAISE(ABORT, 'published_files 不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_published_files_no_delete BEFORE DELETE ON published_files
BEGIN SELECT RAISE(ABORT, 'published_files 不可删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_published_records_no_update BEFORE UPDATE ON published_records
BEGIN SELECT RAISE(ABORT, 'published_records 不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_published_records_no_delete BEFORE DELETE ON published_records
BEGIN SELECT RAISE(ABORT, 'published_records 不可删除'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log 不可修改'); END;
CREATE TRIGGER IF NOT EXISTS trg_audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log 不可删除'); END;
`);

function seedUsers() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;
  const users = [
    ['admin', process.env.ADMIN_PASSWORD || 'admin123', '管理员'],
    ['operator', process.env.OPERATOR_PASSWORD || 'operator123', '运维员'],
    ['reviewer', process.env.REVIEWER_PASSWORD || 'reviewer123', '复核员'],
  ];
  const ins = db.prepare('INSERT INTO users (username, password_hash, display_name) VALUES (?, ?, ?)');
  for (const [u, p, d] of users) {
    ins.run(u, hashPassword(p), d);
  }
  console.log('[db] 已初始化默认账号: admin / operator / reviewer（密码可用环境变量覆盖）');
}

seedUsers();

module.exports = db;
