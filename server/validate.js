'use strict';
// DNS 记录整体验证。返回 { valid, errors:[{recordId, index, field, reason}], normalized }
// normalized 为规范化内容（值均为大写 FQDN 等），仅在验证通过时有意义。

const TYPE_TTLS = new Set(['NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT']);

// ---------- IPv4 ----------
function parseIPv4(s) {
  const parts = String(s).trim().split('.');
  if (parts.length !== 4) return null;
  const out = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    if (p.length > 1 && p[0] === '0') return null; // 拒绝前导零，避免歧义
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out.join('.');
}

// ---------- IPv6 ----------
function parseIPv6(input) {
  const s = String(input).trim();
  if (!s || s.length > 45) return null;

  // 提取末尾内嵌 IPv4
  let v6 = s;
  let v4Groups = null;
  const lastColon = s.lastIndexOf(':');
  const tail = lastColon >= 0 ? s.slice(lastColon + 1) : s;
  if (tail.includes('.')) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const [a, b, c, d] = v4.split('.').map(Number);
    v4Groups = [(a << 8) | b, (c << 8) | d];
    v6 = s.slice(0, lastColon + 1) + '0:0';
  }

  const doubles = (v6.match(/::/g) || []).length;
  if (doubles > 1) return null;

  let head, tailGroups;
  if (v6.includes('::')) {
    const [l, r] = v6.split('::');
    head = l === '' ? [] : l.split(':');
    tailGroups = r === '' ? [] : r.split(':');
  } else {
    const g = v6.split(':');
    head = g;
    tailGroups = [];
  }
  if (head.some((x) => x === '') || tailGroups.some((x) => x === '')) return null;

  const h16 = (x) => /^[0-9a-fA-F]{1,4}$/.test(x);
  if (!head.every(h16) || !tailGroups.every(h16)) return null;

  const explicit = head.length + tailGroups.length + (v4Groups ? 2 : 0);
  const target = 8;
  let groups;
  if (doubles === 1) {
    const missing = target - explicit;
    if (missing < 0) return null;
    groups = head.map((x) => parseInt(x, 16));
    for (let i = 0; i < missing; i++) groups.push(0);
    groups.push(...tailGroups.map((x) => parseInt(x, 16)));
  } else {
    if (explicit !== target) return null;
    groups = head.map((x) => parseInt(x, 16));
  }
  if (v4Groups) { groups.push(...v4Groups); }
  if (groups.length !== 8) return null;

  return groups.map((g) => g.toString(16)).join(':'); // 压缩仅小写，不做 :: 简写
}

// ---------- 域名 ----------
// { name, labels, fqdn, isFqdn } 或 null。allowUnderscore 用于记录属主；allowWildcard 用于记录属主。
function parseName(raw, { allowUnderscore = false, allowWildcard = false } = {}) {
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (!s) return null;
  if (s.length > 255) return null;

  const isFqdn = s.endsWith('.');
  if (isFqdn) s = s.slice(0, -1);
  if (!s) return null;

  const labels = s.split('.');
  for (let i = 0; i < labels.length; i++) {
    const lab = labels[i];
    if (!lab) return null; // 空标签（连续点）
    if (allowWildcard && i === 0 && lab === '*') continue;
    const labelOk = (lab) => allowUnderscore
      ? /^[A-Za-z0-9_]([A-Za-z0-9_-]*[A-Za-z0-9_])?$/.test(lab)
      : /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(lab);
    if (!labelOk(lab)) return null;
    if (lab.length > 63) return null;
  }
  return { name: s, labels, fqdn: s.toLowerCase() + '.', isFqdn };
}

function parseEmail(raw, zoneFqdn) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  // 优先按邮箱处理：local@domain
  const at = s.lastIndexOf('@');
  if (at > 0) {
    const local = s.slice(0, at);
    const domain = s.slice(at + 1);
    const d = parseName(domain);
    if (!d) return null;
    if (!/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9._-])?$/.test(local)) return null;
    if (local.includes('@')) return null;
    const encLocal = local.replace(/\./g, '\\.');
    return `${encLocal}.${d.fqdn}`;
  }
  // 否则视为已编码的 rname（相对名补区域原点）
  const r = parseName(s, { allowUnderscore: true });
  if (!r) return null;
  return r.isFqdn ? r.fqdn : `${r.fqdn}${zoneFqdn}`;
}

