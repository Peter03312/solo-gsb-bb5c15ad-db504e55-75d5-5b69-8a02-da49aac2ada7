'use strict';
const express = require('express');
const path = require('path');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { db, sessionStore, audit } = require('./db');
const { validateContent } = require('./validate');
const { contentHash, nextSerial, renderZoneFile, diffContent, canonicalJSON } = require('./zonefile');

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use(session({
  name: 'dzc.sid',
  secret: process.env.SESSION_SECRET || 'offline-dns-zone-console-secret-change-me',
  resave: false,
  saveUninitialized: false,
  store: sessionStore,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 12 * 60 * 60 * 1000
  }
}));

// ---------- 工具 ----------
class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; Object.assign(this, extra); }
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: '未登录或会话已过期' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) return res.status(401).json({ error: '未登录' });
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: '当前角色无权执行此操作' });
    }
    next();
  };
}

function sanitizeContent(input) {
  const c = input && typeof input === 'object' ? input : {};
  const str = (v) => (v == null ? '' : String(v));
  const ttl = (v) => {
    const s = str(v).trim();
    if (s === '') return '';
    return /^\d+$/.test(s) ? Number(s) : s;
  };
  const records = Array.isArray(c.records) ? c.records.map((r, i) => {
    const out = {
      id: r && r.id != null ? String(r.id) : `r${i + 1}`,
      name: str(r.name).trim(),
      type: str(r.type).trim().toUpperCase(),
      ttl: ttl(r.ttl),
      value: str(r.value).trim()
    };
    if (out.type === 'MX') out.priority = str(r.priority).trim();
    return out;
  }).filter((r) => r.name || r.type || r.value || (r.ttl !== '')) : [];
  return {
    zoneName: str(c.zoneName).trim(),
    mname: str(c.mname).trim(),
    rname: str(c.rname).trim(),
    records
  };
}

function getZoneOr404(zoneId) {
  const zone = db.prepare('SELECT * FROM zones WHERE id = ?').get(zoneId);
  if (!zone) throw new HttpError(404, '区域不存在');
  return zone;
}
function getRevision(zone, revId) {
  const rev = db.prepare('SELECT * FROM revisions WHERE id = ? AND zone_id = ?').get(revId, zone.id);
  if (!rev) throw new HttpError(404, '修订版不存在');
  return rev;
}
function latestPublished(zoneId) {
  return db.prepare('SELECT * FROM published_versions WHERE zone_id = ? ORDER BY id DESC LIMIT 1').get(zoneId) || null;
}

function buildZoneDetail(zoneId) {
  const zone = db.prepare('SELECT z.*, (SELECT COUNT(*) FROM published_versions v WHERE v.zone_id = z.id) AS published_count FROM zones z WHERE z.id = ?').get(zoneId);
  if (!zone) throw new HttpError(404, '区域不存在');
  const rev = db.prepare('SELECT * FROM revisions WHERE id = ?').get(zone.current_revision_id);
  const content = rev ? JSON.parse(rev.content) : null;
  const validReviews = rev ? db.prepare(`
    SELECT rv.id, rv.comment, rv.created_at, u.id AS user_id, u.username, u.display_name
    FROM reviews rv JOIN users u ON u.id = rv.reviewer_id
    WHERE rv.revision_id = ? AND rv.is_valid = 1`).all(rev.id) : [];
  const pub = latestPublished(zone.id);
  const validation = validateContent(sanitizeContent(content || {}));
  return {
    id: zone.id,
    name: zone.name,
    revision: rev ? {
      id: rev.id,
      revNo: rev.rev_no,
      content,
      contentHash: rev.content_hash,
      createdBy: rev.created_by,
      createdAt: rev.created_at,
      rollbackFromVersion: rev.rollback_from_version,
      validReviews
    } : null,
    latestPublished: pub ? {
      id: pub.id, serial: pub.serial, revisionId: pub.revision_id,
      contentHash: pub.content_hash, publishedBy: pub.published_by,
      action: pub.action, publishedAt: pub.published_at
    } : null,
    draftValid: validation.valid,
    draftErrors: validation.errors
  };
}

// ---------- 认证 ----------
app.post('/api/auth/login', (req, res, next) => {
  try {
    const username = String(req.body.username || '').trim();
    const password = String(req.body.password || '');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      audit(null, username, 'login_failed', '账号或密码错误');
      throw new HttpError(401, '账号或密码错误');
    }
    req.session.user = { id: user.id, username: user.username, displayName: user.display_name, role: user.role };
    audit(user.id, user.username, 'login', '登录成功');
    res.json({ user: req.session.user });
  } catch (e) { next(e); }
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session.user) audit(req.session.user.id, req.session.user.username, 'logout', '退出登录');
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

