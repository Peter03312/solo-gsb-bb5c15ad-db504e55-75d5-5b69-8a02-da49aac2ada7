'use strict';
const net = require('node:net');
const { normalizeZoneName, stripTrailingDot, resolveName } = require('./dnsutil');

const RECORD_TYPES = ['NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT'];
const TTL_MAX = 2147483647;

// 记录拥有者名允许通配符 * 与下划线（如 _dmarc）
const OWNER_LABEL_RE = /^[A-Za-z0-9_]([A-Za-z0-9_-]{0,61}[A-Za-z0-9_])?$/;
// 目标主机名（NS/CNAME/MX）按严格主机名规则
const HOST_LABEL_RE = /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;

function checkLabels(name, labelRe, { allowWildcard = false } = {}) {
  if (!name || name.length > 253) return false;
  const labels = name.split('.');
  for (let i = 0; i < labels.length; i++) {
    const lab = labels[i];
    if (allowWildcard && i === 0 && lab === '*') continue;
    if (!labelRe.test(lab)) return false;
  }
  return true;
}

function isValidOwnerName(fqdn) {
  return checkLabels(fqdn, OWNER_LABEL_RE, { allowWildcard: true });
}

function isValidHostname(name) {
  return checkLabels(stripTrailingDot(name), HOST_LABEL_RE);
}

function isPositiveInt(v, max = TTL_MAX) {
  if (v === null || v === undefined || v === '') return false;
  if (typeof v === 'string' && !/^\d+$/.test(v.trim())) return false;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= max;
}

const SETTINGS_FIELDS = [
  ['default_ttl', '默认 TTL'],
  ['soa_refresh', 'SOA Refresh'],
  ['soa_retry', 'SOA Retry'],
  ['soa_expire', 'SOA Expire'],
  ['soa_minimum', 'SOA Minimum'],
];

// 整体校验一个修订版。返回错误数组：
// { record: 记录id|null, index: 序号|null, name, type, field, message }
function validateZone({ zone, settings, records }) {
  const errors = [];
  const z = normalizeZoneName(zone);
  const s = settings || {};
  const list = Array.isArray(records) ? records : [];

  if (!z) {
    errors.push({ record: null, index: null, name: '', type: '', field: 'zone', message: '区域名不能为空' });
  } else if (!isValidHostname(z)) {
    errors.push({ record: null, index: null, name: '', type: '', field: 'zone', message: `区域名「${zone}」不是合法的 DNS 名称` });
  }

  if (!isValidHostname(s.primary_ns || '')) {
    errors.push({ record: null, index: null, name: '', type: '', field: 'primary_ns', message: `主 DNS 服务器「${s.primary_ns || ''}」不是合法主机名` });
  }
  if (!/^[^\s@]+@[^\s@]+$/.test(String(s.admin_email || '').trim())) {
    errors.push({ record: null, index: null, name: '', type: '', field: 'admin_email', message: `管理员邮箱「${s.admin_email || ''}」格式不正确` });
  }
  for (const [key, label] of SETTINGS_FIELDS) {
    if (!isPositiveInt(s[key])) {
      errors.push({ record: null, index: null, name: '', type: '', field: key, message: `${label} 必须是正整数` });
    }
  }

  const byName = new Map();
  const seen = new Set();
  let apexNs = 0;

  list.forEach((rec, i) => {
    const tag = {
      record: rec.id != null ? rec.id : null,
      index: i + 1,
      name: String(rec.name ?? ''),
      type: String(rec.type ?? '').toUpperCase(),
    };
    const type = tag.type;
    if (!RECORD_TYPES.includes(type)) {
      errors.push({ ...tag, field: 'type', message: `不支持的记录类型「${rec.type}」，仅支持 ${RECORD_TYPES.join('/')}` });
      return;
    }

    const r = z ? resolveName(rec.name, z) : { ok: false, reason: '区域名无效，无法判定记录归属' };
    if (!r.ok) {
      errors.push({ ...tag, field: 'name', message: r.reason });
      return;
    }
    if (!isValidOwnerName(r.fqdn)) {
      errors.push({ ...tag, field: 'name', message: `记录名「${rec.name}」包含非法字符或标签超长` });
      return;
    }

    let ttl = rec.ttl;
    if (ttl === '' || ttl === undefined) ttl = null;
    if (ttl !== null && !isPositiveInt(ttl)) {
      errors.push({ ...tag, field: 'ttl', message: `TTL「${rec.ttl}」必须是 1-${TTL_MAX} 的正整数` });
    }

    const value = String(rec.value ?? '').trim();
    if (!value) {
      errors.push({ ...tag, field: 'value', message: '记录值不能为空' });
    } else {
      switch (type) {
        case 'A':
          if (!net.isIPv4(value)) {
            errors.push({ ...tag, field: 'value', message: `「${value}」不是合法的 IPv4 地址` });
          }
          break;
        case 'AAAA':
          if (!net.isIPv6(value)) {
            errors.push({ ...tag, field: 'value', message: `「${value}」不是合法的 IPv6 地址` });
          }
          break;
        case 'NS':
        case 'CNAME':
          if (!isValidHostname(value)) {
            errors.push({ ...tag, field: 'value', message: `目标「${value}」不是合法的主机名` });
          }
          break;
        case 'MX': {
          const m = value.match(/^(\d+)\s+(\S+)$/);
          if (!m) {
            errors.push({ ...tag, field: 'value', message: 'MX 记录格式应为「优先级 目标主机」，例如：10 mail.example.com' });
          } else {
            const pref = Number(m[1]);
            if (!Number.isInteger(pref) || pref < 0 || pref > 65535) {
              errors.push({ ...tag, field: 'value', message: `MX 优先级「${m[1]}」必须是 0-65535 的整数` });
            }
            if (!isValidHostname(m[2])) {
              errors.push({ ...tag, field: 'value', message: `MX 目标「${m[2]}」不是合法的主机名` });
            }
          }
          break;
        }
        case 'TXT':
          if (value.length > 65535) {
            errors.push({ ...tag, field: 'value', message: 'TXT 记录内容过长（超过 65535 字符）' });
          }
          break;
      }
    }

    if (!byName.has(r.fqdn)) byName.set(r.fqdn, []);
    byName.get(r.fqdn).push({ rec, type, index: i + 1 });
    if (r.fqdn === z && type === 'NS') apexNs++;

    const normValue = type === 'TXT' ? value : value.toLowerCase();
    const dupKey = `${r.fqdn}|${type}|${ttl == null ? '' : Number(ttl)}|${normValue}`;
    if (seen.has(dupKey)) {
      errors.push({ ...tag, field: 'value', message: '与前面的记录完全重复' });
    }
    seen.add(dupKey);
  });

  if (z && apexNs === 0) {
    errors.push({ record: null, index: null, name: '@', type: 'NS', field: 'records', message: `区域顶点（@，即 ${z}）至少需要一条 NS 记录` });
  }

  for (const [fqdn, group] of byName) {
    const hasCname = group.some((g) => g.type === 'CNAME');
    if (hasCname && group.length > 1) {
      for (const g of group) {
        errors.push({
          record: g.rec.id != null ? g.rec.id : null,
          index: g.index,
          name: String(g.rec.name ?? ''),
          type: g.type,
          field: 'type',
          message: `同名记录「${fqdn}」的 CNAME 不能与其他类型记录共存`,
        });
      }
    }
  }

  return errors;
}

module.exports = { validateZone, RECORD_TYPES, isPositiveInt, isValidHostname, TTL_MAX };
