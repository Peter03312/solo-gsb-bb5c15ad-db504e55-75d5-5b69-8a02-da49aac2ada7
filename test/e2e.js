'use strict';
// 端到端流程测试（对运行中的服务器执行真实 HTTP 请求）
const BASE = process.env.BASE || 'http://localhost:8099';
let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra != null ? JSON.stringify(extra) : ''); }
}

async function req(method, path, { token, body, raw = false } = {}) {
  const headers = {};
  if (token) headers.Cookie = `dzc.sid=${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie') || '';
  const m = setCookie.match(/dzc\.sid=([^;]+)/);
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, newToken: m ? m[1] : null, text };
}

async function login(u, p) {
  const r = await req('POST', '/api/auth/login', { body: { username: u, password: p } });
  if (r.status !== 200) throw new Error(`login ${u} failed: ${r.status}`);
  return r.newToken;
}

const baseRecords = () => ([
  { id: 'r1', name: '@', type: 'NS', ttl: 3600, value: 'ns1.example.org.' },
  { id: 'r2', name: '@', type: 'A', ttl: 3600, value: '192.0.2.10' },
  { id: 'r3', name: 'www', type: 'AAAA', ttl: 3600, value: '2001:db8::1' },
  { id: 'r4', name: '@', type: 'MX', ttl: 3600, priority: '10', value: 'mail.example.org.' },
  { id: 'r5', name: 'mail', type: 'A', ttl: 3600, value: '192.0.2.20' },
  { id: 'r6', name: '@', type: 'TXT', ttl: 3600, value: 'v=spf1 -all' }
]);
const header = { zoneName: 'example.org', mname: 'ns1.example.org.', rname: 'hostmaster@example.org' };

(async () => {
  const editor = await login('editor', 'editor123');
  const reviewer = await login('reviewer', 'reviewer123');
  const admin = await login('admin', 'admin123');
  console.log('登录：editor / reviewer / admin 三个账号');

  // 错误密码
  const bad = await req('POST', '/api/auth/login', { body: { username: 'editor', password: 'wrong' } });
  ok(bad.status === 401, '错误密码被拒');

  // 未登录访问
  const anon = await req('GET', '/api/zones');
  ok(anon.status === 401, '未登录不可访问 API');

  // 复核员不能建区
  const denied = await req('POST', '/api/zones', { token: reviewer, body: { name: 'x.org', ...header, zoneName: 'x.org', records: baseRecords() } });
  ok(denied.status === 403, '复核员无权建区');

  // 创建时验证失败：无顶点 NS、区外记录、CNAME 共存、坏 IP、坏 TTL、坏 MX
  const badContent = {
    name: 'example.org',
    ...header,
    records: [
      { id: 'b1', name: '@', type: 'A', ttl: 3600, value: '192.0.2.1' },        // 无 NS
      { id: 'b2', name: 'host.other.com.', type: 'A', ttl: -3, value: '300.1.1.1' }, // 区外/TTL/IP
      { id: 'b3', name: 'www', type: 'CNAME', ttl: 3600, value: 'x.example.org.' },
      { id: 'b4', name: 'www', type: 'A', ttl: 3600, value: '10.0.0.1' },       // CNAME 共存
      { id: 'b5', name: '@', type: 'MX', ttl: 3600, priority: '99999', value: 'mail.example.org' },
      { id: 'b6', name: 'bad', type: 'AAAA', ttl: 3600, value: '2001:db8:::1' }
    ]
  };
  const cBad = await req('POST', '/api/zones', { token: editor, body: badContent });
  ok(cBad.status === 422, '创建非法区域返回 422', cBad.data);
  const errs = cBad.data.errors || [];
  const has = (field, reasonPart, index) => errs.some((e) => e.field === field && (index === undefined || e.index === index) && e.reason.includes(reasonPart));
  ok(has('records', '至少需要一条 NS'), '定位：顶点缺少 NS');
  ok(has('name', '不属于区域', 1), '定位：区外记录名');
  ok(has('ttl', '正整数', 1), '定位：TTL 非正整数');
  ok(has('value', '地址无效', 1), '定位：非法 IPv4');
  ok(has('type', 'CNAME 不得与其他记录类型共存', 2), '定位：CNAME 共存');
  ok(has('priority', '优先级', 4), '定位：MX 优先级越界');
  ok(has('value', 'FQDN', 4), '定位：MX 目标非 FQDN');
  ok(has('value', '地址无效', 5), '定位：非法 IPv6');
  ok(errs.every((e) => e.index >= 0 ? e.recordId : true), '错误均带记录标识');

  // 合法创建
  const cOk = await req('POST', '/api/zones', { token: editor, body: { name: 'example.org', ...header, records: baseRecords() } });
  ok(cOk.status === 201, '合法区域创建成功', cOk.data && cOk.data.error);
  const zid = cOk.data.id;
  const rev1 = cOk.data.revision.id;

  // 草稿整体验证（接口）
  const v = await req('POST', `/api/zones/${zid}/validate`, { token: editor, body: { content: { ...header, records: baseRecords() } } });
  ok(v.status === 200 && v.data.valid === true, '在线验证合法内容通过');

  // 未复核直接发布 → 403
  const p0 = await req('POST', `/api/zones/${zid}/publish`, { token: editor, body: { revisionId: rev1 } });
  ok(p0.status === 403, '未复核发布被拒（四眼）');

  // 编辑者复核自己的修订 → 403
  const selfRev = await req('POST', `/api/zones/${zid}/reviews`, { token: editor, body: { decision: 'approve', revisionId: rev1 } });
  ok(selfRev.status === 403, '编辑者不能复核自己的修订');

  // 复核员通过
  const ap = await req('POST', `/api/zones/${zid}/reviews`, { token: reviewer, body: { decision: 'approve', revisionId: rev1, comment: 'LGTM' } });
  ok(ap.status === 200, '另一账号复核通过');
  ok((ap.data.revision.validReviews || []).some((r) => r.comment === 'LGTM'), '复核意见已记录');

  // 差异：无发布时 fromExists=false
  const d0 = await req('GET', `/api/zones/${zid}/diff`, { token: editor });
  ok(d0.status === 200 && d0.data.fromExists === false, '首次发布前差异基线为空');

  // 发布成功
  const p1 = await req('POST', `/api/zones/${zid}/publish`, { token: editor, body: { revisionId: rev1, contentHash: cOk.data.revision.contentHash } });
  ok(p1.status === 200, '首次发布成功', p1.data && p1.data.error);
  const serial1 = p1.data.published.serial;
  ok(/^20\d{8}$/.test(String(serial1)), `SOA 序列号形如 YYYYMMDDnn：${serial1}`);
  const curRevAfterPub1 = p1.data.revision.id;
  ok(curRevAfterPub1 !== rev1, '发布后开出新草稿修订版');

  // 下载区域文件，校验语法要素
  const dl1 = await req('GET', `/api/zones/${zid}/versions/${p1.data.published.versionId}/download`, { token: editor });
  ok(dl1.status === 200 && typeof dl1.data === 'string', '下载区域文件成功');
  const zf = dl1.data;
  for (const needle of ['$ORIGIN example.org.', '$TTL', 'IN SOA ns1.example.org. hostmaster.example.org.', ` ${serial1} `, 'NS ns1.example.org.', 'MX 10 mail.example.org.', 'AAAA 2001:db8:0:0:0:0:0:1', 'TXT "v=spf1 -all"']) {
    ok(zf.includes(needle), `区域文件包含：${needle.trim()}`);
  }

  // 编辑后暂存 → 新修订；旧复核失效
  const editedContent = { ...header, records: [...baseRecords(), { id: 'r7', name: 'api', type: 'A', ttl: 600, value: '192.0.2.30' }] };
  const s2 = await req('PUT', `/api/zones/${zid}/draft`, { token: editor, body: { content: editedContent, baseRevisionId: curRevAfterPub1 } });
  ok(s2.status === 200 && s2.data.saved === true, '暂存草稿生成新修订版');
  const rev2 = s2.data.revision.id;
  ok((s2.data.revision.validReviews || []).length === 0, '编辑后旧复核失效');

  // 用旧修订号发布 → 409，不覆盖
  const stale = await req('POST', `/api/zones/${zid}/publish`, { token: editor, body: { revisionId: curRevAfterPub1 } });
  ok(stale.status === 409, '过期修订发布报冲突 409');
  ok(stale.data.currentRevisionId === rev2, '冲突响应给出当前修订号');

  // 未重新复核发布 rev2 → 403
  const p2deny = await req('POST', `/api/zones/${zid}/publish`, { token: editor, body: { revisionId: rev2 } });
  ok(p2deny.status === 403, '新修订未复核不可发布');

  // 草稿暂存乐观锁：旧 baseRevisionId 再存 → 409
  const s2conflict = await req('PUT', `/api/zones/${zid}/draft`, { token: editor, body: { content: editedContent, baseRevisionId: curRevAfterPub1 } });
  ok(s2conflict.status === 409, '过期 baseRevisionId 暂存报冲突');

  // 复核旧修订版（已过期）→ 409
  const oldRevReview = await req('POST', `/api/zones/${zid}/reviews`, { token: reviewer, body: { decision: 'approve', revisionId: curRevAfterPub1 } });
  ok(oldRevReview.status === 409, '复核过期修订报冲突');

  // 复核新修订 + 发布
  await req('POST', `/api/zones/${zid}/reviews`, { token: reviewer, body: { decision: 'approve', revisionId: rev2 } });
  const p2 = await req('POST', `/api/zones/${zid}/publish`, { token: editor, body: { revisionId: rev2, contentHash: s2.data.revision.contentHash } });
  ok(p2.status === 200, '复核后第二次发布成功', p2.data && p2.data.error);
  const serial2 = p2.data.published.serial;
  ok(serial2 > serial1, `序列号严格递增：${serial1} → ${serial2}`);

  // 发布后现行文件可下载且差异为无
  const d2 = await req('GET', `/api/zones/${zid}/diff`, { token: editor });
  ok(d2.data.hasChanges === false, '发布后草稿与现行版无差异');

  // 重复内容发布 → 409（此时草稿=刚发布内容）
  const curRev3 = p2.data.revision.id;
  await req('POST', `/api/zones/${zid}/reviews`, { token: reviewer, body: { decision: 'approve', revisionId: curRev3 } });
  const pSame = await req('POST', `/api/zones/${zid}/publish`, { token: editor, body: { revisionId: curRev3 } });
  ok(pSame.status === 409, '内容相同时拒绝重复发布');

  // 回滚到 serial1：创建回滚草稿
  const versions = (await req('GET', `/api/zones/${zid}/versions`, { token: editor })).data.versions;
  const v1 = versions.find((x) => x.serial === serial1);
  ok(versions.length === 2 && !!v1, '历史版本列表含两次发布');
  const rb = await req('POST', `/api/zones/${zid}/rollback`, { token: editor, body: { versionId: v1.id } });
  ok(rb.status === 200, '回滚草稿创建成功');
  ok(!!rb.data.revision.rollbackFromVersion, '修订标记为回滚来源');
  const revRb = rb.data.revision.id;

  // 回滚草稿未复核发布 → 403
  const rbDeny = await req('POST', `/api/zones/${zid}/publish`, { token: editor, body: { revisionId: revRb } });
  ok(rbDeny.status === 403, '回滚草稿仍需复核');

  // 差异应显示 api 记录被移除
  const dRb = await req('GET', `/api/zones/${zid}/diff`, { token: editor });
  ok(dRb.data.removed.some((r) => r.name === 'api' && r.type === 'A'), '差异显示回滚将移除 api 记录');

  await req('POST', `/api/zones/${zid}/reviews`, { token: reviewer, body: { decision: 'approve', revisionId: revRb } });
  const p3 = await req('POST', `/api/zones/${zid}/publish`, { token: editor, body: { revisionId: revRb, contentHash: rb.data.revision.contentHash } });
  ok(p3.status === 200, '回滚发布成功', p3.data && p3.data.error);
  const serial3 = p3.data.published.serial;
  ok(serial3 > serial2, `回滚序列号也递增：${serial2} → ${serial3}`);

  // 新文件内容应等同 serial1 内容（记录层面），但文件文本 serial 不同；旧文件不可变
  const dl3 = await req('GET', `/api/zones/${zid}/versions/${p3.data.published.versionId}/download`, { token: editor });
  ok(dl3.data.includes(` ${serial3} `) && !dl3.data.includes(` ${serial1} `), '新回滚文件携带新序列号');
  const dl1again = await req('GET', `/api/zones/${zid}/versions/${v1.id}/download`, { token: editor });
  ok(dl1again.data === zf, '旧版本文件文本保持不变（不可改）');
  ok(dl1again.data.includes('192.0.2.30') === false, '回滚后旧版本仍是旧内容、新版本不含 api 记录' );
  ok(dl3.data.includes('192.0.2.30') === false, '回滚发布的文件内容为旧记录集');

  // 发布验证失败不替换现行文件：把草稿改坏（删 NS），复核后发布
  const badDraft = { ...header, records: baseRecords().filter((r) => r.type !== 'NS') };
  const sBad = await req('PUT', `/api/zones/${zid}/draft`, { token: editor, body: { content: badDraft, baseRevisionId: p3.data.revision.id } });
  await req('POST', `/api/zones/${zid}/reviews`, { token: reviewer, body: { decision: 'approve', revisionId: sBad.data.revision.id } });
  const pBad = await req('POST', `/api/zones/${zid}/publish`, { token: editor, body: { revisionId: sBad.data.revision.id } });
  ok(pBad.status === 422, '非法内容发布返回 422');
  ok((pBad.data.errors || []).some((e) => e.reason.includes('至少需要一条 NS')), '失败原因可定位');
  const curLatest = (await req('GET', `/api/zones/${zid}`, { token: editor })).data.latestPublished;
  ok(curLatest.serial === serial3, '验证失败后现行文件/序列号不变');

  // 审计日志
  const audit = await req('GET', '/api/audit', { token: admin });
  ok(audit.status === 200, '管理员可查看审计');
  const acts = (audit.data.entries || []).map((e) => e.action);
  for (const a of ['login_failed', 'zone_create', 'draft_save', 'review_approve', 'publish', 'rollback_draft', 'rollback_publish', 'download']) {
    ok(acts.includes(a), `审计包含动作：${a}`);
  }
  const reviewerAudit = await req('GET', '/api/audit', { token: reviewer });
  ok(reviewerAudit.status === 403, '复核员不能看审计');

  // 登出
  const lo = await req('POST', '/api/auth/logout', { token: editor });
  ok(lo.status === 200, '登出成功');

  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(2); });
