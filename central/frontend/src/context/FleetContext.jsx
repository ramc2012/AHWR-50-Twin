import React, { createContext, useContext, useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { api } from '../api';
import { socket, connectSocket } from '../socket';

// ---------------------------------------------------------------------------------
// P1 annunciation (UI-08): audible chime + optional desktop notification on a
// rising edge of the fleet-wide P1 count. Read-only surveillance UX — nothing here
// (or anywhere in the CRMF) writes toward a rig/PLC.
// ---------------------------------------------------------------------------------
const MUTE_KEY = 'crmf_alarm_muted';

// Lazily-created shared AudioContext. Browsers keep audio suspended until a user
// gesture, so unlockAudio() is wired to the first pointerdown/keydown (see the
// FleetProvider effect below). Same gesture is used to request Notification
// permission, which also requires user activation.
let audioCtx = null;
function unlockAudio() {
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        if (!audioCtx) audioCtx = new Ctx();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
        if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
            try { Notification.requestPermission().catch(() => {}); } catch { /* older callback API */ }
        }
    } catch { /* no audio available — annunciation stays visual-only */ }
}

// Short synthesised two-tone chime (oscillator — no asset file).
function playChime() {
    if (!audioCtx || audioCtx.state !== 'running') return;
    try {
        const t0 = audioCtx.currentTime;
        [[880, 0], [1174.66, 0.18]].forEach(([freq, at]) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.value = freq;
            gain.gain.setValueAtTime(0.0001, t0 + at);
            gain.gain.exponentialRampToValueAtTime(0.2, t0 + at + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.35);
            osc.connect(gain).connect(audioCtx.destination);
            osc.start(t0 + at);
            osc.stop(t0 + at + 0.4);
        });
    } catch { /* ignore — chime is best-effort */ }
}

function notifyP1(count) {
    try {
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        // tag collapses bursts into one notification instead of stacking.
        new Notification('CRMF — priority-1 alarm', {
            body: `${count} P1 (ESD / lockout / well-control) alarm${count > 1 ? 's' : ''} active across the fleet`,
            tag: 'crmf-p1',
        });
    } catch { /* ignore — notification is best-effort */ }
}

const sortFleet = (rows) =>
    rows.sort((a, b) => a.rigId.localeCompare(b.rigId, undefined, { numeric: true }));

// ---------------------------------------------------------------------------------
// Two contexts (UI-14): the fleet array churns on every flush, while the TopBar /
// AlarmStrip / nav badge only need {summary, connected, error, ...}. Splitting them
// keeps the chrome from re-rendering on fleet-array updates.
// ---------------------------------------------------------------------------------
const FleetDataContext = createContext(null);    // { fleet, loading, refresh }
const FleetStatusContext = createContext(null);  // { summary, connected, error, lastUpdate, linkDownSince, muted, toggleMute }

export const useFleetData = () => useContext(FleetDataContext);
export const useFleetStatus = () => useContext(FleetStatusContext);

// Backward-compatible merged hook: existing consumers keep destructuring
// { fleet, summary, connected, error, refresh } exactly as before.
export const useFleet = () => {
    const data = useContext(FleetDataContext);
    const status = useContext(FleetStatusContext);
    return useMemo(() => ({ ...data, ...status }), [data, status]);
};

