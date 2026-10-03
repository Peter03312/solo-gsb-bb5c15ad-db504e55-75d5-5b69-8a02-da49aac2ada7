'use strict';
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const db = require('./db');
const { verifyPassword, newToken, sha256 } = require('./auth');
const { validateZone, RECORD_TYPES } = require('./validate');
const { normalizeZoneName } = require('./dnsutil');
const { generateZoneFile } = require('./zonefile');
const { diffRecords, computeContentHash } = require('./diff');

const PORT = Number(process.env.PORT || 8080);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 12) * 3600 * 1000;
const OPEN_STATUSES = ['draft', 'in_review', 'approved', 'rejected'];

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

// ---------- 通用辅助 ----------

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const q = {
  session: db.prepare(`SELECT s.token, s.expires_at, u.id, u.username, u.display_name
                       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
};

function getSessionUser(req) {
  const token = parseCookies(req).sid;
  if (!token) return null;
  const row = q.session.get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    q.deleteSession.run(token);
    return null;
  }
  return { id: row.id, username: row.username, display_name: row.display_name, token };
}

function requireAuth(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: '未登录或会话已过期' });
  req.user = user;
  next();
}

function audit(zoneId, actor, action, detail) {
  db.prepare('INSERT INTO audit_log (zone_id, actor_id, actor_name, action, detail) VALUES (?, ?, ?, ?, ?)')
    .run(zoneId, actor ? actor.id : null, actor ? actor.username : 'system', action, detail ? JSON.stringify(detail) : null);
}

function currentSerial(zoneId) {
  return db.prepare('SELECT MAX(serial) AS s FROM published_files WHERE zone_id = ?').get(zoneId).s || 0;
}

function latestPublished(zoneId) {
  return db.prepare('SELECT * FROM published_files WHERE zone_id = ? ORDER BY serial DESC LIMIT 1').get(zoneId) || null;
}

function revisionSettings(rev) {
  return {
    primary_ns: rev.primary_ns,
    admin_email: rev.admin_email,
    default_ttl: rev.default_ttl,
    soa_refresh: rev.soa_refresh,
    soa_retry: rev.soa_retry,
    soa_expire: rev.soa_expire,
    soa_minimum: rev.soa_minimum,
  };
}

function getRevisionRow(id) {
  return db.prepare(`SELECT r.*, u.username AS author_name, z.name AS zone_name
                     FROM revisions r
                     JOIN users u ON u.id = r.created_by
                     JOIN zones z ON z.id = r.zone_id
                     WHERE r.id = ?`).get(id);
}

function getRevisionRecords(revisionId) {
  return db.prepare('SELECT id, name, type, ttl, value, sort_order FROM revision_records WHERE revision_id = ? ORDER BY sort_order, id').all(revisionId);
}

function getRevisionReviews(revisionId) {
  return db.prepare(`SELECT rv.id, rv.decision, rv.comment, rv.content_hash, rv.created_at, u.username AS reviewer
                     FROM reviews rv JOIN users u ON u.id = rv.reviewer_id
                     WHERE rv.revision_id = ? ORDER BY rv.id DESC`).all(revisionId);
}

function findValidApproval(rev) {
  return db.prepare(`SELECT rv.*, u.username AS reviewer FROM reviews rv JOIN users u ON u.id = rv.reviewer_id
                     WHERE rv.revision_id = ? AND rv.decision = 'approve' AND rv.content_hash = ? AND rv.reviewer_id != ?
                     ORDER BY rv.id DESC LIMIT 1`).get(rev.id, rev.content_hash, rev.created_by) || null;
}

function openRevisionOf(zoneId) {
  return db.prepare(`SELECT r.id, r.rev_no, r.status, r.base_serial, r.version, r.updated_at, u.username AS author
                     FROM revisions r JOIN users u ON u.id = r.created_by
                     WHERE r.zone_id = ? AND r.status IN ('draft','in_review','approved','rejected')
                     ORDER BY r.rev_no DESC LIMIT 1`).get(zoneId) || null;
}

function sanitizeSettings(input, fallback) {
  const src = input || {};
  const f = fallback || {};
  const pick = (key, def) => {
    const v = src[key] !== undefined ? src[key] : (f[key] !== undefined ? f[key] : def);
    return v;
  };
  // 非数字输入原样保留（截断），交由校验器报错，避免 NaN 写入 INTEGER 列
  const num = (v) => {
    if (v === '' || v === null || v === undefined) return v;
    const n = Number(v);
    return Number.isFinite(n) ? n : String(v).slice(0, 40);
  };
  return {
    primary_ns: String(pick('primary_ns', '')).trim().slice(0, 255),
    admin_email: String(pick('admin_email', '')).trim().slice(0, 255),
    default_ttl: num(pick('default_ttl', 3600)),
    soa_refresh: num(pick('soa_refresh', 7200)),
    soa_retry: num(pick('soa_retry', 3600)),
    soa_expire: num(pick('soa_expire', 1209600)),
    soa_minimum: num(pick('soa_minimum', 300)),
  };
}

function sanitizeRecords(input) {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 5000).map((r, i) => {
    const rawTtl = r ? r.ttl : null;
    let ttl = null;
    if (rawTtl !== '' && rawTtl !== null && rawTtl !== undefined) {
      const n = Number(rawTtl);
      ttl = Number.isFinite(n) ? n : String(rawTtl).slice(0, 40); // 非法值保留，校验器会定位报错
    }
    return {
      name: String(r && r.name != null ? r.name : '').trim().slice(0, 255),
      type: String(r && r.type != null ? r.type : '').trim().toUpperCase().slice(0, 10),
      ttl,
      value: String(r && r.value != null ? r.value : '').trim().slice(0, 4000),
      sort_order: i,
    };
  });
}

const insertRevisionRecord = db.prepare('INSERT INTO revision_records (revision_id, name, type, ttl, value, sort_order) VALUES (?, ?, ?, ?, ?, ?)');

const createRevisionTx = db.transaction((zoneId, zoneName, settings, records, baseSerial, userId) => {
  const revNo = (db.prepare('SELECT MAX(rev_no) AS m FROM revisions WHERE zone_id = ?').get(zoneId).m || 0) + 1;
  const hash = computeContentHash(zoneName, settings, records);
  const info = db.prepare(`INSERT INTO revisions
    (zone_id, rev_no, status, content_hash, base_serial, primary_ns, admin_email, default_ttl, soa_refresh, soa_retry, soa_expire, soa_minimum, created_by)
    VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(zoneId, revNo, hash, baseSerial, settings.primary_ns, settings.admin_email,
      settings.default_ttl, settings.soa_refresh, settings.soa_retry, settings.soa_expire, settings.soa_minimum, userId);
  const revId = Number(info.lastInsertRowid);
  records.forEach((r, i) => insertRevisionRecord.run(revId, r.name, r.type, r.ttl, r.value, i));
  return revId;
});

