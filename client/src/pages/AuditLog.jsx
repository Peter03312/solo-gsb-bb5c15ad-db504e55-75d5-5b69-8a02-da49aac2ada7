import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

export default function AuditLog() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/api/audit').then(setRows).catch((e) => setError(e.message));
  }, []);

  return (
    <div>
      <h2>审计日志</h2>
      {error && <div className="alert alert-error">{error}</div>}
      <div className="card">
        {!rows ? (
          <p className="muted">加载中…</p>
        ) : rows.length === 0 ? (
          <p className="muted">暂无审计记录。</p>
        ) : (
          <table>
            <thead>
              <tr><th>时间</th><th>操作人</th><th>动作</th><th>区域</th><th>详情</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="muted small">{r.created_at}</td>
                  <td>{r.actor_name}</td>
                  <td><code>{r.action}</code></td>
                  <td>{r.zone_id ?? '—'}</td>
                  <td className="muted small">{r.detail || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
