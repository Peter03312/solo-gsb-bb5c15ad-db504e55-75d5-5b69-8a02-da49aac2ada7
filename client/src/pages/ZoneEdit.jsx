import React, { useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, useAuth } from '../auth.jsx';
import RecordTable from '../components/RecordTable.jsx';
import DiffView from '../components/DiffView.jsx';

const ROLE_LABEL = { admin: '管理员', editor: '编辑员', reviewer: '复核员' };

export default function ZoneEdit() {
  const { id } = useParams();
  const { user } = useAuth();
  const canEdit = user.role === 'admin' || user.role === 'editor';
  const canReview = user.role === 'admin' || user.role === 'reviewer';

  const [zone, setZone] = useState(null);
  const [content, setContent] = useState(null);   // 表单内容
  const [baseRevisionId, setBaseRevisionId] = useState(null);
  const [baseHash, setBaseHash] = useState(null);
  const [dirty, setDirty] = useState(false);

  const [diff, setDiff] = useState(null);
  const [versions, setVersions] = useState(null);
  const [reviewHistory, setReviewHistory] = useState(null);
  const [msg, setMsg] = useState(null);            // {kind,text}
  const [comment, setComment] = useState('');
  const [showZoneFile, setShowZoneFile] = useState(false);
  const [zoneFileText, setZoneFileText] = useState('');

  const applyZone = useCallback((d) => {
    setZone(d);
    setContent(d.revision ? d.revision.content : null);
    setBaseRevisionId(d.revision ? d.revision.id : null);
    setBaseHash(d.revision ? d.revision.contentHash : null);
    setDirty(false);
  }, []);

  const load = useCallback(async () => {
    const d = await api(`/api/zones/${id}`);
    applyZone(d);
    const [dv, vv, rv] = await Promise.all([
      api(`/api/zones/${id}/diff`),
      api(`/api/zones/${id}/versions`),
      api(`/api/zones/${id}/reviews`)
    ]);
    setDiff(dv); setVersions(vv.versions); setReviewHistory(rv.reviews);
  }, [id, applyZone]);

  useEffect(() => { load().catch((e) => setMsg({ kind: 'error', text: e.message })); }, [load]);

  const refreshDiff = async () => {
    try { setDiff(await api(`/api/zones/${id}/diff`)); } catch (e) { setMsg({ kind: 'error', text: e.message }); }
  };

  const updateContent = (patch) => {
    setContent((c) => ({ ...c, ...patch }));
    setDirty(true);
    setMsg(null);
  };
  const updateRecords = (records) => {
    setContent((c) => ({ ...c, records }));
    setDirty(true);
    setMsg(null);
  };

  // ---------- 操作 ----------
  const doValidate = async () => {
    try {
      const r = await api(`/api/zones/${id}/validate`, { method: 'POST', body: { content } });
      if (r.valid) setMsg({ kind: 'ok', text: '验证通过：记录结构、顶点 NS、CNAME 共存、TTL、地址与 MX 均有效。' });
      else setMsg({ kind: 'error', text: `验证发现 ${r.errors.length} 个问题（见下方红色定位）` });
      setZone((z) => ({ ...z, draftValid: r.valid, draftErrors: r.errors }));
    } catch (e) { setMsg({ kind: 'error', text: e.message }); }
  };

  const doSave = async () => {
    try {
      const d = await api(`/api/zones/${id}/draft`, {
        method: 'PUT',
        body: { content, baseRevisionId }
      });
      applyZone(d);
      setMsg({ kind: 'ok', text: d.unchanged ? '内容无变化，未生成新修订版。' : '草稿已暂存为新修订版，此前的复核已失效。' });
      await refreshDiff();
      const rv = await api(`/api/zones/${id}/reviews`);
      setReviewHistory(rv.reviews);
    } catch (e) {
      if (e.status === 409) setMsg({ kind: 'error', text: `提交冲突：${e.message}。页面不会覆盖远端版本，请重新加载后处理。` });
      else setMsg({ kind: 'error', text: e.message });
    }
  };

  const doReview = async (decision) => {
    try {
      const d = await api(`/api/zones/${id}/reviews`, {
        method: 'POST',
        body: { decision, comment, revisionId: baseRevisionId }
      });
      setComment('');
      applyZone(d);
      setMsg({ kind: 'ok', text: decision === 'approve' ? '复核通过已记录。' : '复核驳回意见已记录。' });
      const rv = await api(`/api/zones/${id}/reviews`);
      setReviewHistory(rv.reviews);
    } catch (e) {
      if (e.status === 409) {
        setMsg({ kind: 'error', text: `冲突：${e.message}` });
        await load();
      } else setMsg({ kind: 'error', text: e.message });
    }
  };

  const doPublish = async () => {
    if (!window.confirm('确认发布当前修订版？将生成新的 BIND 区域文件与递增 SOA 序列号。')) return;
    try {
      const d = await api(`/api/zones/${id}/publish`, {
        method: 'POST',
        body: { revisionId: baseRevisionId, contentHash: baseHash }
      });
      applyZone(d);
      setMsg({ kind: 'ok', text: `已发布，新序列号 ${d.published.serial}。现行文件未被验证失败的内容替换。` });
      await Promise.all([refreshDiff(), loadVersions()]);
    } catch (e) {
      if (e.status === 422) {
        setZone((z) => ({ ...z, draftValid: false, draftErrors: e.data.errors || [] }));
        setMsg({ kind: 'error', text: `发布验证未通过（${(e.data.errors || []).length} 个问题），已阻止发布，现行文件保持不变。` });
      } else if (e.status === 409) {
        setMsg({ kind: 'error', text: `发布冲突：${e.message}` });
        await load();
      } else setMsg({ kind: 'error', text: e.message });
    }
  };

  const doRollback = async (versionId, serial) => {
    if (!window.confirm(`以序列号 ${serial} 的历史版本内容创建回滚草稿？（已发布文件不会被修改；草稿仍需另一账号复核后发布）`)) return;
    try {
      const d = await api(`/api/zones/${id}/rollback`, { method: 'POST', body: { versionId } });
      applyZone(d);
      setMsg({ kind: 'warn', text: `回滚草稿已创建（来源序列号 ${serial}）。复核通过后发布将生成比 ${serial} 更大的新序列号。` });
      await Promise.all([refreshDiff(), loadVersions()]);
    } catch (e) {
      if (e.status === 409) { setMsg({ kind: 'error', text: e.message }); await load(); }
      else setMsg({ kind: 'error', text: e.message });
    }
  };

  const loadVersions = async () => {
    const vv = await api(`/api/zones/${id}/versions`);
    setVersions(vv.versions);
  };

  const previewFile = async () => {
    if (!zone.latestPublished) return;
    const res = await fetch(`/api/zones/${id}/versions/${zone.latestPublished.id}/download`);
    setZoneFileText(await res.text());
    setShowZoneFile(true);
  };

  if (!zone || !content) return <div className="container">{msg ? <div className="alert error">{msg.text}</div> : '加载中…'}</div>;

  const rev = zone.revision;
  const errors = zone.draftErrors || [];
  const globalErrors = errors.filter((e) => e.index < 0);
  const otherApprovals = (rev.validReviews || []).filter((r) => r.user_id !== rev.createdBy);
  const approvedByOther = otherApprovals.length > 0;
  const iAmCreator = rev.createdBy === user.id;
  const isRollbackDraft = !!rev.rollbackFromVersion;

  return (
    <div className="container">
      <div className="small muted" style={{ marginBottom: 10 }}><Link to="/zones">← 区域列表</Link></div>

      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 className="mt0" style={{ margin: 0 }}>{zone.name}</h2>
          <span className="pill gray">工作草稿 #{rev.revNo}</span>
          {isRollbackDraft && <span className="pill amber">回滚草稿</span>}
          {zone.draftValid
            ? <span className="pill green">草稿验证通过</span>
            : <span className="pill" style={{ background: 'rgba(255,107,107,.15)', color: 'var(--red)' }}>草稿存在验证问题</span>}
          {zone.latestPublished
            ? <span className="pill gray">现行序列号 {zone.latestPublished.serial}{zone.latestPublished.action === 'rollback' ? '（回滚发布）' : ''}</span>
            : <span className="pill gray">尚未发布</span>}
          <div className="spacer" style={{ flex: 1 }} />
          {dirty && <span className="small" style={{ color: 'var(--amber)' }}>● 有未暂存修改</span>}
        </div>
      </div>

      {msg && <div className={`alert ${msg.kind}`}>{msg.text}</div>}

      <div className="grid2">
        <div>
          {/* 区域头 */}
          <div className="panel">
            <h3>区域信息</h3>
            <label>区域名（创建后不可更改）</label>
            <input className="mono" value={content.zoneName} disabled />
            <label>主 DNS（MNAME，FQDN）</label>
            <input className="mono" value={content.mname} disabled={!canEdit}
              onChange={(e) => updateContent({ mname: e.target.value })} />
            <label>管理员邮箱（SOA RNAME）</label>
            <input className="mono" value={content.rname} disabled={!canEdit}
              onChange={(e) => updateContent({ rname: e.target.value })} />
          </div>

          {/* 记录编辑 */}
          <div className="panel">
            <h3>资源记录（NS / A / AAAA / CNAME / MX / TXT）</h3>
            {globalErrors.length > 0 && (
              <div className="alert error">
                <strong>整体性问题：</strong>
                <ul className="tight">
                  {globalErrors.map((e, i) => <li key={i}>{e.reason}</li>)}
                </ul>
              </div>
            )}
            <RecordTable records={content.records} errors={errors} onChange={updateRecords} canEdit={canEdit} />
            <div className="btn-row">
              {canEdit && <>
                <button onClick={doValidate}>整体验证</button>
                <button className="primary" onClick={doSave} disabled={!dirty}>暂存草稿</button>
              </>}
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>
              规则：记录名须属于本区域（@ 表示顶点，支持 *.host 通配）；顶点至少一条 NS；同名 CNAME 不得与任何其他类型共存；
              TTL 为正整数；A/AAAA 地址须合法；MX 仅允许顶点且优先级 0–65535、目标为 FQDN；NS/CNAME/MX 目标须以点结尾。
            </p>
          </div>

          {/* 差异 */}
          <div className="panel">
            <h3>相对现行发布版的差异</h3>
            <DiffView diff={diff} />
          </div>
        </div>

        {/* 右侧：复核与发布 */}
        <div>
          <div className="panel">
            <h3>复核与发布（四眼）</h3>
            <div className="small muted" style={{ marginBottom: 8 }}>
              修订须由<b>编辑者以外的另一个账号</b>复核通过后才能发布（编辑者不能复核自己的修订）。任何编辑都会使已作复核失效。
            </div>
            {(rev.validReviews || []).length === 0 ? (
              <div className="alert warn small">当前修订版尚无有效复核。</div>
            ) : (
              <div>
                {rev.validReviews.map((r) => (
                  <div key={r.id} className="review-item small">
                    <span className="pill green">✓ {r.display_name || r.username}</span>
                    <span className="muted" style={{ marginLeft: 8 }}>{r.created_at}</span>
                    {r.comment && <div className="muted" style={{ marginTop: 4 }}>“{r.comment}”</div>}
                  </div>
                ))}
              </div>
            )}

            {canReview ? (
              <div style={{ marginTop: 12 }}>
                <label>复核意见（可选）</label>
                <textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)}
                  disabled={iAmCreator} placeholder={iAmCreator ? '不能复核自己编辑的修订版' : ''} />
                <div className="btn-row">
                  <button className="green" onClick={() => doReview('approve')} disabled={iAmCreator}>复核通过</button>
                  <button className="danger" onClick={() => doReview('reject')} disabled={iAmCreator}>驳回</button>
                </div>
              </div>
            ) : (
              <div className="small muted" style={{ marginTop: 10 }}>当前角色（编辑员）无复核权限，请使用复核员/管理员账号登录。</div>
            )}

            <hr style={{ borderColor: 'var(--border)', margin: '14px 0' }} />

            {canEdit ? (
              <>
                <button className="green" style={{ width: '100%' }} onClick={doPublish}
                  disabled={!approvedByOther || dirty}>
                  发布当前修订版 #{rev.revNo}
                </button>
                {!approvedByOther && <div className="small muted" style={{ marginTop: 6 }}>需编辑者以外的另一账号复核通过后方可发布。</div>}
                {dirty && <div className="small muted" style={{ marginTop: 6 }}>有未暂存修改，请先暂存草稿。</div>}
              </>
            ) : <div className="small muted">当前角色（复核员）无发布权限。</div>}
          </div>

          {/* 已发布版本 */}
          <div className="panel">
            <h3>已发布版本（不可改）</h3>
            {!versions ? <div className="muted small">加载中…</div> : versions.length === 0 ? (
              <div className="muted small">尚无已发布版本。</div>
            ) : (
              <table>
                <tbody>
                  {versions.map((v) => (
                    <tr key={v.id}>
                      <td>
                        <div className="mono">{v.serial}</div>
                        <div className="small muted">{v.published_at} · {v.published_by_name}
                          {v.action === 'rollback' && ' · 回滚发布'}
                        </div>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <a href={`/api/zones/${id}/versions/${v.id}/download`}>下载 .zone</a>
                        {canEdit && <>
                          {' · '}
                          <a href="#" onClick={(e) => { e.preventDefault(); doRollback(v.id, v.serial); }}>回滚</a>
                        </>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {zone.latestPublished && (
              <div className="btn-row">
                <button onClick={previewFile}>预览现行区域文件</button>
              </div>
            )}
            {showZoneFile && <pre className="zone">{zoneFileText}</pre>}
          </div>

          {/* 复核历史 */}
          <div className="panel">
            <h3>复核 / 审计流水（最近）</h3>
            {!reviewHistory ? <div className="muted small">加载中…</div> : reviewHistory.length === 0 ? (
              <div className="muted small">暂无复核记录。</div>
            ) : (
              reviewHistory.slice(0, 15).map((r) => (
                <div key={r.id} className="review-item small">
                  <span className={`pill ${r.is_valid ? 'green' : 'gray'}`}>
                    {r.is_valid ? '✓ 通过' : '✗ 驳回/失效'}
                  </span>
                  <span style={{ marginLeft: 8 }}>{r.display_name}</span>
                  <span className="muted"> · 修订 #{r.rev_no} · {r.created_at}</span>
                  {r.comment && <div className="muted" style={{ marginTop: 4 }}>“{r.comment}”</div>}
                </div>
              ))
            )}
            {user.role === 'admin' && <div className="small" style={{ marginTop: 8 }}><Link to="/audit">查看完整审计历史 →</Link></div>}
          </div>
        </div>
      </div>
    </div>
  );
}