function publishRecords(fileId, records, defaultTtl) {
  const ins = db.prepare('INSERT INTO published_records (published_file_id, name, type, ttl, value, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
  records.forEach((r, i) => {
    const ttl = r.ttl === null || r.ttl === undefined || r.ttl === '' ? defaultTtl : Number(r.ttl);
    ins.run(fileId, r.name, String(r.type).toUpperCase(), ttl, r.value, i);
  });
}

// ---------- 认证 ----------

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim());
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = newToken();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, Date.now() + SESSION_TTL_MS);
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
  audit(null, { id: user.id, username: user.username }, 'auth.login', null);
  res.json({ id: user.id, username: user.username, display_name: user.display_name });
});

app.post('/api/auth/logout', (req, res) => {
  const user = getSessionUser(req);
  if (user) {
    q.deleteSession.run(user.token);
    audit(null, user, 'auth.logout', null);
  }
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: '未登录' });
  res.json({ id: user.id, username: user.username, display_name: user.display_name });
});

// ---------- 区域 ----------

app.get('/api/zones', requireAuth, (req, res) => {
  const zones = db.prepare(`
    SELECT z.*,
      (SELECT MAX(serial) FROM published_files pf WHERE pf.zone_id = z.id) AS current_serial,
      (SELECT COUNT(*) FROM published_files pf WHERE pf.zone_id = z.id) AS publish_count
    FROM zones z ORDER BY z.name`).all();
  for (const z of zones) {
    z.open_revision = openRevisionOf(z.id);
  }
  res.json(zones);
});

