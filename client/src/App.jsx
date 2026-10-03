import React from 'react';
import { Routes, Route, Navigate, Link, useNavigate } from 'react-router-dom';
import { useAuth } from './auth.jsx';
import Login from './pages/Login.jsx';
import ZoneList from './pages/ZoneList.jsx';
import ZoneEdit from './pages/ZoneEdit.jsx';
import Audit from './pages/Audit.jsx';

const ROLE_LABEL = { admin: '管理员', editor: '编辑员', reviewer: '复核员' };

function TopBar() {
  const { user, logout } = useAuth();
  const nav = useNavigate();
  if (!user) return null;
  return (
    <div className="topbar">
      <div className="brand">🛰 DNS 区域审定台</div>
      <nav>
        <Link to="/zones">区域</Link>
        {user.role === 'admin' && <Link to="/audit">审计历史</Link>}
      </nav>
      <div className="spacer" />
      <span className="small muted">{user.displayName}</span>
      <span className={`badge role-${user.role}`}>{ROLE_LABEL[user.role] || user.role}</span>
      <button onClick={async () => { await logout(); nav('/login'); }}>退出</button>
    </div>
  );
}

function Protected({ children, roles }) {
  const { user, ready } = useAuth();
  if (!ready) return <div className="container">加载中…</div>;
  if (!user) return <Navigate to="/login" replace />;
  if (roles && !roles.includes(user.role)) {
    return <div className="container"><div className="alert error">当前角色无权访问该页面。</div></div>;
  }
  return children;
}

export default function App() {
  return (
    <div className="layout">
      <TopBar />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/zones" element={<Protected><ZoneList /></Protected>} />
        <Route path="/zones/:id" element={<Protected><ZoneEdit /></Protected>} />
        <Route path="/audit" element={<Protected roles={['admin']}><Audit /></Protected>} />
        <Route path="*" element={<Navigate to="/zones" replace />} />
      </Routes>
    </div>
  );
}