// ---------- 区域 ----------
app.get('/api/zones', requireAuth, (req, res, next) => {
  try {
    const zones = db.prepare(`
      SELECT z.id, z.name, z.created_at, r.rev_no,
             (SELECT serial FROM published_versions v WHERE v.zone_id = z.id ORDER BY v.id DESC LIMIT 1) AS last_serial,
             (SELECT COUNT(*) FROM published_versions v WHERE v.zone_id = z.id) AS published_count
      FROM zones z
      LEFT JOIN revisions r ON r.id = z.current_revision_id
      ORDER BY z.id`).all();
    res.json({ zones });
  } catch (e) { next(e); }
});

app.post('/api/zones', requireRole('admin', 'editor'), (req, res, next) => {
  try {
    const name = String(req.body.name || '').trim().toLowerCase();
    const check = validateContent({
      zoneName: name,
      mname: req.body.mname,
      rname: req.body.rname,
      records: Array.isArray(req.body.records) ? req.body.records : []
    });
    if (!check.valid) throw new HttpError(422, '区域内容验证未通过', { errors: check.errors });

    if (db.prepare('SELECT id FROM zones WHERE name = ?').get(check.normalized.zoneName.replace(/\.$/, ''))) {
      throw new HttpError(409, '同名区域已存在');
    }

    const result = db.transaction(() => {
      const zoneName = check.normalized.zoneName.replace(/\.$/, ''); // 内部标识不带尾点，渲染时补点
      const zoneId = db.prepare('INSERT INTO zones (name, created_by) VALUES (?, ?)')
        .run(zoneName, req.session.user.id).lastInsertRowid;
      const content = check.normalized;
      const revId = db.prepare(`INSERT INTO revisions (zone_id, rev_no, is_current, content, content_hash, created_by)
                                VALUES (?, 1, 1, ?, ?, ?)`)
        .run(zoneId, canonicalJSON(content), contentHash(content), req.session.user.id).lastInsertRowid;
      db.prepare('UPDATE zones SET current_revision_id = ? WHERE id = ?').run(revId, zoneId);
      audit(req.session.user.id, req.session.user.username, 'zone_create', `创建区域 ${check.normalized.zoneName} rev#1`);
      return { zoneId, revId };
    })();
    res.status(201).json(buildZoneDetail(result.zoneId));
  } catch (e) { next(e); }
});

app.get('/api/zones/:id', requireAuth, (req, res, next) => {
  try { res.json(buildZoneDetail(Number(req.params.id))); } catch (e) { next(e); }
});

// 仅校验当前草稿（不入库）
app.post('/api/zones/:id/validate', requireAuth, (req, res, next) => {
  try {
    const zone = getZoneOr404(Number(req.params.id));
    const content = sanitizeContent(req.body.content);
    const result = validateContent(content);
    res.json({ valid: result.valid, errors: result.errors, normalized: result.normalized });
  } catch (e) { next(e); }
});

// 差异（默认 当前草稿 vs 最新发布；也可指定 revisionId）
app.get('/api/zones/:id/diff', requireAuth, (req, res, next) => {
  try {
    const zone = getZoneOr404(Number(req.params.id));
    const pub = latestPublished(zone.id);
    const from = pub ? JSON.parse(pub.content) : null;

    let to, revId, label;
    if (req.query.revisionId) {
      const rev = getRevision(zone, Number(req.query.revisionId));
      to = JSON.parse(rev.content);
      revId = rev.id; label = `修订版 #${rev.rev_no}`;
    } else {
      const cur = db.prepare('SELECT * FROM revisions WHERE id = ?').get(zone.current_revision_id);
      if (!cur) throw new HttpError(409, '区域尚无工作修订版');
      to = JSON.parse(cur.content);
      revId = cur.id; label = `当前草稿 #${cur.rev_no}`;
    }
    const diff = diffContent(from, to);
    res.json({
      ...diff,
      from: pub ? { versionId: pub.id, serial: pub.serial, action: pub.action, publishedAt: pub.published_at } : null,
      to: { revisionId: revId, label }
    });
  } catch (e) { next(e); }
});

