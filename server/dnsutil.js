'use strict';

// 去掉末尾根点并转小写，用于区域名规范化
function normalizeZoneName(name) {
  return String(name || '').trim().replace(/\.+$/, '').toLowerCase();
}

function stripTrailingDot(name) {
  return String(name || '').trim().replace(/\.+$/, '');
}

// 将记录拥有者名解析为 FQDN（不带末尾点）。
// 返回 { ok, fqdn } 或 { ok:false, reason }
function resolveName(name, zone) {
  const z = normalizeZoneName(zone);
  const n = String(name == null ? '' : name).trim();
  if (!n) return { ok: false, reason: '记录名不能为空' };
  if (n === '@') return { ok: true, fqdn: z };
  let lower = n.toLowerCase();
  const absolute = lower.endsWith('.');
  if (absolute) lower = lower.slice(0, -1);
  if (lower === z) return { ok: true, fqdn: z };
  if (lower.endsWith('.' + z)) return { ok: true, fqdn: lower };
  if (absolute) {
    return { ok: false, reason: `记录名「${n}」不属于区域 ${z}` };
  }
  // 相对名：按 BIND 规则拼接到当前区域
  return { ok: true, fqdn: `${lower}.${z}` };
}

// 将 NS/CNAME/MX 目标解析为带根点的绝对名，写入区域文件，避免相对名歧义
function absoluteTarget(target, zone) {
  const z = normalizeZoneName(zone);
  const t = String(target || '').trim();
  if (t === '@') return z + '.';
  if (t.endsWith('.')) return t.toLowerCase();
  const lower = t.toLowerCase();
  if (lower === z || lower.endsWith('.' + z)) return lower + '.';
  if (t.includes('.')) return lower + '.'; // 带点的外部名按 FQDN 处理
  return `${lower}.${z}.`;
}

// FQDN 转相对名（用于区域文件展示），顶点返回 @
function relativeName(fqdn, zone) {
  const z = normalizeZoneName(zone);
  const f = String(fqdn || '').toLowerCase().replace(/\.+$/, '');
  if (f === z) return '@';
  if (f.endsWith('.' + z)) return f.slice(0, -(z.length + 1));
  return f + '.';
}

module.exports = {
  normalizeZoneName,
  stripTrailingDot,
  resolveName,
  absoluteTarget,
  relativeName,
};