app.post('/api/zones', requireAuth, (req, res) => {
  const b = req.body || {};
  const zone = normalizeZoneName(b.name);
  const settings = sanitizeSettings(b, {});
  const errors = validateZone({ zone, settings, records: [] })
    .filter((e) => e.field !== 'records'); // 新建区域允许暂无记录
  if (errors.length) {
    return res.status(422).json({ error: '区域设置验证失败', validation_errors: errors });
  }
  const exists = db.prepare('SELECT id FROM zones WHERE name = ?').get(zone);
  if (exists) return res.status(409).json({ error: `区域 ${zone} 已存在` });

  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO zones (name, primary_ns, admin_email, default_ttl, soa_refresh, soa_retry, soa_expire, soa_minimum)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(zone, settings.primary_ns, settings.admin_email, settings.default_ttl,
        settings.soa_refresh, settings.soa_retry, settings.soa_expire, settings.soa_minimum);
    const zoneId = Number(info.lastInsertRowid);
    const revId = createRevisionTx(zoneId, zone, settings, [], 0, req.user.id);
    audit(zoneId, req.user, 'zone.create', { zone, revision_id: revId });
    return { zoneId, revId };
  });
  const { zoneId } = tx();
  res.status(201).json({ id: zoneId, name: zone });
});

app.get('/api/zones/:id', requireAuth, (req, res) => {
  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(req.params.id);
  if (!zone) return res.status(404).json({ error: '区域不存在' });
  res.json({
    zone,
    current_serial: currentSerial(zone.id),
    open_revision: openRevisionOf(zone.id),
  });
});

app.get('/api/zones/:id/revisions', requireAuth, (req, res) => {
  const zone = db.prepare('SELECT id FROM zones WHERE id = ?').get(req.params.id);
  if (!zone) return res.status(404).json({ error: '区域不存在' });
  const rows = db.prepare(`SELECT r.id, r.rev_no, r.status, r.base_serial, r.version, r.created_at, r.updated_at, u.username AS author
                           FROM revisions r JOIN users u ON u.id = r.created_by
                           WHERE r.zone_id = ? ORDER BY r.rev_no DESC LIMIT 100`).all(zone.id);
  res.json(rows);
});

// 获取或创建当前打开的草稿；fresh=true 时作废旧草稿并基于最新发布版新建
app.post('/api/zones/:id/draft', requireAuth, (req, res) => {
  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(req.params.id);
  if (!zone) return res.status(404).json({ error: '区域不存在' });
  const fresh = !!(req.body && req.body.fresh);
  const open = openRevisionOf(zone.id);
  if (open && !fresh) return res.json({ revision_id: open.id, created: false });

  const tx = db.transaction(() => {
    if (open) {
      db.prepare(`UPDATE revisions SET status = 'superseded', updated_at = datetime('now') WHERE id = ?`).run(open.id);
      audit(zone.id, req.user, 'revision.supersede', { revision_id: open.id, reason: '基于最新发布版重建草稿' });
    }
    const serial = currentSerial(zone.id);
    const latest = latestPublished(zone.id);
    let settings = revisionSettings(zone);
    let records = [];
    if (latest) {
      settings = JSON.parse(latest.settings);
      records = db.prepare('SELECT name, type, ttl, value FROM published_records WHERE published_file_id = ? ORDER BY sort_order, id').all(latest.id);
    }
    const revId = createRevisionTx(zone.id, zone.name, settings, records, serial, req.user.id);
    audit(zone.id, req.user, 'revision.create', { revision_id: revId, base_serial: serial });
    return revId;
  });
  const revId = tx();
  res.status(201).json({ revision_id: revId, created: true });
});

// ---------- 修订版 ----------

app.get('/api/revisions/:id', requireAuth, (req, res) => {
  const rev = getRevisionRow(req.params.id);
  if (!rev) return res.status(404).json({ error: '修订版不存在' });
  const records = getRevisionRecords(rev.id);
  const reviews = getRevisionReviews(rev.id);
  const serial = currentSerial(rev.zone_id);
  const settings = revisionSettings(rev);
  const errors = validateZone({ zone: rev.zone_name, settings, records });
  res.json({
    revision: { ...rev, records, reviews },
    settings,
    current_serial: serial,
    stale: rev.base_serial !== serial,
    validation_errors: errors,
    approval: findValidApproval(rev),
  });
});