function toFqdn(name, zoneFqdn) {
  if (typeof name === 'string' && name.trim() === '@') return zoneFqdn;
  const p = parseName(name, { allowUnderscore: true, allowWildcard: true });
  if (!p) return null;
  return p.isFqdn ? p.fqdn : `${p.fqdn}${zoneFqdn}`;
}

// NS/CNAME/MX 目标：必须为完整 FQDN（以点结尾）；CNAME 额外允许 @（指向区域顶点）
function targetFqdn(value, zoneFqdn, { allowApexRef = false } = {}) {
  if (allowApexRef && typeof value === 'string' && value.trim() === '@') return zoneFqdn;
  const p = parseName(value);
  if (!p) return null;
  if (!p.isFqdn) return undefined; // 存在但不是 FQDN
  return p.fqdn;
}

function isWithinZone(fqdn, zoneFqdn) {
  return fqdn === zoneFqdn || fqdn.endsWith('.' + zoneFqdn);
}

// ---------- 入口 ----------
function validateContent(content) {
  const errors = [];
  const err = (recordId, index, field, reason) => errors.push({ recordId: recordId || null, index, field, reason });

  const zone = parseName(content && content.zoneName);
  if (!zone) err(null, -1, 'zoneName', '区域名不是合法域名');

  const mname = content && content.mname ? parseName(content.mname) : null;
  if (!content || !String(content.mname || '').trim()) err(null, -1, 'mname', '主 DNS 不能为空');
  else if (!mname) err(null, -1, 'mname', '主 DNS 不是合法域名');
  else if (!mname.isFqdn) err(null, -1, 'mname', '主 DNS 必须为以点结尾的完整域名（FQDN）');

  let rname = null;
  if (zone) {
    rname = parseEmail(content ? content.rname : '', zone.fqdn);
    if (!rname) err(null, -1, 'rname', '管理员邮箱无效（应为 name@example.org 形式）');
  } else if (!content || !String(content.rname || '').trim()) {
    err(null, -1, 'rname', '管理员邮箱不能为空');
  }

  const rawRecords = Array.isArray(content && content.records) ? content.records : [];
  const records = [];

  rawRecords.forEach((rec, i) => {
    const type = String(rec.type || '').toUpperCase();
    const name = typeof rec.name === 'string' ? rec.name.trim() : '';
    const value = typeof rec.value === 'string' ? rec.value.trim() : '';
    const rid = rec.id != null ? rec.id : null;

    if (!TYPE_TTLS.has(type)) { err(rid, i, 'type', `不支持的记录类型：${rec.type || '(空)'}`); return; }

    // TTL
    const ttlRaw = rec.ttl;
    const ttl = typeof ttlRaw === 'string' && ttlRaw.trim() !== '' ? Number(ttlRaw.trim()) : ttlRaw;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > 2147483647) {
      err(rid, i, 'ttl', 'TTL 必须为正整数');
    }

    // 属主名
    if (!name) { err(rid, i, 'name', '记录名不能为空'); return; }
    const ownerFqdn = zone ? toFqdn(name, zone.fqdn) : null;
    if (zone && !ownerFqdn) { err(rid, i, 'name', `记录名 "${name}" 不是合法域名`); return; }
    if (zone && !isWithinZone(ownerFqdn, zone.fqdn)) {
      err(rid, i, 'name', `记录名 ${ownerFqdn} 不属于区域 ${zone.fqdn}`);
    }
    const isApex = ownerFqdn === (zone && zone.fqdn);

    let normValue = null;
    let priority = null;

    switch (type) {
      case 'A': {
        const v4 = parseIPv4(value);
        if (!v4) err(rid, i, 'value', `A 记录地址无效：${value || '(空)'}`);
        else normValue = v4;
        break;
      }
      case 'AAAA': {
        const v6 = parseIPv6(value);
        if (!v6) err(rid, i, 'value', `AAAA 记录地址无效：${value || '(空)'}`);
        else normValue = v6;
        break;
      }
      case 'NS':
      case 'CNAME': {
        const t = zone ? targetFqdn(value, zone.fqdn, { allowApexRef: type === 'CNAME' }) : parseName(value);
        if (t === undefined) err(rid, i, 'value', `${type} 目标必须为以点结尾的完整域名（FQDN）：${value || '(空)'}`);
        else if (!t) err(rid, i, 'value', `${type} 目标不是合法域名：${value || '(空)'}`);
        else normValue = t;
        if (type === 'CNAME' && isApex) err(rid, i, 'name', 'CNAME 不得位于区域顶点');
        break;
      }
      case 'MX': {
        const priStr = String(rec.priority == null ? '' : rec.priority).trim();
        const pri = Number(priStr);
        if (!/^\d+$/.test(priStr) || !Number.isInteger(pri) || pri < 0 || pri > 65535) {
          err(rid, i, 'priority', 'MX 优先级必须为 0-65535 的整数');
        } else priority = pri;
        const t = zone ? targetFqdn(value, zone.fqdn) : parseName(value);
        if (t === undefined) err(rid, i, 'value', `MX 目标必须为以点结尾的完整域名（FQDN）：${value || '(空)'}`);
        else if (!t) err(rid, i, 'value', `MX 目标不是合法域名：${value || '(空)'}`);
        else normValue = t;
        if (!isApex) err(rid, i, 'name', 'MX 记录只能位于区域顶点');
        break;
      }
      case 'TXT': {
        if (!value) err(rid, i, 'value', 'TXT 内容不能为空');
        else if (Buffer.byteLength(value, 'utf8') > 4096) err(rid, i, 'value', 'TXT 内容超过 4096 字节');
        else if (/[\x00-\x1f\x7f]/.test(value)) err(rid, i, 'value', 'TXT 内容包含不可见控制字符');
        else normValue = value;
        break;
      }
    }

    records.push({ id: rid, index: i, type, name, ownerFqdn: ownerFqdn || name.toLowerCase(), isApex, value: normValue || value, priority, ttl: Number.isInteger(ttl) ? ttl : null });
  });

  if (zone) {
    // 顶点至少一条 NS
    const apexNS = records.filter((r) => r.isApex && r.type === 'NS' && r.value);
    if (apexNS.length === 0) err(null, -1, 'records', `区域顶点 ${zone.fqdn} 至少需要一条 NS 记录`);

    // 同名 CNAME 不得与任何其他类型共存（含多条 CNAME）
    const byOwner = new Map();
    for (const r of records) {
      if (!byOwner.has(r.ownerFqdn)) byOwner.set(r.ownerFqdn, []);
      byOwner.get(r.ownerFqdn).push(r);
    }
    for (const [owner, list] of byOwner) {
      const cnames = list.filter((r) => r.type === 'CNAME');
      if (cnames.length > 0 && list.length > 1) {
        for (const r of list) {
          err(r.id, r.index, 'type', `属主 ${owner} 上 CNAME 不得与其他记录类型共存`);
        }
      }
      if (cnames.length > 1) {
        for (const r of cnames) {
          err(r.id, r.index, 'type', `属主 ${owner} 上存在多条 CNAME（CNAME 必须唯一）`);
        }
      }
    }

    // 完全重复的记录
    const seen = new Set();
    for (const r of records) {
      if (r.ttl == null || !r.value) continue;
      const key = [r.ownerFqdn, r.type, r.type === 'MX' ? r.priority : '', r.value, r.ttl].join('|');
      if (seen.has(key)) err(r.id, r.index, 'value', '与另一条记录完全重复（名称/类型/值/优先级/TTL 均相同）');
      seen.add(key);
    }
  }

  const valid = errors.length === 0;
  let normalized = null;
  if (valid) {
    normalized = {
      zoneName: zone.fqdn.replace(/\.$/, ''), // 内部标识不带尾点
      mname: mname.fqdn,
      rname,
      records: records.map((r) => {
        const out = { name: r.isApex ? '@' : r.ownerFqdn.slice(0, -(zone.fqdn.length + 1)), type: r.type, ttl: r.ttl, value: r.value };
        if (r.type === 'MX') out.priority = r.priority;
        return out;
      })
    };
  }
  return { valid, errors, normalized };
}

module.exports = { validateContent, parseIPv4, parseIPv6, parseName };
