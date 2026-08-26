import React, { createContext, useContext, useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { api } from '../api';

// Per-rig live data for the remote HMI mirror. Polls /api/rigs/:id/live (the edge
// `rig_data` shape reconstructed centrally) on an interval and exposes it via a hook,
// so the ported edge operator panels read `data.<measurement>.<field>` unchanged.
// READ-ONLY: this only fetches reshaped telemetry already received from the rig.
const RigDataContext = createContext(null);
export const useRigData = () => useContext(RigDataContext) || { data: null, loading: true, error: '' };

// Cheap change key for the live payload: source timestamp + rig status + alarm counts
// (NOT ts alone — an alarm ack/raise can land without a new telemetry sample). When the
// key is unchanged the payload is identical for rendering purposes, so we skip setData
// and spare every subscribed panel a re-render on quiet 2s polls.
const payloadKey = (d) => {
    if (!d) return '';
    const m = d._meta || {}, a = d._alarms || {};
    return [m.ts, m.status, a.raised, a.acknowledged, a.critical, a.high, a.medium, a.low, a.highest].join('|');
};

export function RigDataProvider({ rigId, intervalMs = 2000, children }) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');
    const alive = useRef(true);
    const lastKey = useRef('');

    const load = useCallback(() => {
        if (!rigId) return;
        api.rigLive(rigId)
            .then((d) => {
                if (!alive.current) return;
                const key = payloadKey(d);
                if (key !== lastKey.current) { lastKey.current = key; setData(d); }
                setError('');
            })
            .catch((e) => { if (alive.current && e?.response?.status !== 401) setError(e?.response?.data?.error || 'live data unavailable'); })
            .finally(() => { if (alive.current) setLoading(false); });
    }, [rigId]);

    useEffect(() => {
        alive.current = true;
        lastKey.current = '';
        setLoading(true); load();
        const t = setInterval(load, intervalMs);
        return () => { alive.current = false; clearInterval(t); };
    }, [load, intervalMs]);

    const value = useMemo(
        () => ({ data, loading, error, rigId, refresh: load }),
        [data, loading, error, rigId, load]
    );

    return (
        <RigDataContext.Provider value={value}>
            {children}
        </RigDataContext.Provider>
    );
}