app.put('/api/revisions/:id', requireAuth, (req, res) => {
  const rev = getRevisionRow(req.params.id);
  if (!rev) return res.status(404).json({ error: '修订版不存在' });
  if (!OPEN_STATUSES.includes(rev.status)) {
    return res.status(409).json({ error: `修订版当前状态为 ${rev.status}，不可编辑` });
  }
  const b = req.body || {};
  if (Number(b.version) !== rev.version) {
    return res.status(409).json({ error: '该修订版已被其他人修改，请刷新后再试（未覆盖对方更改）', conflict: 'version' });
  }
  const settings = sanitizeSettings(b.settings, revisionSettings(rev));
  const records = sanitizeRecords(b.records);
  const hash = computeContentHash(rev.zone_name, settings, records);

  const tx = db.transaction(() => {
    db.prepare(`UPDATE revisions SET
        primary_ns = ?, admin_email = ?, default_ttl = ?, soa_refresh = ?, soa_retry = ?, soa_expire = ?, soa_minimum = ?,
        content_hash = ?, version = version + 1, status = 'draft', updated_at = datetime('now')
      WHERE id = ?`)
      .run(settings.primary_ns, settings.admin_email, settings.default_ttl, settings.soa_refresh,
        settings.soa_retry, settings.soa_expire, settings.soa_minimum, hash, rev.id);
    db.prepare('DELETE FROM revision_records WHERE revision_id = ?').run(rev.id);
    records.forEach((r, i) => insertRevisionRecord.run(rev.id, r.name, r.type, r.ttl, r.value, i));
    audit(rev.zone_id, req.user, 'revision.update', { revision_id: rev.id, record_count: records.length });
  });
  tx();
  res.json({ ok: true, version: rev.version + 1, content_hash: hash });
});

app.post('/api/revisions/:id/submit', requireAuth, (req, res) => {
  const rev = getRevisionRow(req.params.id);
  if (!rev) return res.status(404).json({ error: '修订版不存在' });
  if (!['draft', 'rejected'].includes(rev.status)) {
    return res.status(409).json({ error: `当前状态为 ${rev.status}，不能提交复核` });
  }
  const serial = currentSerial(rev.zone_id);
  if (rev.base_serial !== serial) {
    return res.status(409).json({
      error: `修订已过期：基于序列号 ${rev.base_serial}，当前发布版为 ${serial}。请基于最新发布版重建草稿，本次提交未生效。`,
      conflict: 'stale',
    });
  }
  const records = getRevisionRecords(rev.id);
  const errors = validateZone({ zone: rev.zone_name, settings: revisionSettings(rev), records });
  if (errors.length) {
    return res.status(422).json({ error: '整体验证失败，无法提交复核', validation_errors: errors });
  }
  db.prepare(`UPDATE revisions SET status = 'in_review', updated_at = datetime('now') WHERE id = ?`).run(rev.id);
  audit(rev.zone_id, req.user, 'revision.submit', { revision_id: rev.id });
  res.json({ ok: true });
});

