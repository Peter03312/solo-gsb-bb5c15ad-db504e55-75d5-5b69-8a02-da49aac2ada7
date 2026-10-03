import React, { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

export default function Login() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/zones" replace />;

  const submit = async (e) => {
    e.preventDefault();
    setErr(''); setBusy(true);
    try {
      await login(username.trim(), password);
      nav('/zones');
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>DNS 区域审定台</h1>
        <p className="sub">离线环境 · 本地账号登录</p>
        {err && <div className="alert error">{err}</div>}
        <label>账号</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <label>密码</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <div className="btn-row">
          <button className="primary" disabled={busy} style={{ width: '100%' }}>{busy ? '登录中…' : '登 录'}</button>
        </div>
        <p className="small muted" style={{ marginTop: 16 }}>
          初始账号：editor/editor123（编辑）、reviewer/reviewer123（复核）、admin/admin123（管理）
        </p>
      </form>
    </div>
  );
}
