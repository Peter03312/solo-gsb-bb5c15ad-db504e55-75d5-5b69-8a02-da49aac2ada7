import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

const AuthContext = createContext(null);

export async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data || {};
    throw err;
  }
  return data;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const d = await api('/api/auth/me');
      setUser(d.user);
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const login = async (username, password) => {
    const d = await api('/api/auth/login', { method: 'POST', body: { username, password } });
    setUser(d.user);
  };
  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' });
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, ready, login, logout, refresh }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
