import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../auth.jsx';
import { useAuth } from '../auth.jsx';

export default function ZoneList() {
  const { user } = useAuth();
  const canEdit = user.role === 'admin' || user.role === 'editor';
  const [zones, setZones] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', mname: '', rname: '', ns: '' });
  const [errors, setErrors] = useState([]);
  const [err, setErr] = useState('');

  const load = async () => {
    const d = await api('/api/zones');
    setZones(d.zones);
  };
  useEffect(() => { load().catch((e) => setErr(e.message)); }, []);

  const create = async (e) => {
    e.preventDefault();
    setErr(''); setErrors([]);
    try {
      const content = {
        zoneName: form.name,
        mname: form.mname,
        rname: form.rname,
        records: [{ id: 'r1', name: '@', type: 'NS', ttl: 3600, value: form.ns }]
      };
      const d = await api('/api/zones', { method: 'POST', body: { name: form.name, ...content } });
      setShowCreate(false);
      window.location.href = `/zones/${d.id}`;
    } catch (e2) {
      if (e2.status === 422) setErrors(e2.data.errors || []);
      else setErr(e2.message);
    }
  };

  const fieldErr = (f) => errors.filter((x) => x.field === f && x.index < 0).map((x) => x.reason).join('；');

  return (
    <div className="container">
      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <h2 className="mt0" style={{ flex: 1, marginBottom: 0 }}>DNS 区域</h2>
          {canEdit && <button className="primary" onClick={() => setShowCreate((v) => !v)}>{showCreate ? '取消' : '＋ 新建区域'}</button>}
        </div>

        {showCreate && (
          <form onSubmit={create} style={{ marginTop: 16 }}>
            {err && <div className="alert error">{err}</div>}
            <div className="grid2">
              <div>
                <label>区域名（如 example.org）</label>
                <input className="mono" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="example.org" />
                {fieldErr('zoneName') && <div className="err-hint">{fieldErr('zoneName')}</div>}
                <label>主 DNS（MNAME，完整域名以点结尾）</label>
                <input className="mono" value={form.mname} onChange={(e) => setForm({ ...form, mname: e.target.value })} placeholder="ns1.example.org." />
                {fieldErr('mname') && <div className="err-hint">{fieldErr('mname')}</div>}
                <label>管理员邮箱</label>
                <input className="mono" value={form.rname} onChange={(e) => setForm({ ...form, rname: e.target.value })} placeholder="hostmaster@example.org" />
                {fieldErr('rname') && <div className="err-hint">{fieldErr('rname')}</div>}
                <label>初始顶点 NS（完整域名以点结尾）</label>
                <input className="mono" value={form.ns} onChange={(e) => setForm({ ...form, ns: e.target.value })} placeholder="ns1.example.org." />
                {errors.find((x) => x.index === 0) && <div className="err-hint">{errors.find((x) => x.index === 0).reason}</div>}
              </div>
              <div>
                <div className="alert info small">
                  创建时即进行整体验证。创建后可在区域详情中添加 A / AAAA / CNAME / MX / TXT 记录、暂存草稿、
                  提交另一账号复核并发布。
                </div>
              </div>
            </div>
            <div className="btn-row"><button className="primary" type="submit">验证并创建</button></div>
          </form>
        )}
      </div>

      <div className="panel">
        {!zones ? <div className="muted">{err || '加载中…'}</div> : zones.length === 0 ? (
          <div className="muted">尚无区域。{canEdit && '点击「新建区域」开始。'}</div>
        ) : (
          <table>
            <thead><tr><th>区域名</th><th>当前草稿</th><th>最新发布序列号</th><th>发布次数</th><th></th></tr></thead>
            <tbody>
              {zones.map((z) => (
                <tr key={z.id}>
                  <td className="mono">{z.name}</td>
                  <td>#{z.rev_no}</td>
                  <td className="mono">{z.last_serial || '—'}</td>
                  <td>{z.published_count}</td>
                  <td><Link to={`/zones/${z.id}`}>打开 →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
