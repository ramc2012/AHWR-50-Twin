import React, { createContext, useContext, useState, useEffect } from 'react';
import axios from '../api';
import { disconnectSocket } from '../socket';

const AuthContext = createContext(null);

const setAuthHeader = (token) => {
    if (token) {
        axios.defaults.headers.common['Authorization'] = 'Bearer ' + token;
    } else {
        delete axios.defaults.headers.common['Authorization'];
    }
};

export const AuthProvider = ({ children }) => {
    const [user, setUser] = useState(null);
    const [token, setToken] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let cancelled = false;

        const clearStoredSession = () => {
            localStorage.removeItem('romii_user');
            localStorage.removeItem('romii_token');
            setAuthHeader(null);
        };

        const restoreSession = async () => {
            // Restore persisted session only after the token still validates.
            const storedToken = localStorage.getItem('romii_token');
            if (!storedToken) {
                clearStoredSession();
                if (!cancelled) setLoading(false);
                return;
            }

            setAuthHeader(storedToken);
            try {
                const { data } = await axios.get('/api/me');
                if (cancelled) return;
                const restoredUser = data?.user;
                if (!restoredUser) throw new Error('Session response missing user');
                setToken(storedToken);
                setUser(restoredUser);
                localStorage.setItem('romii_user', JSON.stringify(restoredUser));
            } catch (e) {
                if (!cancelled) {
                    setUser(null);
                    setToken(null);
                    clearStoredSession();
                }
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        restoreSession();

        return () => {
            cancelled = true;
        };
    }, []);

    const login = (userData, newToken) => {
        setUser(userData);
        setToken(newToken);
        localStorage.setItem('romii_user', JSON.stringify(userData));
        if (newToken) localStorage.setItem('romii_token', newToken);
        setAuthHeader(newToken);
    };

    const logout = () => {
        setUser(null);
        setToken(null);
        localStorage.removeItem('romii_user');
        localStorage.removeItem('romii_token');
        setAuthHeader(null);
        // Tear down the live socket on logout (lifecycle owned by auth, opened by Layout).
        disconnectSocket();
    };

    return (
        <AuthContext.Provider value={{ user, token, login, logout, loading }}>
            {!loading && children}
        </AuthContext.Provider>
    );
};

export const useAuth = () => useContext(AuthContext);
