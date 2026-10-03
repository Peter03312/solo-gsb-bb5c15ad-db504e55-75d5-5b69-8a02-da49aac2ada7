import React, { createContext, useContext, useEffect, useState } from 'react';
import { Routes, Route, Navigate, Link, useNavigate, useLocation } from 'react-router-dom';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import ZoneList from './pages/ZoneList.jsx';
import ZoneDetail from './pages/ZoneDetail.jsx';
import AuditLog from './pages/AuditLog.jsx';

const AuthCtx = createContext(null);
export const useAuth = () => useContext(AuthCtx);

function Layout({ children }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const logout = async () => {
    try {
      await api.post('/api/auth/logout');
    } catch {
      /* 忽略 */
    }
    setUser(null);
    navigate('/login');
  };

  return (
    <div>
      <header className="topbar">
        <div className="topbar-inner">
          <span className="brand">DNS 区域审定台</span>
          <nav>
            <Link className={location.pathname === '/' ? 'active' : ''} to="/">区域管理</Link>
            <Link className={location.pathname === '/audit' ? 'active' : ''} to="/audit">审计日志</Link>
          </nav>
          <div className="topbar-user">
            <span>{user.display_name}（{user.username}）</span>
            <button className="btn btn-sm" onClick={logout}>退出登录</button>
          </div>
        </div>
      </header>
      <main className="container">{children}</main>
    </div>
  );
}

function RequireAuth({ children }) {
  const { user, loading } = useAuth();
  if (loading) return <div className="container"><p className="muted">加载中…</p></div>;
  if (!user) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/api/auth/me')
      .then(setUser)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <AuthCtx.Provider value={{ user, setUser, loading }}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<RequireAuth><ZoneList /></RequireAuth>} />
        <Route path="/zones/:id" element={<RequireAuth><ZoneDetail /></RequireAuth>} />
        <Route path="/audit" element={<RequireAuth><AuditLog /></RequireAuth>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthCtx.Provider>
  );
}
