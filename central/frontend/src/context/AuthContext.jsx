import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import { api, setToken } from '../api';

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }) {
    const [user, setUser] = useState(() => {
        try { return JSON.parse(localStorage.getItem('crmf_user') || 'null'); } catch { return null; }
    });

    // Validate the stored token on mount: a stale/expired token otherwise renders the
    // app shell until the first API call 401s. Network failures are NOT a reason to
    // log out (offline != expired), so only clear state on a definitive 401/403.
    useEffect(() => {
        if (!localStorage.getItem('crmf_token')) return;
        let alive = true;
        api.me()
            .then((me) => { if (alive && me?.user) { localStorage.setItem('crmf_user', JSON.stringify(me.user)); setUser(me.user); } })
            .catch((e) => {
                const s = e?.response?.status;
                if (alive && (s === 401 || s === 403)) {
                    setToken(null);
                    localStorage.removeItem('crmf_user');
                    setUser(null);
                }
            });
        return () => { alive = false; };
    }, []);

    const login = useCallback(async (username, password) => {
        const { token, user } = await api.login(username, password);
        setToken(token);
        localStorage.setItem('crmf_user', JSON.stringify(user));
        setUser(user);
        return user;
    }, []);

    const logout = useCallback(() => {
        setToken(null);
        localStorage.removeItem('crmf_user');
        setUser(null);
    }, []);

    const can = useCallback((role) => {
        const rank = { viewer: 1, operator: 2, admin: 3 };
        return (rank[user?.role] || 0) >= (rank[role] || 99);
    }, [user]);

    return (
        <AuthContext.Provider value={{ user, login, logout, can }}>
            {children}
        </AuthContext.Provider>
    );
}