// 暂存草稿（无需通过验证；编辑使旧复核失效）
app.put('/api/zones/:id/draft', requireRole('admin', 'editor'), (req, res, next) => {
  try {
    const zone = getZoneOr404(Number(req.params.id));
    const baseRevisionId = req.body.baseRevisionId != null ? Number(req.body.baseRevisionId) : null;
    const content = sanitizeContent(req.body.content);
    // 区域名创建后不可变：以数据库中的区域名为准
    content.zoneName = zone.name;

    const outcome = db.transaction(() => {
      const cur = db.prepare('SELECT * FROM revisions WHERE id = ?').get(zone.current_revision_id);
      if (!cur) throw new HttpError(409, '区域尚无工作修订版');
      if (baseRevisionId != null && baseRevisionId !== cur.id) {
        throw new HttpError(409, `冲突：草稿已由他人更新（当前为修订版 ${cur.rev_no}），请刷新后重新编辑`, {
          currentRevisionId: cur.id, currentRevNo: cur.rev_no
        });
      }
      const hash = contentHash(content);
      if (hash === cur.content_hash) {
        return { unchanged: true, revision: cur };
      }
      const nextNo = db.prepare('SELECT COALESCE(MAX(rev_no), 0) + 1 AS n FROM revisions WHERE zone_id = ?').get(zone.id).n;
      const newId = db.prepare(`INSERT INTO revisions (zone_id, rev_no, is_current, content, content_hash, created_by)
                                VALUES (?, ?, 1, ?, ?, ?)`)
        .run(zone.id, nextNo, canonicalJSON(content), hash, req.session.user.id).lastInsertRowid;
      db.prepare('UPDATE revisions SET is_current = 0 WHERE id = ?').run(cur.id);
      db.prepare('UPDATE zones SET current_revision_id = ? WHERE id = ?').run(newId, zone.id);
      audit(req.session.user.id, req.session.user.username, 'draft_save', `${zone.name} 草稿暂存为修订版 #${nextNo}，旧复核已失效`);
      return { unchanged: false, revision: db.prepare('SELECT * FROM revisions WHERE id = ?').get(newId) };
    })();
    res.json({ ...buildZoneDetail(zone.id), saved: !outcome.unchanged, unchanged: outcome.unchanged });
  } catch (e) { next(e); }
});

// 提交复核意见（approve 才计入；须与编辑者不同账号）
app.post('/api/zones/:id/reviews', requireRole('admin', 'reviewer'), (req, res, next) => {
  try {
    const zone = getZoneOr404(Number(req.params.id));
    const decision = String(req.body.decision || '').toLowerCase();
    const revisionId = req.body.revisionId != null ? Number(req.body.revisionId) : zone.current_revision_id;
    const comment = String(req.body.comment || '').trim();
    if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'decision 必须为 approve 或 reject');

    db.transaction(() => {
      const rev = getRevision(zone, revisionId);
      if (rev.id !== zone.current_revision_id) {
        throw new HttpError(409, `冲突：修订版 #${rev.rev_no} 已过期，当前草稿为另一修订版，请刷新后复核`);
      }
      if (rev.created_by === req.session.user.id) {
        throw new HttpError(403, '复核账号必须与编辑账号不同（四眼原则），不能复核自己的修订');
      }
      if (decision === 'approve') {
        const dup = db.prepare('SELECT id FROM reviews WHERE revision_id = ? AND reviewer_id = ? AND is_valid = 1').get(rev.id, req.session.user.id);
        if (dup) throw new HttpError(409, '你已复核通过该修订版，无需重复复核');
      }
      db.prepare('INSERT INTO reviews (revision_id, reviewer_id, comment, is_valid) VALUES (?, ?, ?, ?)')
        .run(rev.id, req.session.user.id, comment, decision === 'approve' ? 1 : 0);
      audit(req.session.user.id, req.session.user.username,
        decision === 'approve' ? 'review_approve' : 'review_reject',
        `${zone.name} 修订版 #${rev.rev_no}：${comment || '(无意见)'}`);
    })();
    res.json(buildZoneDetail(zone.id));
  } catch (e) { next(e); }
});