app.post('/api/revisions/:id/review', requireAuth, (req, res) => {
  const rev = getRevisionRow(req.params.id);
  if (!rev) return res.status(404).json({ error: '修订版不存在' });
  if (rev.status !== 'in_review') {
    return res.status(409).json({ error: `当前状态为 ${rev.status}，不能复核` });
  }
  if (rev.created_by === req.user.id) {
    return res.status(403).json({ error: '不能复核自己提交的修订版，须由另一账号复核' });
  }
  const decision = req.body && req.body.decision;
  if (!['approve', 'reject'].includes(decision)) {
    return res.status(400).json({ error: 'decision 必须是 approve 或 reject' });
  }
  const comment = String((req.body && req.body.comment) || '').slice(0, 1000);
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO reviews (revision_id, reviewer_id, decision, comment, content_hash) VALUES (?, ?, ?, ?, ?)')
      .run(rev.id, req.user.id, decision, comment, rev.content_hash);
    db.prepare(`UPDATE revisions SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(decision === 'approve' ? 'approved' : 'rejected', rev.id);
    audit(rev.zone_id, req.user, 'revision.review', { revision_id: rev.id, decision, comment });
  });
  tx();
  res.json({ ok: true });
});

app.post('/api/revisions/:id/abandon', requireAuth, (req, res) => {
  const rev = getRevisionRow(req.params.id);
  if (!rev) return res.status(404).json({ error: '修订版不存在' });
  if (!OPEN_STATUSES.includes(rev.status)) {
    return res.status(409).json({ error: `当前状态为 ${rev.status}，不能作废` });
  }
  db.prepare(`UPDATE revisions SET status = 'superseded', updated_at = datetime('now') WHERE id = ?`).run(rev.id);
  audit(rev.zone_id, req.user, 'revision.abandon', { revision_id: rev.id });
  res.json({ ok: true });
});

app.post('/api/revisions/:id/publish', requireAuth, (req, res) => {
  const rev = getRevisionRow(req.params.id);
  if (!rev) return res.status(404).json({ error: '修订版不存在' });
  if (rev.status !== 'approved') {
    return res.status(409).json({ error: '修订版尚未通过复核，不能发布' });
  }
  const serial = currentSerial(rev.zone_id);
  if (rev.base_serial !== serial) {
    return res.status(409).json({
      error: `修订已过期：基于序列号 ${rev.base_serial}，当前发布版为 ${serial}。不会覆盖现行文件。`,
      conflict: 'stale',
    });
  }
  const approval = findValidApproval(rev);
  if (!approval) {
    return res.status(409).json({ error: '复核已失效（内容在复核后被修改）或缺少他人复核，不能发布' });
  }
  const settings = revisionSettings(rev);
  const records = getRevisionRecords(rev.id);
  const errors = validateZone({ zone: rev.zone_name, settings, records });
  if (errors.length) {
    return res.status(422).json({ error: '发布前整体验证失败，现行文件未被替换', validation_errors: errors });
  }

  const newSerial = serial + 1;
  const content = generateZoneFile({ zone: rev.zone_name, settings, records, serial: newSerial });
  const digest = sha256(content);

  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO published_files (zone_id, serial, revision_id, content, sha256, settings, note, published_by)
                             VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(rev.zone_id, newSerial, rev.id, content, digest, JSON.stringify(settings), req.user.id);
    const fileId = Number(info.lastInsertRowid);
    publishRecords(fileId, records, settings.default_ttl);
    db.prepare(`UPDATE revisions SET status = 'published', updated_at = datetime('now') WHERE id = ?`).run(rev.id);
    db.prepare(`UPDATE zones SET primary_ns = ?, admin_email = ?, default_ttl = ?, soa_refresh = ?, soa_retry = ?, soa_expire = ?, soa_minimum = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(settings.primary_ns, settings.admin_email, settings.default_ttl, settings.soa_refresh,
        settings.soa_retry, settings.soa_expire, settings.soa_minimum, rev.zone_id);
    audit(rev.zone_id, req.user, 'revision.publish', { revision_id: rev.id, serial: newSerial, sha256: digest });
    return fileId;
  });
  const fileId = tx();
  res.json({ ok: true, serial: newSerial, file_id: fileId });
});

app.get('/api/revisions/:id/diff', requireAuth, (req, res) => {
  const rev = getRevisionRow(req.params.id);
  if (!rev) return res.status(404).json({ error: '修订版不存在' });
  const records = getRevisionRecords(rev.id);
  const settings = revisionSettings(rev);
  const latest = latestPublished(rev.zone_id);
  const oldRecords = latest
    ? db.prepare('SELECT name, type, ttl, value FROM published_records WHERE published_file_id = ? ORDER BY sort_order, id').all(latest.id)
    : [];
  const oldSettings = latest ? JSON.parse(latest.settings) : null;
  const diff = diffRecords(oldRecords, oldSettings ? oldSettings.default_ttl : settings.default_ttl,
    records, settings.default_ttl, rev.zone_name);
  res.json({
    base_serial: rev.base_serial,
    current_serial: currentSerial(rev.zone_id),
    old_settings: oldSettings,
    new_settings: settings,
    ...diff,
  });
});

// ---------- 无状态校验（编辑器实时校验用） ----------

app.post('/api/validate', requireAuth, (req, res) => {
  const b = req.body || {};
  const errors = validateZone({
    zone: b.zone,
    settings: sanitizeSettings(b.settings, {}),
    records: sanitizeRecords(b.records),
  });
  res.json({ errors });
});

// ---------- 已发布文件 ----------

