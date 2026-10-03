import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

const STATUS_LABEL = {
  draft: '草稿',
  in_review: '待复核',
  approved: '已复核',
  rejected: '已驳回',
  published: '已发布',
  superseded: '已作废',
};

export function StatusBadge({ status }) {
  return <span className={`badge badge-${status}`}>{STATUS_LABEL[status] || status}</span>;
}

export default function ZoneList() {
  const [zones, setZones] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', primary_ns: '', admin_email: '', default_ttl: 3600 });
  const [createErrors, setCreateErrors] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = () => {
    api.get('/api/zones').then(setZones).catch((e) => setError(e.message));
  };
  useEffect(load, []);

  const create = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    setCreateErrors([]);
    try {
      await api.post('/api/zones', { ...form, default_ttl: Number(form.default_ttl) });
      setForm({ name: '', primary_ns: '', admin_email: '', default_ttl: 3600 });
      load();
    } catch (err) {
      setError(err.message);
      if (err.data && err.data.validation_errors) setCreateErrors(err.data.validation_errors);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h2>区域管理</h2>
      {error && <div className="alert alert-error">{error}</div>}

      <div className="card">
        <h3>新建区域</h3>
        {createErrors.length > 0 && (
          <div className="alert alert-error">
            <ul>
              {createErrors.map((e, i) => <li key={i}>{e.message}</li>)}
            </ul>
          </div>
        )}
        <form className="form-grid" onSubmit={create}>
          <label>
            区域名（如 example.com）
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="example.com" required />
          </label>
          <label>
            主 DNS 服务器
            <input value={form.primary_ns} onChange={(e) => setForm({ ...form, primary_ns: e.target.value })} placeholder="ns1.example.com" required />
          </label>
          <label>
            管理员邮箱
            <input value={form.admin_email} onChange={(e) => setForm({ ...form, admin_email: e.target.value })} placeholder="hostmaster@example.com" required />
          </label>
          <label>
            默认 TTL（秒）
            <input type="number" min="1" value={form.default_ttl} onChange={(e) => setForm({ ...form, default_ttl: e.target.value })} required />
          </label>
          <div className="form-actions">
            <button className="btn btn-primary" disabled={busy}>创建区域</button>
          </div>
        </form>
      </div>

      <div className="card">
        <h3>区域列表</h3>
        {!zones ? (
          <p className="muted">加载中…</p>
        ) : zones.length === 0 ? (
          <p className="muted">暂无区域，请先创建。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>区域名</th>
                <th>当前序列号</th>
                <th>发布次数</th>
                <th>进行中的修订</th>
                <th>更新时间</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {zones.map((z) => (
                <tr key={z.id}>
                  <td><strong>{z.name}</strong></td>
                  <td>{z.current_serial ?? '（未发布）'}</td>
                  <td>{z.publish_count}</td>
                  <td>
                    {z.open_revision ? (
                      <>
                        <StatusBadge status={z.open_revision.status} />{' '}
                        <span className="muted small">#{z.open_revision.rev_no} by {z.open_revision.author}</span>
                      </>
                    ) : (
                      <span className="muted">无</span>
                    )}
                  </td>
                  <td className="muted small">{z.updated_at}</td>
                  <td><Link className="btn btn-sm" to={`/zones/${z.id}`}>进入</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
