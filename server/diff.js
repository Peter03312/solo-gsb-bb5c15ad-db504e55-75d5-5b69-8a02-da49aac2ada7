'use strict';
const { sha256 } = require('./auth');
const { normalizeZoneName, resolveName, absoluteTarget } = require('./dnsutil');

// 规范化 RDATA 用于比较：主机名类目标转绝对小写，TXT 保留原文
function normalizeRdata(type, value, zone) {
  const v = String(value == null ? '' : value).trim();
  switch (type) {
    case 'NS':
    case 'CNAME':
      return absoluteTarget(v, zone).toLowerCase();
    case 'MX': {
      const m = v.match(/^(\d+)\s+(\S+)$/);
      if (!m) return v.toLowerCase();
      return `${Number(m[1])} ${absoluteTarget(m[2], zone).toLowerCase()}`;
    }
    case 'AAAA':
      return v.toLowerCase();
    default:
      return v;
  }
}

// 规范化一条记录为可比较形式；defaultTtl 用于解析空 TTL
function canonicalRecord(rec, zone, defaultTtl) {
  const type = String(rec.type || '').toUpperCase();
  const r = resolveName(rec.name, zone);
  const ttl = rec.ttl === null || rec.ttl === undefined || rec.ttl === '' ? Number(defaultTtl) : Number(rec.ttl);
  return {
    name: r.ok ? r.fqdn : String(rec.name || '').toLowerCase(),
    type,
    ttl,
    value: normalizeRdata(type, rec.value, zone),
  };
}

function keyOf(c) {
  return [c.name, c.type, c.ttl, c.value].join('|');
}

// 修订版内容指纹：复核与发布据此判断“编辑使复核失效”
function computeContentHash(zone, settings, records) {
  const z = normalizeZoneName(zone);
  const canon = {
    zone: z,
    settings: {
      primary_ns: String(settings.primary_ns || '').trim().toLowerCase().replace(/\.+$/, ''),
      admin_email: String(settings.admin_email || '').trim().toLowerCase(),
      default_ttl: Number(settings.default_ttl),
      soa_refresh: Number(settings.soa_refresh),
      soa_retry: Number(settings.soa_retry),
      soa_expire: Number(settings.soa_expire),
      soa_minimum: Number(settings.soa_minimum),
    },
    records: (records || [])
      .map((r) => canonicalRecord(r, z, settings.default_ttl))
      .map(keyOf)
      .sort(),
  };
  return sha256(JSON.stringify(canon));
}

// 对比两组记录（旧=当前发布版，新=草稿），各自使用自己的默认 TTL
function diffRecords(oldRecords, oldDefaultTtl, newRecords, newDefaultTtl, zone) {
  const z = normalizeZoneName(zone);
  const oldMap = new Map();
  for (const r of oldRecords || []) {
    const c = canonicalRecord(r, z, oldDefaultTtl);
    oldMap.set(keyOf(c), c);
  }
  const newMap = new Map();
  for (const r of newRecords || []) {
    const c = canonicalRecord(r, z, newDefaultTtl);
    newMap.set(keyOf(c), c);
  }
  const added = [];
  const removed = [];
  for (const [k, c] of newMap) if (!oldMap.has(k)) added.push(c);
  for (const [k, c] of oldMap) if (!newMap.has(k)) removed.push(c);
  const byKey = (a, b) => (a.name === b.name ? (a.type < b.type ? -1 : 1) : a.name < b.name ? -1 : 1);
  added.sort(byKey);
  removed.sort(byKey);
  return { added, removed };
}

module.exports = { canonicalRecord, computeContentHash, diffRecords, normalizeRdata };
