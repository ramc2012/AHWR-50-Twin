import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { api } from '../api';

// Per-rig live data for the remote HMI mirror. Polls /api/rigs/:id/live (the edge
// `rig_data` shape reconstructed centrally) on an interval and exposes it via a hook,
// so the ported edge operator panels read `data.<measurement>.<field>` unchanged.
// READ-ONLY: this only fetches reshaped telemetry already received from the rig.
const RigDataContext = createContext(null);
export const useRigData = () => useContext(RigDataContext) || { data: null, loading: true, error: '' };

export function RigDataProvider({ rigId, intervalMs = 2000, children }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const alive = useRef(true);

    const load = useCallback(() => {
        if (!rigId) return;
        api.rigLive(rigId)
            .then((d) => { if (alive.current) { setData(d); setError(''); } })
            .catch((e) => { if (alive.current && e?.response?.status !== 401) setError(e?.response?.data?.error || 'live data unavailable'); })
            .finally(() => { if (alive.current) setLoading(false); });
    }, [rigId]);

    useEffect(() => {
        alive.current = true;
        setLoading(true); load();
        const t = setInterval(load, intervalMs);
        return () => { alive.current = false; clearInterval(t); };
    }, [load, intervalMs]);

    return (
        <RigDataContext.Provider value={{ data, loading, error, rigId, refresh: load }}>
            {children}
        </RigDataContext.Provider>
    );
}