// 发布当前工作修订版（回滚发布同理：回滚会先生成新草稿，复核通过后再发布）
app.post('/api/zones/:id/publish', requireRole('admin', 'editor'), (req, res, next) => {
  try {
    const zone = getZoneOr404(Number(req.params.id));
    const expectedRevisionId = req.body.revisionId != null ? Number(req.body.revisionId) : null;
    const expectedHash = req.body.contentHash != null ? String(req.body.contentHash) : null;

    const result = db.transaction(() => {
      const cur = db.prepare('SELECT * FROM revisions WHERE id = ?').get(zone.current_revision_id);
      if (!cur) throw new HttpError(409, '区域尚无工作修订版');

      if (expectedRevisionId != null && expectedRevisionId !== cur.id) {
        throw new HttpError(409, `冲突：你复核的修订版已过期（当前为修订版 #${cur.rev_no}），发布被拒绝且未做任何改动`, {
          currentRevisionId: cur.id, currentRevNo: cur.rev_no
        });
      }
      if (expectedHash && expectedHash !== cur.content_hash) {
        throw new HttpError(409, '冲突：修订内容在复核后发生了变化，发布被拒绝且未做任何改动', {
          currentRevisionId: cur.id, currentRevNo: cur.rev_no
        });
      }

      let publishContent = JSON.parse(cur.content);

      // 发布前整体验证
      const check = validateContent(publishContent);
      if (!check.valid) {
        throw new HttpError(422, '发布验证未通过，现行文件保持不变', { errors: check.errors });
      }
      publishContent = check.normalized;

      // 四眼复核：存在编辑者（created_by）以外账号的有效「通过」记录
      const approvals = db.prepare(`SELECT reviewer_id FROM reviews WHERE revision_id = ? AND is_valid = 1`).all(cur.id);
      const otherApproval = approvals.find((a) => a.reviewer_id !== cur.created_by);
      if (!otherApproval) {
        throw new HttpError(403, '发布被拒绝：需要由编辑者以外的另一账号复核通过当前修订版后才能发布');
      }

      const pubRow = latestPublished(zone.id);
      if (pubRow && canonicalJSON(JSON.parse(pubRow.content)) === canonicalJSON(publishContent)) {
        throw new HttpError(409, '待发布内容与当前发布版完全相同，无发布必要');
      }

      const serial = nextSerial(pubRow ? pubRow.serial : 0);
      const zoneFile = renderZoneFile(publishContent, serial);
      const hash = contentHash(publishContent);
      const action = cur.rollback_from_version ? 'rollback' : 'publish';

      const versionId = db.prepare(`INSERT INTO published_versions
        (zone_id, revision_id, serial, content, content_hash, zone_file, published_by, action)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(zone.id, cur.id, serial, canonicalJSON(publishContent), hash, zoneFile, req.session.user.id, action).lastInsertRowid;

      // 发布后用已发布内容开新草稿（下一轮编辑），旧修订保留为不可变历史
      const nextNo = db.prepare('SELECT COALESCE(MAX(rev_no), 0) + 1 AS n FROM revisions WHERE zone_id = ?').get(zone.id).n;
      const newRevId = db.prepare(`INSERT INTO revisions (zone_id, rev_no, is_current, content, content_hash, created_by)
                                   VALUES (?, ?, 1, ?, ?, ?)`)
        .run(zone.id, nextNo, canonicalJSON(publishContent), hash, req.session.user.id).lastInsertRowid;
      db.prepare('UPDATE revisions SET is_current = 0 WHERE is_current = 1 AND zone_id = ?').run(zone.id);
      db.prepare('UPDATE revisions SET is_current = 1 WHERE id = ?').run(newRevId);
      db.prepare('UPDATE zones SET current_revision_id = ? WHERE id = ?').run(newRevId, zone.id);

      audit(req.session.user.id, req.session.user.username,
        action === 'rollback' ? 'rollback_publish' : 'publish',
        `${zone.name} 序列号 ${serial}（来源修订版 #${cur.rev_no}）`);

      return { versionId, serial };
    })();
    res.json({ ...buildZoneDetail(zone.id), published: result });
  } catch (e) { next(e); }
});

// 回滚：以历史已发布版本内容生成新的工作草稿（不改动任何已发布文件；须重新复核后才能发布）
app.post('/api/zones/:id/rollback', requireRole('admin', 'editor'), (req, res, next) => {
  try {
    const zone = getZoneOr404(Number(req.params.id));
    const versionId = Number(req.body.versionId);
    if (!Number.isInteger(versionId)) throw new HttpError(400, '缺少 versionId');

    db.transaction(() => {
      const old = db.prepare('SELECT * FROM published_versions WHERE id = ? AND zone_id = ?').get(versionId, zone.id);
      if (!old) throw new HttpError(404, '回滚目标版本不存在');
      const cur = db.prepare('SELECT * FROM revisions WHERE id = ?').get(zone.current_revision_id);

      const content = JSON.parse(old.content);
      const hash = contentHash(content);
      if (cur && hash === cur.content_hash) {
        throw new HttpError(409, '当前草稿内容已与所选历史版本一致，无需回滚');
      }
      const nextNo = db.prepare('SELECT COALESCE(MAX(rev_no), 0) + 1 AS n FROM revisions WHERE zone_id = ?').get(zone.id).n;
      const newId = db.prepare(`INSERT INTO revisions (zone_id, rev_no, is_current, content, content_hash, rollback_from_version, created_by)
                                VALUES (?, ?, 1, ?, ?, ?, ?)`)
        .run(zone.id, nextNo, canonicalJSON(content), hash, old.id, req.session.user.id).lastInsertRowid;
      if (cur) db.prepare('UPDATE revisions SET is_current = 0 WHERE id = ?').run(cur.id);
      db.prepare('UPDATE zones SET current_revision_id = ? WHERE id = ?').run(newId, zone.id);
      audit(req.session.user.id, req.session.user.username, 'rollback_draft',
        `${zone.name} 以序列号 ${old.serial} 的历史版本创建回滚草稿 #${nextNo}，待复核发布`);
    })();
    res.json(buildZoneDetail(zone.id));
  } catch (e) { next(e); }
});

// 历史发布版本
app.get('/api/zones/:id/versions', requireAuth, (req, res, next) => {
  try {
    const zone = getZoneOr404(Number(req.params.id));
    const versions = db.prepare(`
      SELECT v.id, v.serial, v.action, v.revision_id, v.content_hash, v.published_by, v.published_at,
             u.username AS published_by_name
      FROM published_versions v JOIN users u ON u.id = v.published_by
      WHERE v.zone_id = ? ORDER BY v.id DESC`).all(zone.id);
    res.json({ versions });
  } catch (e) { next(e); }
});

// 下载已发布区域文件（只从不可变表中取，绝不现场生成替换）
app.get('/api/zones/:id/versions/:vid/download', requireAuth, (req, res, next) => {
  try {
    const zone = getZoneOr404(Number(req.params.id));
    const v = db.prepare('SELECT * FROM published_versions WHERE id = ? AND zone_id = ?').get(Number(req.params.vid), zone.id);
    if (!v) throw new HttpError(404, '发布版本不存在');
    const fname = `${zone.name.replace(/\.$/, '')}-${v.serial}.zone`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
    audit(req.session.user.id, req.session.user.username, 'download', `${zone.name} 序列号 ${v.serial}`);
    res.send(v.zone_file);
  } catch (e) { next(e); }
});

// 复核历史
app.get('/api/zones/:id/reviews', requireAuth, (req, res, next) => {
  try {
    const zone = getZoneOr404(Number(req.params.id));
    const rows = db.prepare(`
      SELECT rv.id, rv.revision_id, r.rev_no, rv.comment, rv.is_valid, rv.created_at,
             u.username, u.display_name
      FROM reviews rv
      JOIN users u ON u.id = rv.reviewer_id
      JOIN revisions r ON r.id = rv.revision_id
      WHERE r.zone_id = ?
      ORDER BY rv.id DESC LIMIT 200`).all(zone.id);
    res.json({ reviews: rows });
  } catch (e) { next(e); }
});

// ---------- 审计与用户 ----------
app.get('/api/audit', requireRole('admin'), (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 200, 1000);
    const rows = db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?').all(limit);
    res.json({ entries: rows });
  } catch (e) { next(e); }
});

app.get('/api/users', requireAuth, (req, res, next) => {
  try {
    const users = db.prepare('SELECT id, username, display_name, role FROM users ORDER BY id').all();
    res.json({ users });
  } catch (e) { next(e); }
});

// ---------- 静态前端 ----------
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get(/^(?!\/api\/).*/, (req, res, next) => {
  res.sendFile(path.join(clientDist, 'index.html'), (err) => { if (err) next(); });
});

// ---------- 错误处理 ----------
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: err.message || '服务器内部错误',
    ...(err.errors ? { errors: err.errors } : {}),
    ...(err.currentRevisionId ? { currentRevisionId: err.currentRevisionId, currentRevNo: err.currentRevNo } : {})
  });
});

const PORT = Number(process.env.PORT || 8080);
app.listen(PORT, '0.0.0.0', () => {
  console.log(`DNS Zone Console listening on http://0.0.0.0:${PORT}`);
});
