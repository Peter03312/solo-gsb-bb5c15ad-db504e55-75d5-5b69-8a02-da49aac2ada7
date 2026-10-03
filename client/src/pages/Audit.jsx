import React, { useEffect, useState } from 'react';
import { api } from '../auth.jsx';

const ACTIONS = {
  login: '登录', login_failed: '登录失败', logout: '退出',
  zone_create: '创建区域', draft_save: '暂存草稿',
  review_approve: '复核通过', review_reject: '复核驳回',
  publish: '发布', rollback_draft: '创建回滚草稿', rollback_publish: '回滚发布',
  download: '下载区域文件'
};

export default function Audit() {
  const [entries, setEntries] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api('/api/audit?limit=500').then((d) => setEntries(d.entries)).catch((e) => setErr(e.message));
  }, []);

  return (
    <div className="container">
      <div className="panel">
        <h2 className="mt0">审计历史（仅追加，不可修改）</h2>
        {err && <div className="alert error">{err}</div>}
        {!entries ? <div className="muted">加载中…</div> : (
          <table>
            <thead><tr><th style={{ width: 160 }}>时间 (UTC)</th><th style={{ width: 120 }}>账号</th><th style={{ width: 130 }}>动作</th><th>详情</th></tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="mono small">{e.created_at}</td>
                  <td>{e.username || <span className="muted">（未认证）</span>}</td>
                  <td><span className="pill gray">{ACTIONS[e.action] || e.action}</span></td>
                  <td className="small">{e.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