// Holds the live fleet array + summary, kept current by Socket.IO deltas.
export function FleetProvider({ children }) {
    const [fleet, setFleet] = useState([]);
    const [loading, setLoading] = useState(true);          // UI-23: true until first fleet payload
    const [summary, setSummary] = useState(null);
    const [connected, setConnected] = useState(socket.connected);
    const [error, setError] = useState('');
    const [lastUpdate, setLastUpdate] = useState(null);    // UI-10: last successful data receipt (ms epoch)
    const [linkDownSince, setLinkDownSince] = useState(null); // UI-10: set ~5s after the link drops
    const [muted, setMuted] = useState(() => localStorage.getItem(MUTE_KEY) === '1');

    const byId = useRef(new Map());
    const dirty = useRef(false);          // UI-14: per-rig deltas accumulate in byId; flushed once/sec
    const prevP1 = useRef(null);          // UI-08: previous alarmsP1 for rising-edge detection
    const mutedRef = useRef(muted);
    const downTimer = useRef(null);
    const downAt = useRef(null);

    const toggleMute = useCallback(() => setMuted((m) => {
        const next = !m;
        mutedRef.current = next;
        localStorage.setItem(MUTE_KEY, next ? '1' : '0');
        return next;
    }), []);

    // Rising-edge annunciation: never fires on the first payload after load, only
    // when the fleet-wide P1 count increases while we're watching.
    const applySummary = useCallback((s) => {
        const p1 = Number(s?.alarmsP1) || 0;
        if (prevP1.current != null && p1 > prevP1.current && !mutedRef.current) {
            playChime();
            notifyP1(p1);
        }
        prevP1.current = p1;
        setSummary(s);
    }, []);

    const refresh = useCallback(async () => {
        const [f, s] = await Promise.all([api.fleet(), api.summary()]);
        byId.current = new Map(f.map((r) => [r.rigId, r]));
        dirty.current = false;
        setFleet(sortFleet([...f]));
        applySummary(s);
        setLoading(false);
        setLastUpdate(Date.now());
    }, [applySummary]);

    // Unlock audio (and request Notification permission) on the first user gesture.
    useEffect(() => {
        const unlock = () => {
            unlockAudio();
            window.removeEventListener('pointerdown', unlock);
            window.removeEventListener('keydown', unlock);
        };
        window.addEventListener('pointerdown', unlock);
        window.addEventListener('keydown', unlock);
        return () => {
            window.removeEventListener('pointerdown', unlock);
            window.removeEventListener('keydown', unlock);
        };
    }, []);

    useEffect(() => {
        // Surface non-401 REST failures so consumers can show a banner instead of a
        // permanently-empty fleet with no indication (audit #25). 401s are handled by the
        // axios interceptor (redirect to /login), so they are not treated as fleet errors.
        refresh().then(() => setError('')).catch((e) => {
            if (e?.response?.status !== 401) setError(e?.response?.data?.error || 'Unable to load fleet data');
        });
        connectSocket();

        // UI-14: per-rig deltas land in the ref only; a 1 Hz flush sorts once and does a
        // single setFleet, so a chatty fleet doesn't re-render the wall per message.
        const onUpdate = (row) => {
            byId.current.set(row.rigId, row);
            dirty.current = true;
        };
        const flushTimer = setInterval(() => {
            if (!dirty.current) return;
            dirty.current = false;
            setFleet(sortFleet(Array.from(byId.current.values())));
            setLoading(false);
            setLastUpdate(Date.now());
            setError('');
        }, 1000);

        const onSummary = (s) => { applySummary(s); setLastUpdate(Date.now()); setError(''); };

        // UI-10: mark the link down on disconnect OR connect_error; only surface the
        // "down since" banner if it stays down ~5s (rides out transient reconnects).
        const markDown = () => {
            setConnected(false);
            if (downAt.current == null) downAt.current = Date.now();
            if (!downTimer.current) {
                downTimer.current = setTimeout(() => {
                    downTimer.current = null;
                    if (downAt.current != null) setLinkDownSince(downAt.current);
                }, 5000);
            }
        };
        const onConn = () => {
            setConnected(true);
            if (downTimer.current) { clearTimeout(downTimer.current); downTimer.current = null; }
            downAt.current = null;
            setLinkDownSince(null);
        };
        const onDisc = () => markDown();
        const onConnError = () => markDown();

        // Periodic REST re-sync: if the initial load failed, this lets the view self-heal
        // (and clears the error banner) without requiring a page reload.
        const poll = setInterval(() => {
            refresh().then(() => setError('')).catch((e) => {
                if (e?.response?.status !== 401) setError(e?.response?.data?.error || 'Unable to load fleet data');
            });
        }, 30000);

        socket.on('fleet_update', onUpdate);
        socket.on('fleet_summary', onSummary);
        socket.on('connect', onConn);
        socket.on('disconnect', onDisc);
        socket.on('connect_error', onConnError);
        return () => {
            clearInterval(poll);
            clearInterval(flushTimer);
            if (downTimer.current) { clearTimeout(downTimer.current); downTimer.current = null; }
            socket.off('fleet_update', onUpdate);
            socket.off('fleet_summary', onSummary);
            socket.off('connect', onConn);
            socket.off('disconnect', onDisc);
            socket.off('connect_error', onConnError);
        };
    }, [refresh, applySummary]);

    const dataValue = useMemo(() => ({ fleet, loading, refresh }), [fleet, loading, refresh]);
    const statusValue = useMemo(
        () => ({ summary, connected, error, lastUpdate, linkDownSince, muted, toggleMute }),
        [summary, connected, error, lastUpdate, linkDownSince, muted, toggleMute]
    );

    return (
        <FleetStatusContext.Provider value={statusValue}>
            <FleetDataContext.Provider value={dataValue}>
                {children}
            </FleetDataContext.Provider>
        </FleetStatusContext.Provider>
    );
}
