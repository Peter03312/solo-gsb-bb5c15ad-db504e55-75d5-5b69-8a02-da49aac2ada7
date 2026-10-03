import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { StatusBadge } from './ZoneList.jsx';

const RECORD_TYPES = ['NS', 'A', 'AAAA', 'CNAME', 'MX', 'TXT'];
const VALUE_PLACEHOLDER = {
  NS: 'ns1.example.com',
  A: '192.0.2.10',
  AAAA: '2001:db8::10',
  CNAME: 'target.example.com',
  MX: '10 mail.example.com',
  TXT: 'v=spf1 mx -all',
};

let rowKey = 1;
const newRow = () => ({ _key: rowKey++, name: '', type: 'A', ttl: '', value: '' });

function toRows(records) {
  return records.map((r) => ({
    _key: rowKey++,
    name: r.name,
    type: r.type,
    ttl: r.ttl === null || r.ttl === undefined ? '' : String(r.ttl),
    value: r.value,
  }));
}

function ValidationErrors({ errors }) {
  if (!errors || errors.length === 0) return null;
  return (
    <div className="alert alert-error">
      <strong>验证失败（{errors.length} 项），请修正后再提交：</strong>
      <ul>
        {errors.map((e, i) => (
          <li key={i}>
            {e.index ? `记录 #${e.index}（${e.name || '?'} ${e.type || '?'}）` : '区域设置'}
            {e.field ? ` · ${e.field}` : ''}：{e.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ZoneDetail() {
  const { id } = useParams();
  const { user } = useAuth();
  const [zoneInfo, setZoneInfo] = useState(null);
  const [revData, setRevData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [rows, setRows] = useState([]);
  const [tab, setTab] = useState('edit');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);
  const [comment, setComment] = useState('');

  const loadZone = useCallback(async () => {
    const info = await api.get(`/api/zones/${id}`);
    setZoneInfo(info);
    return info;
  }, [id]);

  const loadRevision = useCallback(async (revId) => {
    const data = await api.get(`/api/revisions/${revId}`);
    setRevData(data);
    setSettings({ ...data.settings });
    setRows(toRows(data.revision.records));
    setErrors(data.validation_errors || []);
    return data;
  }, []);

  const reload = useCallback(async () => {
    setError('');
    try {
      const info = await loadZone();
      if (info.open_revision) {
        await loadRevision(info.open_revision.id);
      } else {
        setRevData(null);
        setRows([]);
      }
    } catch (e) {
      setError(e.message);
    }
  }, [loadZone, loadRevision]);

  useEffect(() => {
    reload();
  }, [reload]);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError(e.message);
      if (e.data && e.data.validation_errors) setErrors(e.data.validation_errors);
    } finally {
      setBusy(false);
    }
  };

  const createDraft = (fresh) =>
    run(async () => {
      const r = await api.post(`/api/zones/${id}/draft`, { fresh });
      await loadZone();
      await loadRevision(r.revision_id);
      setNotice(fresh ? '已基于当前发布版创建新草稿' : '已打开草稿');
    });

  const payload = () => ({
    version: revData.revision.version,
    settings: {
      ...settings,
      default_ttl: Number(settings.default_ttl),
      soa_refresh: Number(settings.soa_refresh),
      soa_retry: Number(settings.soa_retry),
      soa_expire: Number(settings.soa_expire),
      soa_minimum: Number(settings.soa_minimum),
    },
    records: rows.map((r, i) => ({
      name: r.name,
      type: r.type,
      ttl: r.ttl === '' ? null : Number(r.ttl),
      value: r.value,
      sort_order: i,
    })),
  });

  const save = () =>
    run(async () => {
      await api.put(`/api/revisions/${revData.revision.id}`, payload());
      await loadRevision(revData.revision.id);
      setNotice('草稿已保存');
    });

  const validateNow = () =>
    run(async () => {
      const zone = zoneInfo.zone;
      const p = payload();
      const res = await api.post('/api/validate', { zone: zone.name, settings: p.settings, records: p.records });
      setErrors(res.errors);
      setNotice(res.errors.length === 0 ? '校验通过' : `发现 ${res.errors.length} 个问题`);
    });

  const submit = () =>
    run(async () => {
      await api.put(`/api/revisions/${revData.revision.id}`, payload());
      await api.post(`/api/revisions/${revData.revision.id}/submit`);
      await reload();
      setNotice('已提交复核，请另一账号复核');
    });

  const review = (decision) =>
    run(async () => {
      await api.post(`/api/revisions/${revData.revision.id}/review`, { decision, comment });
      setComment('');
      await reload();
      setNotice(decision === 'approve' ? '已复核通过' : '已驳回');
    });

  const publish = () =>
    run(async () => {
      const res = await api.post(`/api/revisions/${revData.revision.id}/publish`);
      await reload();
      setNotice(`发布成功，新序列号 ${res.serial}`);
      setTab('files');
    });

  const abandon = () =>
    run(async () => {
      if (!window.confirm('确定作废该修订版？')) return;
      await api.post(`/api/revisions/${revData.revision.id}/abandon`);
      await reload();
      setNotice('修订版已作废');
    });

  if (!zoneInfo) {
    return <p className="muted">加载中…</p>;
  }

  const rev = revData && revData.revision;
  const open = rev && ['draft', 'in_review', 'approved', 'rejected'].includes(rev.status);
  const isAuthor = rev && rev.created_by === user.id;
  const canReview = rev && rev.status === 'in_review' && !isAuthor;
  const canPublish = rev && rev.status === 'approved' && revData.approval && !revData.stale;

  return (
    <div>
      <div className="page-head">
        <h2>区域 {zoneInfo.zone.name}</h2>
        <div className="muted">
          当前发布序列号：<strong>{zoneInfo.current_serial || '（未发布）'}</strong>
          {rev && (
            <>
              {'　'}修订 #{rev.rev_no} <StatusBadge status={rev.status} /> 基于序列号 {rev.base_serial}
            </>
          )}
        </div>
      </div>

      {notice && <div className="alert alert-ok">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}

      <div className="tabs">
        {[['edit', '编辑修订'], ['diff', '差异对比'], ['files', '发布历史'], ['audit', '审计日志']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'tab active' : 'tab'} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'edit' && (
        <div>
          {!rev && (
            <div className="card">
              <p>当前没有打开的修订版。</p>
              <button className="btn btn-primary" disabled={busy} onClick={() => createDraft(false)}>
                新建草稿（基于当前发布版）
              </button>
            </div>
          )}

          {rev && revData.stale && open && (
            <div className="alert alert-warn">
              该修订基于序列号 {rev.base_serial}，而当前发布版为 {revData.current_serial}，已过期，不能提交或发布。
              <button className="btn btn-sm" disabled={busy} onClick={() => createDraft(true)}>
                作废旧草稿并基于当前发布版新建
              </button>
            </div>
          )}

          {rev && (
            <>
              <div className="card">
                <h3>区域设置（SOA / 默认值）</h3>
                <div className="form-grid">
                  <label>
                    主 DNS 服务器
                    <input value={settings.primary_ns} onChange={(e) => setSettings({ ...settings, primary_ns: e.target.value })} disabled={!open} />
                  </label>
                  <label>
                    管理员邮箱
                    <input value={settings.admin_email} onChange={(e) => setSettings({ ...settings, admin_email: e.target.value })} disabled={!open} />
                  </label>
                  <label>
                    默认 TTL
                    <input type="number" min="1" value={settings.default_ttl} onChange={(e) => setSettings({ ...settings, default_ttl: e.target.value })} disabled={!open} />
                  </label>
                  <label>
                    SOA Refresh
                    <input type="number" min="1" value={settings.soa_refresh} onChange={(e) => setSettings({ ...settings, soa_refresh: e.target.value })} disabled={!open} />
                  </label>
                  <label>
                    SOA Retry
                    <input type="number" min="1" value={settings.soa_retry} onChange={(e) => setSettings({ ...settings, soa_retry: e.target.value })} disabled={!open} />
                  </label>
                  <label>
                    SOA Expire
                    <input type="number" min="1" value={settings.soa_expire} onChange={(e) => setSettings({ ...settings, soa_expire: e.target.value })} disabled={!open} />
                  </label>
                  <label>
                    SOA Minimum
                    <input type="number" min="1" value={settings.soa_minimum} onChange={(e) => setSettings({ ...settings, soa_minimum: e.target.value })} disabled={!open} />
                  </label>
                </div>
              </div>

              <div className="card">
                <h3>资源记录（{rows.length} 条）</h3>
                <table className="records">
                  <thead>
                    <tr>
                      <th style={{ width: '3em' }}>#</th>
                      <th style={{ width: '22%' }}>记录名（@ 或相对名）</th>
                      <th style={{ width: '8em' }}>类型</th>
                      <th style={{ width: '8em' }}>TTL（空=默认）</th>
                      <th>记录值</th>
                      <th style={{ width: '4em' }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r._key}>
                        <td className="muted">{i + 1}</td>
                        <td>
                          <input value={r.name} disabled={!open} placeholder="@ 或 www"
                            onChange={(e) => setRows(rows.map((x) => (x._key === r._key ? { ...x, name: e.target.value } : x)))} />
                        </td>
                        <td>
                          <select value={r.type} disabled={!open}
                            onChange={(e) => setRows(rows.map((x) => (x._key === r._key ? { ...x, type: e.target.value } : x)))}>
                            {RECORD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td>
                          <input value={r.ttl} disabled={!open} placeholder={String(settings.default_ttl)} inputMode="numeric"
                            onChange={(e) => setRows(rows.map((x) => (x._key === r._key ? { ...x, ttl: e.target.value } : x)))} />
                        </td>
                        <td>
                          <input value={r.value} disabled={!open} placeholder={VALUE_PLACEHOLDER[r.type]}
                            onChange={(e) => setRows(rows.map((x) => (x._key === r._key ? { ...x, value: e.target.value } : x)))} />
                        </td>
                        <td>
                          {open && (
                            <button className="btn btn-sm btn-danger" onClick={() => setRows(rows.filter((x) => x._key !== r._key))}>
                              删除
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {open && (
                  <button className="btn btn-sm" onClick={() => setRows([...rows, newRow()])}>
                    + 添加记录
                  </button>
                )}
              </div>

              <ValidationErrors errors={errors} />

              <div className="card">
                <h3>操作</h3>
                <div className="actions">
                  {open && (
                    <>
                      <button className="btn" disabled={busy} onClick={save}>暂存草稿</button>
                      <button className="btn" disabled={busy} onClick={validateNow}>立即校验</button>
                      {(rev.status === 'draft' || rev.status === 'rejected') && !revData.stale && (
                        <button className="btn btn-primary" disabled={busy} onClick={submit}>保存并提交复核</button>
                      )}
                      <button className="btn btn-danger" disabled={busy} onClick={abandon}>作废</button>
                    </>
                  )}
                  {canPublish && (
                    <button className="btn btn-primary" disabled={busy} onClick={publish}>
                      发布（生成序列号 {revData.current_serial + 1}）
                    </button>
                  )}
                </div>

                {rev.status === 'in_review' && isAuthor && (
                  <p className="muted">已提交复核，等待其他账号复核。复核前再次编辑会使已有复核失效。</p>
                )}
                {rev.status === 'approved' && !revData.approval && (
                  <p className="muted">内容在复核后已被修改，复核已失效，请重新提交复核。</p>
                )}

                {canReview && (
                  <div className="review-box">
                    <h4>复核（您不是提交人，可以复核）</h4>
                    <textarea rows="2" placeholder="复核意见（可选）" value={comment} onChange={(e) => setComment(e.target.value)} />
                    <div className="actions">
                      <button className="btn btn-primary" disabled={busy} onClick={() => review('approve')}>复核通过</button>
                      <button className="btn btn-danger" disabled={busy} onClick={() => review('reject')}>驳回</button>
                    </div>
                  </div>
                )}

                {rev.reviews.length > 0 && (
                  <div>
                    <h4>复核记录</h4>
                    <table>
                      <thead>
                        <tr><th>复核人</th><th>结论</th><th>意见</th><th>时间</th><th>状态</th></tr>
                      </thead>
                      <tbody>
                        {rev.reviews.map((rv) => (
                          <tr key={rv.id}>
                            <td>{rv.reviewer}</td>
                            <td>{rv.decision === 'approve' ? '通过' : '驳回'}</td>
                            <td>{rv.comment || '—'}</td>
                            <td className="muted small">{rv.created_at}</td>
                            <td>
                              {rv.content_hash === rev.content_hash
                                ? <span className="badge badge-approved">有效</span>
                                : <span className="badge badge-superseded">已失效（内容已修改）</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <p className="muted small">
                  提交人：{rev.author_name}　版本号：v{rev.version}　内容指纹：{rev.content_hash.slice(0, 12)}…　更新时间：{rev.updated_at}
                </p>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'diff' && <DiffTab revId={rev && rev.id} />}
      {tab === 'files' && <FilesTab zoneId={id} onChanged={reload} />}
      {tab === 'audit' && <AuditTab zoneId={id} />}
    </div>
  );
}

function DiffTab({ revId }) {
  const [diff, setDiff] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setDiff(null);
    setError('');
    if (!revId) return;
    api.get(`/api/revisions/${revId}/diff`).then(setDiff).catch((e) => setError(e.message));
  }, [revId]);

  if (!revId) return <div className="card"><p className="muted">没有打开的修订版，无法对比。请先在「编辑修订」中创建草稿。</p></div>;
  if (error) return <div className="alert alert-error">{error}</div>;
  if (!diff) return <p className="muted">加载中…</p>;

  const settingsChanged = diff.old_settings && JSON.stringify(diff.old_settings) !== JSON.stringify(diff.new_settings);

  return (
    <div>
      <div className="card">
        <h3>与当前发布版（序列号 {diff.current_serial || '无'}）的差异</h3>
        <p className="muted small">差异基于已保存的草稿内容；未暂存的修改请先「暂存草稿」。</p>
        {diff.base_serial !== diff.current_serial && (
          <div className="alert alert-warn">草稿基于序列号 {diff.base_serial}，当前发布版已为 {diff.current_serial}，修订已过期。</div>
        )}
        {settingsChanged && (
          <div className="alert alert-warn">
            区域设置有变化：
            {['primary_ns', 'admin_email', 'default_ttl', 'soa_refresh', 'soa_retry', 'soa_expire', 'soa_minimum']
              .filter((k) => String(diff.old_settings[k]) !== String(diff.new_settings[k]))
              .map((k) => (
                <div key={k} className="small">
                  {k}: <del>{String(diff.old_settings[k])}</del> → <ins>{String(diff.new_settings[k])}</ins>
                </div>
              ))}
          </div>
        )}
        {diff.added.length === 0 && diff.removed.length === 0 && !settingsChanged && <p className="muted">无差异。</p>}
      </div>

      {diff.added.length > 0 && (
        <div className="card">
          <h3 className="diff-add-title">新增记录（{diff.added.length}）</h3>
          <DiffTable records={diff.added} cls="diff-add" sign="+" />
        </div>
      )}
      {diff.removed.length > 0 && (
        <div className="card">
          <h3 className="diff-del-title">删除记录（{diff.removed.length}）</h3>
          <DiffTable records={diff.removed} cls="diff-del" sign="-" />
        </div>
      )}
    </div>
  );
}

function DiffTable({ records, cls, sign }) {
  return (
    <table>
      <thead>
        <tr><th></th><th>记录名</th><th>类型</th><th>TTL</th><th>记录值</th></tr>
      </thead>
      <tbody>
        {records.map((r, i) => (
          <tr key={i} className={cls}>
            <td>{sign}</td>
            <td>{r.name}</td>
            <td>{r.type}</td>
            <td>{r.ttl}</td>
            <td><code>{r.value}</code></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FilesTab({ zoneId, onChanged }) {
  const [files, setFiles] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [openId, setOpenId] = useState(null);
  const [content, setContent] = useState('');

  const load = useCallback(() => {
    api.get(`/api/zones/${zoneId}/files`).then(setFiles).catch((e) => setError(e.message));
  }, [zoneId]);
  useEffect(load, [load]);

  const toggle = async (fid) => {
    if (openId === fid) {
      setOpenId(null);
      setContent('');
      return;
    }
    const f = await api.get(`/api/files/${fid}`);
    setOpenId(fid);
    setContent(f.content);
  };

  const rollback = async (f) => {
    if (!window.confirm(`确定回滚到序列号 ${f.serial} 的内容？将生成序列号更大的新发布文件。`)) return;
    setError('');
    setNotice('');
    try {
      const res = await api.post(`/api/files/${f.id}/rollback`);
      setNotice(`回滚完成，新序列号 ${res.serial}`);
      load();
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="card">
      <h3>发布历史（已发布文件不可修改）</h3>
      {notice && <div className="alert alert-ok">{notice}</div>}
      {error && <div className="alert alert-error">{error}</div>}
      {!files ? (
        <p className="muted">加载中…</p>
      ) : files.length === 0 ? (
        <p className="muted">尚未发布过任何版本。</p>
      ) : (
        <table>
          <thead>
            <tr><th>序列号</th><th>发布时间</th><th>发布人</th><th>SHA-256</th><th>备注</th><th>操作</th></tr>
          </thead>
          <tbody>
            {files.map((f, idx) => (
              <React.Fragment key={f.id}>
                <tr>
                  <td><strong>{f.serial}</strong>{idx === 0 && <span className="badge badge-approved"> 当前</span>}</td>
                  <td className="muted small">{f.published_at}</td>
                  <td>{f.published_by}</td>
                  <td className="muted small"><code>{f.sha256.slice(0, 16)}…</code></td>
                  <td>{f.note || '—'}</td>
                  <td className="actions">
                    <button className="btn btn-sm" onClick={() => toggle(f.id)}>{openId === f.id ? '收起' : '查看'}</button>
                    <a className="btn btn-sm" href={`/api/files/${f.id}/download`}>下载</a>
                    {idx !== 0 && <button className="btn btn-sm btn-danger" onClick={() => rollback(f)}>回滚到此版</button>}
                  </td>
                </tr>
                {openId === f.id && (
                  <tr>
                    <td colSpan="6"><pre className="zonefile">{content}</pre></td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function AuditTab({ zoneId }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`/api/audit?zone_id=${zoneId}`).then(setRows).catch((e) => setError(e.message));
  }, [zoneId]);
  if (error) return <div className="alert alert-error">{error}</div>;
  return (
    <div className="card">
      <h3>本区域审计日志（不可修改）</h3>
      {!rows ? (
        <p className="muted">加载中…</p>
      ) : (
        <table>
          <thead>
            <tr><th>时间</th><th>操作人</th><th>动作</th><th>详情</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td className="muted small">{r.created_at}</td>
                <td>{r.actor_name}</td>
                <td><code>{r.action}</code></td>
                <td className="muted small">{r.detail || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