app.get('/api/zones/:id/files', requireAuth, (req, res) => {
  const zone = db.prepare('SELECT id FROM zones WHERE id = ?').get(req.params.id);
  if (!zone) return res.status(404).json({ error: '区域不存在' });
  const rows = db.prepare(`SELECT pf.id, pf.serial, pf.sha256, pf.note, pf.published_at, pf.revision_id, u.username AS published_by
                           FROM published_files pf JOIN users u ON u.id = pf.published_by
                           WHERE pf.zone_id = ? ORDER BY pf.serial DESC`).all(zone.id);
  res.json(rows);
});

function getFileRow(id) {
  return db.prepare(`SELECT pf.*, z.name AS zone_name, u.username AS published_by_name
                     FROM published_files pf
                     JOIN zones z ON z.id = pf.zone_id
                     JOIN users u ON u.id = pf.published_by
                     WHERE pf.id = ?`).get(id);
}

app.get('/api/files/:id', requireAuth, (req, res) => {
  const f = getFileRow(req.params.id);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  const records = db.prepare('SELECT name, type, ttl, value FROM published_records WHERE published_file_id = ? ORDER BY sort_order, id').all(f.id);
  res.json({ ...f, settings: JSON.parse(f.settings), records });
});

app.get('/api/files/:id/download', requireAuth, (req, res) => {
  const f = getFileRow(req.params.id);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="db.${f.zone_name}"`);
  res.send(f.content);
});

// 回滚：以旧发布版内容生成新的、序列号更大的发布文件
app.post('/api/files/:id/rollback', requireAuth, (req, res) => {
  const f = getFileRow(req.params.id);
  if (!f) return res.status(404).json({ error: '文件不存在' });
  const serial = currentSerial(f.zone_id);
  if (f.serial === serial) {
    return res.status(409).json({ error: '该版本就是当前发布版，无需回滚' });
  }
  const records = db.prepare('SELECT name, type, ttl, value FROM published_records WHERE published_file_id = ? ORDER BY sort_order, id').all(f.id);
  const settings = JSON.parse(f.settings);
  const errors = validateZone({ zone: f.zone_name, settings, records });
  if (errors.length) {
    return res.status(422).json({ error: '旧版本内容未通过当前验证规则，无法回滚', validation_errors: errors });
  }
  const newSerial = serial + 1;
  const content = generateZoneFile({ zone: f.zone_name, settings, records, serial: newSerial });
  const digest = sha256(content);
  const note = `回滚自序列号 ${f.serial}`;

  const tx = db.transaction(() => {
    const info = db.prepare(`INSERT INTO published_files (zone_id, serial, revision_id, content, sha256, settings, note, published_by)
                             VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`)
      .run(f.zone_id, newSerial, content, digest, JSON.stringify(settings), note, req.user.id);
    const fileId = Number(info.lastInsertRowid);
    publishRecords(fileId, records, settings.default_ttl);
    db.prepare(`UPDATE zones SET primary_ns = ?, admin_email = ?, default_ttl = ?, soa_refresh = ?, soa_retry = ?, soa_expire = ?, soa_minimum = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(settings.primary_ns, settings.admin_email, settings.default_ttl, settings.soa_refresh,
        settings.soa_retry, settings.soa_expire, settings.soa_minimum, f.zone_id);
    audit(f.zone_id, req.user, 'file.rollback', { from_serial: f.serial, new_serial: newSerial, sha256: digest });
    return fileId;
  });
  const fileId = tx();
  res.json({ ok: true, serial: newSerial, file_id: fileId });
});

// ---------- 审计 ----------

app.get('/api/audit', requireAuth, (req, res) => {
  const zoneId = req.query.zone_id ? Number(req.query.zone_id) : null;
  const rows = zoneId
    ? db.prepare('SELECT * FROM audit_log WHERE zone_id = ? ORDER BY id DESC LIMIT 500').all(zoneId)
    : db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500').all();
  res.json(rows);
});

// ---------- 静态资源与 SPA 回退 ----------

const distDir = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[server] 未处理错误:', err);
  res.status(500).json({ error: '服务器内部错误' });
});

setInterval(() => {
  try {
    q.deleteExpiredSessions.run(Date.now());
  } catch { /* 忽略 */ }
}, 3600 * 1000).unref();

app.listen(PORT, () => {
  console.log(`[server] DNS 区域审定台已启动: http://localhost:${PORT}`);
  console.log(`[server] 数据库文件: ${process.env.DB_PATH || path.join(__dirname, '..', 'data', 'dnszone.db')}`);
});
