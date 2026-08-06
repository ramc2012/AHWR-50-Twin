import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTheme } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { socket } from '../../socket';
import axios, { LONG_TIMEOUT_MS } from '../../api';
import { useAlarms, ALARM_BLINK } from '../../context/AlarmContext';
import { priorityColor } from '../../utils/alarms';

// ===========================================================================
// RigConsoleOverview — WORKOVER / well-service rig console.
//
// This rig is a workover (well-service) unit, NOT a drilling rig: a telescoping
// guyed mast, a hydraulic top drive (HTD), a power casing tong (PCT), a catwalk
// (CWK), an anti-collision/travel-limit system (ACS), an HPU and a CAT genset.
// The layout is: annunciator ticker · string & activity column · workover mast
// schematic flanked by equipment summary cards · well-control bar · primary
// instruments · working-day (06:00->06:00 IST) trend ribbons.
//
// Data:
//   live      -> socket 'rig_data' (+ /api/rig/latest), incl. server-computed
//                `_activity`, `_kpi`, `_efficiency`
//   alarms    -> socket 'alarms' (+ /api/alarms), per-parameter blink/latch
//   history   -> /api/history seeds the working-day trends from 06:00 IST
//   rig/well  -> /api/dashboard/layout (wellInfo) + /api/wells/active
//
// Honesty rules (repo README):
//   * Safety-critical signals are never fabricated — `sv()` renders "—" when
//     the feed is stale/dead, and well-control values are additionally gated on
//     `well_control.available`.
//   * Nothing without a real tag is invented. Formation layers, choke/kill
//     manifolds and a synthesized kill pressure were REMOVED for this reason.
//   * ACS savers are shown as raw clearances (mm) and are NOT threshold-
//     coloured, because no acs.* alarm rule exists in the backend config.
// ===========================================================================

const DARK = { bg: '#0a0d14', bg2: '#10141f', bg3: '#070a10', line: '#1f2736', line2: '#2c3648', txt: '#e9eef7', txt2: '#8593a9', txt3: '#525d72' };
const LIGHT = { bg: '#eef1f6', bg2: '#ffffff', bg3: '#f4f7fb', line: '#dce2ec', line2: '#c6cedb', txt: '#0d1320', txt2: '#4b566a', txt3: '#8a96aa' };
const ACCENT = { a1: '#ff9d2e', a2: '#27cfe6', b1: '#a9ef34', b2: '#9a8bff', ok: '#23dd86', warn: '#ffc24b', crit: '#ff4a60', info: '#46a6ff' };

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const SANS = "'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif";

// drawworks.block_position is MILLIMETRES, straight off the PLC with no scaling.
// The tag ("ACS Actual Block Position", DB174.R150) sits in the same ACS block as
// "ACS Crownsaver in mm" / "ACS Bottomsaver in mm", and carries no scale factor.
// This was previously treated as feet on the strength of a comment claiming the
// backend converted with 0.3048 — no such conversion exists anywhere in the backend.
// CONFIGURED mast travel — not telemetry. Used only to scale the mast drawing.
const MAST_BLOCK_MIN_MM = 0;
const MAST_BLOCK_MAX_MM = 15000;

// Workover activity codes (backend/lib/workover.js).
const ACT_COLOR = {
    RIH: ACCENT.a2, POOH: ACCENT.a1, MAKE_UP: ACCENT.b1, BREAK_OUT: ACCENT.warn,
    CIRCULATE: ACCENT.info, SWAB: ACCENT.b2, FISHING: ACCENT.b2,
    RIG_UP: ACCENT.ok, RIG_DOWN: ACCENT.ok, IDLE: '#7c8aa0', WAIT: ACCENT.crit,
};

// ---- math helpers ---------------------------------------------------------
const polar = (cx, cy, r, deg) => { const a = (deg - 90) * Math.PI / 180; return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }; };
const arc = (cx, cy, r, a0, a1) => {
    const s = polar(cx, cy, r, a1), e = polar(cx, cy, r, a0);
    const large = (a1 - a0) <= 180 ? 0 : 1;
    return ['M', s.x.toFixed(2), s.y.toFixed(2), 'A', r, r, 0, large, 0, e.x.toFixed(2), e.y.toFixed(2)].join(' ');
};
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const fmt = (v, d = 0) => Number(v).toFixed(d);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const hhmmss = (iso) => { const d = iso ? new Date(iso) : null; return (!d || isNaN(d.getTime())) ? '--:--:--' : d.toLocaleTimeString('en-GB', { hour12: false }); };

// Sparkline over a FIXED time domain [t0,t1] (the working day), so the trace
// fills in left-to-right across the tour instead of rescaling to "since load".
const sparkDay = (pts, w, h, t0, t1) => {
    if (!Array.isArray(pts) || pts.length < 2) return { line: '', area: '' };
    const vs = pts.map((p) => p.v);
    const min = Math.min(...vs), max = Math.max(...vs), rng = (max - min) || 1;
    const span = (t1 - t0) || 1;
    const xy = pts.map((p) => [
        clamp01((p.t - t0) / span) * w,
        h - ((p.v - min) / rng) * (h - 3) - 1.5,
    ]);
    const line = xy.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    const lastX = xy[xy.length - 1][0];
    return { line, area: `${line} L ${lastX.toFixed(1)} ${h} L ${xy[0][0].toFixed(1)} ${h} Z` };
};

// ---- status decoders (mirror the equipment dashboards exactly) ------------
const UNK = { text: '---', color: '#64748b' };
const dec = (map) => (v) => map[Number(v)] || UNK;
const S = {
    // 0 OFF / 1 ON IDLE / 2 ON  (HPU, HTD, PCT)
    onIdleOn: dec({ 0: { text: 'OFF', color: '#64748b' }, 1: { text: 'IDLE', color: '#38bdf8' }, 2: { text: 'ON', color: '#4ade80' } }),
    engine: dec({
        [-1]: UNK, 0: { text: 'READY', color: '#38bdf8' }, 1: { text: 'RUNNING', color: '#38bdf8' },
        2: { text: 'DONE', color: '#4ade80' }, 3: { text: 'EMERGENCY', color: '#ef4444' },
        4: { text: 'NOT READY', color: '#fbbf24' }, 5: { text: 'FAULT', color: '#ef4444' },
        6: { text: 'RUN+FAULT', color: '#f97316' }, 7: { text: 'STOP FORCED', color: '#ef4444' },
    }),
    pctSeq: dec({
        0: { text: 'OFF', color: '#64748b' }, 1: { text: 'MAKE-UP', color: '#38bdf8' },
        2: { text: 'BREAK-OUT', color: '#fbbf24' }, 3: { text: 'RESET', color: '#94a3b8' },
        4: { text: 'FAULT', color: '#ef4444' },
    }),
    cwkPark: dec({ 0: { text: 'NOT IN PARK', color: '#fbbf24' }, 1: { text: 'PARKED', color: '#4ade80' } }),
    carrier: dec({
        1: { text: 'STOP', color: '#94a3b8' }, 2: { text: 'PARK POS', color: '#4ade80' },
        3: { text: 'WORK POS', color: '#4ade80' }, 4: { text: 'LIFTING', color: '#38bdf8' },
        5: { text: 'LOWERING', color: '#38bdf8' }, 6: { text: 'FAULT', color: '#ef4444' },
    }),
    clamp: dec({
        0: { text: 'NONE', color: '#64748b' }, 1: { text: 'OPENING', color: '#38bdf8' },
        2: { text: 'CLOSING', color: '#38bdf8' }, 3: { text: 'OPEN', color: '#4ade80' },
        4: { text: 'CLOSED', color: '#fbbf24' }, 5: { text: 'FAULT', color: '#ef4444' },
    }),
    elevator: dec({
        0: UNK, 1: { text: 'OPENING', color: '#38bdf8' }, 2: { text: 'CLOSING', color: '#38bdf8' },
        3: { text: 'OPEN', color: '#4ade80' }, 4: { text: 'CLOSED', color: '#fbbf24' }, 5: { text: 'FAULT', color: '#ef4444' },
    }),
    rotation: dec({ 0: { text: 'STOPPED', color: '#94a3b8' }, 1: { text: 'FWD', color: '#4ade80' }, 2: { text: 'BWD', color: '#fbbf24' }, 3: { text: 'NEUTRAL', color: '#94a3b8' } }),
    acs: dec({ 0: UNK, 1: { text: 'ON', color: '#4ade80' }, 2: { text: 'OFF', color: '#64748b' }, 3: { text: 'DISABLED', color: '#ef4444' } }),
    acsCal: dec({
        [-1]: UNK, 1: { text: 'CALIBRATING', color: '#38bdf8' }, 2: { text: 'NOT CALIBRATED', color: '#fbbf24' },
        3: { text: 'CALIBRATED', color: '#4ade80' }, 10: { text: 'MOVE UP', color: '#38bdf8' }, 11: { text: 'MOVE DOWN', color: '#38bdf8' },
    }),
    gear: (v) => {
        const n = Number(v);
        if (n === -1) return { text: 'FAULT', color: '#ef4444' };
        if (n >= 1 && n <= 4) return { text: `GEAR ${n}`, color: '#4ade80' };
        if (n >= 5 && n <= 8) return { text: `G${n - 4} REGEN`, color: '#38bdf8' };
        return UNK;
    },
};

// Working-day trend ribbons. `metric` is the backend /api/history key
// (measurement.field); `get` reads the same signal from the live payload so
// live samples can be appended on top of the seeded history.
const TREND_DEFS = [
    { id: 'hookLoad', label: 'HOOK LOAD', unit: 't', color: ACCENT.a1, d: 0, metric: 'drawworks.hook_load', get: (r) => num(r.drawworks?.hook_load) },
    { id: 'blockPos', label: 'BLOCK POS', unit: 'ft', color: ACCENT.a2, d: 1, metric: 'drawworks.block_position', get: (r) => num(r.drawworks?.block_position) },
    { id: 'htdRpm', label: 'HTD RPM', unit: 'rpm', color: ACCENT.ok, d: 0, metric: 'htd.rpm', get: (r) => num(r.htd?.rpm) },
    { id: 'htdTorque', label: 'HTD TORQUE', unit: 'daN·m', color: ACCENT.b2, d: 0, metric: 'htd.torque', get: (r) => num(r.htd?.torque) },
    { id: 'pctTorque', label: 'PCT MAKE-UP', unit: 'daN·m', color: ACCENT.b1, d: 0, metric: 'pct.makeup_torque', get: (r) => num(r.pct?.makeup_torque) },
    { id: 'hpuPress', label: 'HPU PRESS', unit: 'bar', color: ACCENT.info, d: 0, metric: 'hpu.discharge_pressure', get: (r) => num(r.hpu?.discharge_pressure) },
    { id: 'genLoad', label: 'GENSET LOAD', unit: '%', color: ACCENT.warn, d: 0, metric: 'cat_engine.load', get: (r) => num(r.cat_engine?.load) },
    { id: 'tubingP', label: 'TUBING PRESS', unit: 'bar', color: ACCENT.crit, d: 0, metric: 'wellhead.tubing_pressure', get: (r) => num(r.wellhead?.tubing_pressure) },
];
const TREND_MAX_POINTS = 1500;

// --- Working day: 06:00 -> 06:00, anchored to IST -------------------------
// Anchored EXPLICITLY to IST (+05:30) rather than the viewer's local clock, so
// the window is always the RIG's working day (the backend container runs UTC and
// a central viewer may sit in another timezone).
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const WORKDAY_START_HOUR = 6;
const computeWorkingDay = (nowMs = Date.now()) => {
    const ist = nowMs + IST_OFFSET_MS;          // IST wall-clock as if UTC
    const d = new Date(ist);
    let startIst = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), WORKDAY_START_HOUR, 0, 0, 0);
    if (ist < startIst) startIst -= 24 * 60 * 60 * 1000;   // before 06:00 -> previous tour
    const dayStart = startIst - IST_OFFSET_MS;
    return { dayStart, dayEnd: dayStart + 24 * 60 * 60 * 1000 };
};

export default function RigConsoleOverview() {
    const muiTheme = useTheme();
    const navigate = useNavigate();
    const isDark = muiTheme.palette.mode !== 'light';
    const c = isDark ? DARK : LIGHT;
    const A = ACCENT;

    // Per-parameter alarm overlay: a widget whose dataKey is in alarm shows the
    // priority colour and blinks while unacked/latched (steady once acknowledged).
    const { byDataKey } = useAlarms();
    const alarmFor = (dk) => {
        const a = dk && byDataKey[dk];
        if (!a) return null;
        const blink = a.state === 'UNACK' || a.state === 'RTN_UNACK';
        return { color: priorityColor(a.priority), blink, state: a.state, priority: a.priority, condition: a.condition };
    };
    const blinkAnim = (al) => (al && al.blink ? `${ALARM_BLINK} 1s steps(1, end) infinite` : 'none');

    const [raw, setRaw] = useState({});
    const [alarms, setAlarms] = useState([]);
    const [identity, setIdentity] = useState({ rig: '', well: '' });
    const [feed, setFeed] = useState({ connected: socket.connected, stale: false, hasData: false });

    // Working-day trend series: { id: [{t,v}] }, seeded from /api/history.
    const [workingDay, setWorkingDay] = useState(() => computeWorkingDay());
    const histRef = useRef(Object.fromEntries(TREND_DEFS.map((t) => [t.id, []])));
    const [, setTick] = useState(0);

    const pushHist = useCallback((data) => {
        const now = Date.now();
        const h = histRef.current;
        TREND_DEFS.forEach((t) => {
            const v = t.get(data);
            if (!Number.isFinite(v)) return;
            const arr = h[t.id];
            arr.push({ t: now, v });
            if (arr.length > TREND_MAX_POINTS) arr.shift();
        });
        setTick((x) => x + 1);
    }, []);

    // Roll the window over at 06:00 IST without a manual refresh.
    useEffect(() => {
        const id = setInterval(() => {
            const next = computeWorkingDay();
            setWorkingDay((prev) => (prev.dayStart === next.dayStart ? prev : next));
        }, 60 * 1000);
        return () => clearInterval(id);
    }, []);

    // Seed each ribbon from history for the working day so far (re-runs on rollover).
    useEffect(() => {
        let cancelled = false;
        const params = new URLSearchParams();
        params.set('start', new Date(workingDay.dayStart).toISOString());
        params.set('stop', new Date().toISOString());
        params.set('metrics', TREND_DEFS.map((t) => t.metric).join(','));
        axios.get(`/api/history?${params.toString()}`, { timeout: LONG_TIMEOUT_MS })
            .then(({ data: rows }) => {
                if (cancelled || !Array.isArray(rows)) return;
                const seeded = Object.fromEntries(TREND_DEFS.map((t) => [t.id, []]));
                rows.forEach((row) => {
                    const t = Number(row.timestamp);
                    if (!Number.isFinite(t)) return;
                    TREND_DEFS.forEach((d) => {
                        const v = Number(row[d.metric]);
                        if (row[d.metric] != null && Number.isFinite(v)) seeded[d.id].push({ t, v });
                    });
                });
                // Keep live samples already captured after the seeded window.
                const cutoff = rows.length ? Number(rows[rows.length - 1].timestamp) : workingDay.dayStart;
                TREND_DEFS.forEach((d) => {
                    const liveTail = (histRef.current[d.id] || []).filter((p) => p.t > cutoff);
                    histRef.current[d.id] = seeded[d.id].concat(liveTail);
                });
                setTick((x) => x + 1);
            })
            .catch((e) => console.error('working-day history seed failed', e));
        return () => { cancelled = true; };
    }, [workingDay.dayStart]);

    useEffect(() => {
        axios.get('/api/rig/latest')
            .then(({ data }) => { if (data && Object.keys(data).length) { setRaw(data); setFeed((p) => ({ ...p, hasData: true, stale: !!data._meta?.stale })); pushHist(data); } })
            .catch((e) => console.error('rig/latest failed', e));
        axios.get('/api/alarms').then(({ data }) => setAlarms(Array.isArray(data?.active) ? data.active : [])).catch(() => {});
        axios.get(`/api/dashboard/layout?t=${Date.now()}`).then(({ data }) => { if (data?.wellInfo) setIdentity((p) => ({ ...p, ...data.wellInfo })); }).catch(() => {});
        const loadWell = () => axios.get('/api/wells/active').then(({ data }) => { if (data?.name) setIdentity((p) => ({ ...p, well: data.name })); }).catch(() => {});
        loadWell();
        const wellPoll = setInterval(loadWell, 5000);

        const onRig = (data) => {
            if (!data || !Object.keys(data).length) { setFeed((p) => ({ ...p, hasData: false })); return; }
            setRaw(data); setFeed((p) => ({ connected: socket.connected, hasData: true, stale: data._meta ? !!data._meta.stale : p.stale })); pushHist(data);
        };
        const onAlarms = (p) => setAlarms(Array.isArray(p?.active) ? p.active : []);
        const onConnect = () => setFeed((p) => ({ ...p, connected: true }));
        const onDisconnect = () => setFeed((p) => ({ ...p, connected: false }));
        socket.on('rig_data', onRig); socket.on('alarms', onAlarms); socket.on('connect', onConnect); socket.on('disconnect', onDisconnect);
        return () => { socket.off('rig_data', onRig); socket.off('alarms', onAlarms); socket.off('connect', onConnect); socket.off('disconnect', onDisconnect); clearInterval(wellPoll); };
    }, [pushHist]);

    const live = feed.connected && feed.hasData && !feed.stale;
    // Safety/derived value: never fabricate a number on a dead, stale, or absent signal.
    const sv = (v, d = 0) => (live && Number.isFinite(Number(v)) ? fmt(v, d) : '—');

    // ---- alarms ------------------------------------------------------------
    const sevOf = (p) => (p === 'P1' ? A.crit : p === 'P2' ? A.warn : p === 'P3' ? A.info : A.ok);
    const tagOf = (a) => { const dk = a.dataKey || ''; const head = dk.includes('.') ? dk.split('.')[0] : (a.id || ''); return (head || 'SYS').toUpperCase().slice(0, 12); };
    const annun = [...alarms]
        .sort((x, y) => (Date.parse(y.raisedAt) || 0) - (Date.parse(x.raisedAt) || 0))
        .map((a) => ({ id: a.id, time: hhmmss(a.raisedAt), tag: tagOf(a), msg: a.label || a.id, sevColor: sevOf(a.priority) }));
    const activeCount = alarms.filter((a) => (a.priority === 'P1' || a.priority === 'P2') && a.state !== 'ACK').length;
    const ticker = annun.length ? annun.concat(annun) : [];

    // ---- reads -------------------------------------------------------------
    const d = raw.drilling || {}, dw = raw.drawworks || {}, mp = raw.mudpump || {}, fl = raw.fluid || {};
    const hpu = raw.hpu || {}, htd = raw.htd || {}, pct = raw.pct || {}, cat = raw.cat_engine || {}, cwk = raw.cwk || {};
    const acs = raw.acs || {}, wc = raw.well_control || {}, sf = raw.safety || {}, wh = raw.wellhead || {};
    const eff = raw._efficiency || {}, kpi = raw._kpi || {}, act = raw._activity || {}, tt = raw._torqueturn || {};

    const esd = num(sf.esd_active) === 1 || num(sf.lockout_active) === 1;
    // Well-control values are only trustworthy when the backend says a BOP source exists.
    const wcLive = live && wc.available !== false;
    const wcv = (v, dp = 0) => (wcLive && Number.isFinite(Number(v)) ? fmt(v, dp) : '—');

    const blockMm = num(dw.block_position);
    const stringDepth = num(d.bit_depth);        // tubing/rod string depth on a workover rig
    const holeDepth = num(d.hole_depth);
    const acsCalibrated = num(acs.calibration_status) === 3;

    // ---- primary instruments (workover-relevant, real alarm setpoints) -----
    const A0 = -135, A1 = 135;
    const gaugeDefs = [
        { label: 'HOOK LOAD', unit: 't', dataKey: 'drawworks.hook_load', val: num(dw.hook_load), min: 0, max: 250, warn: 180, crit: 200, sub: ['BLOCK POS', sv(blockMm, 0), 'mm'], safety: true },
        { label: 'HTD ROTARY', unit: 'rpm', dataKey: 'htd.rpm', val: num(htd.rpm), min: 0, max: 180, warn: 150, crit: 170, sub: ['TORQUE', sv(htd.torque, 0), 'daN·m'] },
        { label: 'CIRC PRESS', unit: 'bar', dataKey: 'mudpump.pressure', val: num(mp.pressure), min: 0, max: 350, warn: 240, crit: 300, sub: ['RATE', sv(mp.spm, 1), 'spm'] },
    ];
    const gauges = gaugeDefs.map((g) => {
        const pct01 = clamp01((g.val - g.min) / (g.max - g.min));
        const ang = A0 + pct01 * 270;
        const ticks = [];
        for (let i = 0; i <= 40; i++) { const dd = A0 + (i / 40) * 270, major = i % 5 === 0; const o = polar(100, 100, 84, dd), inn = polar(100, 100, major ? 70 : 76, dd); ticks.push({ x1: o.x, y1: o.y, x2: inn.x, y2: inn.y, w: major ? 2 : 1, col: major ? c.txt2 : c.txt3 }); }
        const over = g.val >= g.crit, near = g.val >= g.warn;
        const alarm = alarmFor(g.dataKey);
        const valColor = alarm ? alarm.color : (!live ? c.txt3 : over ? A.crit : near ? A.warn : A.ok);
        return {
            ...g, ang, valColor, alarm,
            valueStr: sv(g.val, 0),
            trackPath: arc(100, 100, 84, A0, A1), valuePath: arc(100, 100, 84, A0, live ? ang : A0),
            warnPath: arc(100, 100, 93, A0 + clamp01((g.warn - g.min) / (g.max - g.min)) * 270, A0 + clamp01((g.crit - g.min) / (g.max - g.min)) * 270),
            critPath: arc(100, 100, 93, A0 + clamp01((g.crit - g.min) / (g.max - g.min)) * 270, A1),
            ticks, minStr: fmt(g.min), maxStr: fmt(g.max),
        };
    });

    const trends = TREND_DEFS.map((t) => ({
        ...t,
        valueStr: live ? fmt(t.get(raw), t.d) : '—',
        ...sparkDay(histRef.current[t.id], 100, 24, workingDay.dayStart, workingDay.dayEnd),
    }));
    const workingDayLabel = new Date(workingDay.dayStart).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

    // ---- equipment summary cards (mirror the equipment dashboards) ---------
    const filterOk = [1, 2, 3, 4, 5, 6, 7, 8].filter((i) => hpu[`oil_filter_${i}`] != null && num(hpu[`oil_filter_${i}`]) !== 0).length;
    const filterMapped = [1, 2, 3, 4, 5, 6, 7, 8].filter((i) => hpu[`oil_filter_${i}`] != null).length;
    const hpuClog = filterMapped > 0 && filterOk < filterMapped;
    const hpuStat = hpuClog ? { text: 'FILTER CLOG', color: '#fbbf24' } : S.onIdleOn(hpu.status);

    // Circulating pump has no status enum anywhere — derive it from the real alarm setpoints.
    const gl = Math.abs(num(fl.tank_gain_loss));
    const circStat = !live ? UNK
        : gl >= 3 ? { text: 'PIT ALARM', color: '#ef4444' }
            : gl >= 1.5 ? { text: 'GAIN/LOSS', color: '#fbbf24' }
                : num(mp.pressure) >= 300 ? { text: 'HIGH PRESS', color: '#ef4444' }
                    : num(mp.pressure) >= 240 ? { text: 'HIGH PRESS', color: '#fbbf24' }
                        : num(mp.spm) > 0 ? { text: 'CIRCULATING', color: '#4ade80' }
                            : { text: 'STOPPED', color: '#64748b' };

    const ramState = (closeFlag, openFlag) => (closeFlag ? 'CLOSED' : openFlag ? 'OPEN' : 'NO DATA');
    const rams = [
        { name: 'ANNULAR', state: wcLive ? ramState(wc.annular_close, wc.annular_open) : 'NO DATA' },
        { name: 'PIPE RAM', state: wcLive ? ramState(wc.pipe_ram_close, wc.pipe_ram_open) : 'NO DATA' },
        { name: 'BLIND RAM', state: wcLive ? ramState(wc.blind_ram_close, wc.blind_ram_open) : 'NO DATA' },
    ];
    const wcStat = !feed.connected ? { text: 'SOCKET DOWN', color: '#ef4444' }
        : wc.available === false ? { text: 'NO BOP SOURCE', color: '#ef4444' }
            : feed.stale ? { text: 'FEED STALE', color: '#fbbf24' }
                : esd ? { text: 'ESD ACTIVE', color: '#ef4444' }
                    : rams.some((r) => r.state === 'CLOSED') ? { text: 'CLOSED · MONITOR', color: '#fbbf24' }
                        : { text: 'NORMAL', color: '#4ade80' };

    const equipment = [
        {
            id: 'cat', label: 'CAT GENSET', side: 'l', color: A.info, route: '/equipment?tab=cat-engine', stat: S.engine(cat.status),
            params: [
                { k: 'LOAD', v: sv(cat.load, 0), u: '%' },
                { k: 'RPM', v: sv(cat.rpm, 0), u: '' },
                { k: 'COOLANT', v: sv(cat.coolant_temp, 0), u: '°C', dk: 'cat_engine.coolant_temp' },
                { k: 'OIL PRESS', v: sv(cat.oil_pressure, 1), u: 'bar', dk: 'cat_engine.oil_pressure' },
            ],
        },
        {
            id: 'hpu', label: 'HPU', side: 'l', color: A.ok, route: '/equipment?tab=hpu', stat: hpuStat,
            params: [
                { k: 'DISCHARGE', v: sv(hpu.discharge_pressure, 0), u: 'bar' },
                { k: 'OIL TEMP', v: sv(hpu.oil_temp, 1), u: '°C', dk: 'hpu.oil_temp' },
                { k: 'OIL LEVEL', v: sv(hpu.oil_level, 0), u: '%' },
                { k: 'FILTERS', v: live && filterMapped ? `${filterOk}/${filterMapped}` : '—', u: '' },
            ],
        },
        {
            id: 'htd', label: 'HTD TOP DRIVE', side: 'l', color: A.b2, route: '/equipment?tab=htd', stat: S.onIdleOn(htd.status),
            params: [
                { k: 'RPM', v: sv(htd.rpm, 0), u: '' },
                { k: 'TORQUE', v: sv(htd.torque, 0), u: 'daN·m' },
                { k: 'GEAR', v: live ? S.gear(htd.gear_status).text : '—', u: '' },
                { k: 'ELEVATOR', v: live ? S.elevator(htd.elevator_status).text : '—', u: '' },
            ],
        },
        {
            id: 'pct', label: 'PCT TONG', side: 'l', color: A.a2, route: '/equipment?tab=pct',
            stat: pct.sequence != null ? S.pctSeq(pct.sequence) : S.onIdleOn(pct.status),
            params: [
                { k: 'MAKE-UP', v: sv(pct.makeup_torque, 0), u: 'daN·m' },
                { k: 'LAST', v: sv(pct.last_makeup_torque, 0), u: 'daN·m' },
                { k: 'UP CLAMP', v: sv(pct.clamp_up_pressure, 1), u: 'bar' },
                { k: 'LOW CLAMP', v: sv(pct.clamp_low_pressure, 1), u: 'bar' },
            ],
        },
        {
            id: 'cwk', label: 'CATWALK', side: 'r', color: A.warn, route: '/equipment?tab=cwk', stat: S.cwkPark(cwk.status),
            params: [
                { k: 'CARRIER', v: live ? S.carrier(cwk.carrier_status).text : '—', u: '' },
                { k: 'CLAMP', v: live ? S.clamp(cwk.clamp_status).text : '—', u: '' },
                { k: 'CLAMP P', v: sv(cwk.clamp_pressure, 1), u: 'bar' },
                { k: 'CLAMP F', v: sv(cwk.clamp_force, 1), u: 'daN' },
            ],
        },
        {
            id: 'circ', label: 'CIRC PUMP', side: 'r', color: A.b1, route: '/equipment?tab=mud-pump', stat: circStat,
            params: [
                { k: 'PRESS', v: sv(mp.pressure, 0), u: 'bar', dk: 'mudpump.pressure' },
                { k: 'RATE', v: sv(mp.spm, 1), u: 'spm' },
                { k: 'TRIP TANK', v: sv(fl.trip_tank, 1), u: 'm³' },
                { k: 'GAIN/LOSS', v: sv(fl.tank_gain_loss, 2), u: 'm³', dk: 'fluid.tank_gain_loss' },
            ],
        },
        {
            id: 'acs', label: 'ACS ANTI-COLLISION', side: 'r', color: A.crit, route: '/equipment?tab=acs',
            stat: acsCalibrated ? S.acs(acs.status) : S.acsCal(acs.calibration_status),
            params: [
                { k: 'CROWNSAVER', v: sv(acs.crownsaver, 0), u: 'mm' },
                { k: 'FLOORSAVER', v: sv(acs.floorsaver, 0), u: 'mm' },
                { k: 'BOTTOMSAVER', v: sv(acs.bottomsaver, 0), u: 'mm' },
                { k: 'BLOCK POS', v: sv(blockMm, 0), u: 'mm' },
            ],
        },
        {
            id: 'wctl', label: 'WELL CONTROL', side: 'r', color: A.crit, route: '/wellcontrol', stat: wcStat,
            params: [
                { k: 'TUBING P', v: sv(wh.tubing_pressure, 1), u: 'bar', dk: 'wellhead.tubing_pressure' },
                { k: 'CASING P', v: sv(wh.casing_pressure, 1), u: 'bar', dk: 'wellhead.casing_pressure' },
                { k: 'ACCUM', v: wcv(wc.accumulator_pressure, 0), u: 'psi', dk: 'well_control.accumulator_pressure' },
                { k: 'ANNULAR', v: wcv(wc.annular_pressure, 0), u: 'psi' },
            ],
        },
    ];

    // ---- shared style fragments -------------------------------------------
    const card = { background: c.bg2, border: `1px solid ${c.line}`, borderRadius: 10 };
    const sectionLabel = { fontSize: 11, fontWeight: 700, letterSpacing: '.16em', color: c.txt2 };

    const Gauge = ({ g }) => (
        <div style={{ flex: 1, minWidth: 0, border: `1px solid ${g.alarm ? g.alarm.color : c.line}`, borderRadius: 9, background: c.bg3, padding: '10px 12px', animation: blinkAnim(g.alarm) }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', color: c.txt2 }}>{g.label}</span>
                {g.alarm
                    ? <span style={{ fontSize: 9, fontWeight: 800, color: g.alarm.color }}>{g.alarm.priority} · {g.alarm.condition}</span>
                    : <span style={{ fontSize: 9, fontWeight: 600, color: c.txt3 }}>{g.unit}</span>}
            </div>
            <div style={{ position: 'relative', width: 188, height: 150, margin: '6px auto 0' }}>
                <svg viewBox="0 0 200 200" width="188" height="188" style={{ position: 'absolute', top: -2, left: 0, overflow: 'visible' }}>
                    <path d={g.trackPath} fill="none" stroke={c.line2} strokeWidth="4" strokeLinecap="round" />
                    <path d={g.warnPath} fill="none" stroke={A.warn} strokeWidth="4" />
                    <path d={g.critPath} fill="none" stroke={A.crit} strokeWidth="4" strokeLinecap="round" />
                    {g.ticks.map((tk, i) => <line key={i} x1={tk.x1} y1={tk.y1} x2={tk.x2} y2={tk.y2} stroke={tk.col} strokeWidth={tk.w} />)}
                    <path d={g.valuePath} fill="none" stroke={g.valColor} strokeWidth="7" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 5px ${g.valColor})` }} />
                    {live && <g transform={`rotate(${g.ang.toFixed(2)} 100 100)`}><polygon points="100,30 96,104 104,104" fill={g.valColor} /></g>}
                    <circle cx="100" cy="100" r="9" fill={c.bg3} stroke={g.valColor} strokeWidth="3" />
                </svg>
                <span style={{ position: 'absolute', left: 22, bottom: 8, fontFamily: MONO, fontSize: 9, fontWeight: 600, color: c.txt3 }}>{g.minStr}</span>
                <span style={{ position: 'absolute', right: 22, bottom: 8, fontFamily: MONO, fontSize: 9, fontWeight: 600, color: c.txt3 }}>{g.maxStr}</span>
                <div style={{ position: 'absolute', left: 0, right: 0, top: 104, textAlign: 'center', fontFamily: MONO, fontSize: 28, fontWeight: 800, lineHeight: 1, color: g.valColor }}>{g.valueStr}</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 6, marginTop: 8, paddingTop: 8, borderTop: `1px solid ${c.line}` }}>
                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.08em', color: c.txt3 }}>{g.sub[0]}</span>
                <span style={{ fontFamily: MONO, fontSize: 17, fontWeight: 800, color: c.txt }}>{g.sub[1]}</span>
                <span style={{ fontSize: 9, color: c.txt3 }}>{g.sub[2]}</span>
            </div>
        </div>
    );

    // Equipment summary card — click-through to the full equipment page.
    const EquipCard = (e) => (
        <div
            key={e.id}
            onClick={() => navigate(e.route)}
            role="button" tabIndex={0}
            onKeyDown={(ev) => { if (ev.key === 'Enter' || ev.key === ' ') navigate(e.route); }}
            title={`Open ${e.label}`}
            style={{ background: c.bg3, border: `1px solid ${c.line}`, borderLeft: `3px solid ${e.color}`, borderRadius: 8, padding: '8px 10px', boxShadow: '0 4px 16px rgba(0,0,0,.18)', cursor: 'pointer' }}
        >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span style={{ fontSize: 10.5, fontWeight: 800, letterSpacing: '.04em', color: c.txt }}>{e.label}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: e.stat.color, boxShadow: `0 0 5px ${e.stat.color}` }} />
                    <span style={{ fontSize: 8, fontWeight: 700, color: e.stat.color }}>{e.stat.text}</span>
                </span>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 10px', marginTop: 7 }}>
                {e.params.map((p) => {
                    const pa = alarmFor(p.dk);
                    return (
                        <div key={p.k} style={{ minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 8, fontWeight: 700, letterSpacing: '.06em', color: pa ? pa.color : c.txt3 }}>
                                {pa && <span style={{ width: 5, height: 5, borderRadius: '50%', background: pa.color, boxShadow: `0 0 5px ${pa.color}`, animation: blinkAnim(pa) }} />}
                                {p.k}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 2, marginTop: 2, animation: blinkAnim(pa) }}>
                                <span style={{ fontFamily: MONO, fontSize: 15, fontWeight: 800, lineHeight: 1, color: pa ? pa.color : e.color, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.v}</span>
                                {p.u && <span style={{ fontSize: 8, fontWeight: 600, color: c.txt3 }}>{p.u}</span>}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );

    // ---- workover mast geometry (drawing only; mast travel is CONFIGURED) ------
    const blockPct = clamp01((blockMm - MAST_BLOCK_MIN_MM) / (MAST_BLOCK_MAX_MM - MAST_BLOCK_MIN_MM));
    const blockY = 98 - blockPct * 80;           // 98 = floor end of travel, 18 = crown end
    const htdStat = S.onIdleOn(htd.status);
    const elevStat = S.elevator(htd.elevator_status);
    const pctSeqStat = pct.sequence != null ? S.pctSeq(pct.sequence) : UNK;
    const cwkWorking = num(cwk.carrier_status) === 3;

    return (
        <div style={{ background: c.bg, color: c.txt, fontFamily: SANS, minHeight: '100%', margin: -24, display: 'flex', flexDirection: 'column' }}>
            <style>{`@keyframes annScroll{0%{transform:translateY(0)}100%{transform:translateY(-50%)}}@keyframes pulseDot{0%,100%{opacity:1}50%{opacity:.2}}`}</style>

            {/* Brand / rig / well / activity / LIVE all live in the app top bar (Layout.jsx). */}

            {/* ---- annunciator ticker ---- */}
            <div onClick={() => navigate('/alarms')} role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/alarms'); }}
                style={{ cursor: 'pointer', display: 'flex', alignItems: 'stretch', borderBottom: `1px solid ${c.line}`, background: c.bg2 }}>
                <div style={{ flex: 'none', width: 158, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, padding: '8px 16px', borderRight: `1px solid ${c.line}`, background: c.bg3 }}>
                    <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', color: A.warn }}>ANNUNCIATOR</span>
                    <span style={{ fontSize: 10, fontWeight: 600, color: c.txt3 }}>{activeCount} active · view all →</span>
                </div>
                <div style={{ flex: 1, minWidth: 0, height: 56, overflow: 'hidden', position: 'relative' }}>
                    {ticker.length ? (
                        <div style={{ animation: 'annScroll 22s linear infinite' }}>
                            {ticker.map((a, i) => (
                                <div key={`${a.id}-${i}`} style={{ height: 28, display: 'flex', alignItems: 'center', gap: 11, padding: '0 16px', borderBottom: `1px solid ${c.line}` }}>
                                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: a.sevColor, flex: 'none', boxShadow: `0 0 6px ${a.sevColor}` }} />
                                    <span style={{ fontFamily: MONO, fontSize: 11, color: c.txt3, flex: 'none' }}>{a.time}</span>
                                    <span style={{ fontFamily: MONO, fontSize: 11, fontWeight: 700, color: a.sevColor, flex: 'none', width: 96 }}>{a.tag}</span>
                                    <span style={{ fontSize: 12, color: c.txt2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.msg}</span>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <div style={{ height: '100%', display: 'flex', alignItems: 'center', padding: '0 16px', gap: 10 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: A.ok }} />
                            <span style={{ fontSize: 12, color: c.txt2, fontWeight: 600 }}>No active alarms</span>
                        </div>
                    )}
                </div>
            </div>

            {/* ---- body ---- */}
            <div style={{ display: 'flex', gap: 16, padding: 16, alignItems: 'stretch', flexWrap: 'wrap' }}>

                {/* STRING & ACTIVITY */}
                <div style={{ flex: '0 0 240px', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', ...card, padding: 12 }}>
                        <span style={{ ...sectionLabel, marginBottom: 10 }}>STRING &amp; ACTIVITY</span>

                        {/* Current workover activity (server-detected) */}
                        <div onClick={() => navigate('/activity')} role="button" tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/activity'); }}
                            title="Open activity log"
                            style={{ cursor: 'pointer', border: `1px solid ${c.line}`, borderRadius: 8, padding: '10px 11px', background: c.bg3, marginBottom: 10 }}>
                            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.12em', color: c.txt3 }}>CURRENT ACTIVITY</div>
                            <div style={{ fontSize: 17, fontWeight: 800, letterSpacing: '.02em', marginTop: 3, color: live ? (ACT_COLOR[act.code] || c.txt) : c.txt3 }}>
                                {live ? (act.label || act.code || 'UNKNOWN').toUpperCase() : 'NO DATA'}
                            </div>
                            <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                                {act.npt ? <span style={{ fontSize: 8, fontWeight: 800, color: A.crit, border: `1px solid ${A.crit}`, borderRadius: 4, padding: '1px 5px' }}>NPT · {String(act.npt).toUpperCase()}</span> : null}
                                {act.productive === false && !act.npt ? <span style={{ fontSize: 8, fontWeight: 800, color: A.warn }}>NON-PRODUCTIVE</span> : null}
                                {act.source ? <span style={{ fontSize: 8, color: c.txt3 }}>{act.source}</span> : null}
                            </div>
                        </div>

                        {/* String depth vs total depth */}
                        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                            <div style={{ flex: 1, border: `1px solid ${c.line}`, borderRadius: 7, padding: '8px 9px', background: c.bg2 }}>
                                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em', color: c.txt3 }}>STRING</div>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}><span style={{ fontFamily: MONO, fontSize: 20, fontWeight: 800, lineHeight: 1, color: A.a1 }}>{sv(stringDepth, 0)}</span><span style={{ fontSize: 9, color: c.txt3 }}>m</span></div>
                            </div>
                            <div style={{ flex: 1, border: `1px solid ${c.line}`, borderRadius: 7, padding: '8px 9px', background: c.bg2 }}>
                                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em', color: c.txt3 }}>TOTAL</div>
                                <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}><span style={{ fontFamily: MONO, fontSize: 20, fontWeight: 800, lineHeight: 1, color: c.txt }}>{sv(holeDepth, 0)}</span><span style={{ fontSize: 9, color: c.txt3 }}>m</span></div>
                            </div>
                        </div>

                        {/* Pipe / tubing depth track — vertical section of the well
                            showing how much string is in the hole right now. */}
                        <div style={{ position: 'relative', flex: 1, minHeight: 210, marginBottom: 12, border: `1px solid ${c.line}`, borderRadius: 8, background: c.bg3, overflow: 'hidden' }}>
                            {(() => {
                                const scaleTd = Math.max(holeDepth, stringDepth, 1);
                                const pipePct = clamp01(stringDepth / scaleTd) * 100;
                                const holePct = clamp01(holeDepth / scaleTd) * 100;
                                // Depth gridlines every 25% of the well.
                                const grid = [0.25, 0.5, 0.75].map((f) => ({ f, d: scaleTd * f }));
                                return (
                                    <>
                                        {/* casing / open hole */}
                                        <div style={{ position: 'absolute', left: '50%', top: 0, height: `${holePct}%`, width: 26, transform: 'translateX(-50%)', background: `${A.info}14`, borderLeft: `2px solid ${A.info}66`, borderRight: `2px solid ${A.info}66` }} />
                                        {/* depth gridlines */}
                                        {grid.map((g) => (
                                            <div key={g.f} style={{ position: 'absolute', left: 0, right: 0, top: `${g.f * 100}%`, borderTop: `1px dashed ${c.line}` }}>
                                                <span style={{ position: 'absolute', right: 3, top: 1, fontFamily: MONO, fontSize: 7.5, color: c.txt3 }}>{Math.round(g.d)}m</span>
                                            </div>
                                        ))}
                                        {/* the pipe/tubing string in the hole */}
                                        <div style={{ position: 'absolute', left: '50%', top: 0, height: live ? `${pipePct}%` : 0, width: 7, transform: 'translateX(-50%)', background: `linear-gradient(180deg, ${A.a1}, ${A.a1}bb)`, borderRadius: '0 0 2px 2px', transition: 'height .8s linear' }} />
                                        {/* string shoe / end-of-pipe marker */}
                                        {live && (
                                            <div style={{ position: 'absolute', left: 0, right: 0, top: `${pipePct}%`, transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', gap: 4, padding: '0 4px', transition: 'top .8s linear' }}>
                                                <span style={{ flex: 1, height: 2, background: A.a1, boxShadow: `0 0 8px ${A.a1}` }} />
                                                <span style={{ width: 10, height: 10, borderRadius: '50%', background: A.a1, boxShadow: `0 0 10px ${A.a1}`, flex: 'none' }} />
                                            </div>
                                        )}
                                        {/* labels */}
                                        <span style={{ position: 'absolute', left: 5, top: 4, fontFamily: MONO, fontSize: 8, fontWeight: 700, color: c.txt3 }}>SURFACE 0m</span>
                                        <span style={{ position: 'absolute', left: 5, top: `${pipePct}%`, transform: 'translateY(-50%) translateY(-11px)', fontFamily: MONO, fontSize: 9.5, fontWeight: 800, color: A.a1 }}>
                                            PIPE {sv(stringDepth, 0)}m
                                        </span>
                                        <div style={{ position: 'absolute', left: 0, right: 0, top: `${holePct}%`, transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', padding: '0 4px' }}>
                                            <span style={{ flex: 1, height: 1, background: A.info, opacity: 0.65 }} />
                                        </div>
                                        <span style={{ position: 'absolute', left: 5, top: `${holePct}%`, transform: 'translateY(-50%) translateY(9px)', fontFamily: MONO, fontSize: 8, fontWeight: 700, color: A.info }}>
                                            TD {sv(holeDepth, 0)}m
                                        </span>
                                    </>
                                );
                            })()}
                        </div>

                        {/* Connections (torque-turn) */}
                        <div onClick={() => navigate('/workover')} role="button" tabIndex={0}
                            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/workover'); }}
                            title="Open workover / connections"
                            style={{ cursor: 'pointer', border: `1px solid ${c.line}`, borderRadius: 8, padding: '9px 10px', background: c.bg2, marginBottom: 10 }}>
                            <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.12em', color: c.txt3, marginBottom: 5 }}>CONNECTIONS</div>
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 8px' }}>
                                <div>
                                    <div style={{ fontSize: 8, fontWeight: 700, color: c.txt3 }}>TORQUE-TURN</div>
                                    <div style={{ fontFamily: MONO, fontSize: 14, fontWeight: 800, color: tt.active ? A.ok : c.txt3 }}>{tt.active ? 'ACTIVE' : 'IDLE'}</div>
                                </div>
                                <div>
                                    <div style={{ fontSize: 8, fontWeight: 700, color: c.txt3 }}>LAST MAKE-UP</div>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
                                        <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 800, color: A.b1 }}>{sv(pct.last_makeup_torque, 0)}</span>
                                        <span style={{ fontSize: 8, color: c.txt3 }}>daN·m</span>
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* ACS travel clearances — raw mm, deliberately NOT threshold-coloured */}
                        <div style={{ border: `1px solid ${c.line}`, borderRadius: 8, padding: '9px 10px', background: c.bg2 }}>
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                                <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.12em', color: c.txt3 }}>ACS CLEARANCE</span>
                                {!acsCalibrated && <span style={{ fontSize: 8, fontWeight: 800, color: A.warn }}>NOT CALIBRATED</span>}
                            </div>
                            {[['CROWN', acs.crownsaver], ['FLOOR', acs.floorsaver], ['BOTTOM', acs.bottomsaver]].map(([k, v]) => (
                                <div key={k} style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 6, marginTop: 3, opacity: acsCalibrated ? 1 : 0.55 }}>
                                    <span style={{ fontSize: 9, fontWeight: 700, color: c.txt2 }}>{k}</span>
                                    <span><span style={{ fontFamily: MONO, fontSize: 13, fontWeight: 800, color: c.txt }}>{sv(v, 0)}</span><span style={{ fontSize: 8, color: c.txt3 }}> mm</span></span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* RIG FLOOR & EQUIPMENT */}
                <div style={{ flex: '1 1 560px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', ...card, overflow: 'hidden' }}>
                        <span style={{ ...sectionLabel, padding: '12px 13px 2px' }}>WORKOVER RIG &amp; EQUIPMENT</span>
                        <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 560, padding: '8px 12px 12px', alignItems: 'stretch' }}>
                            {/* Left equipment column */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: '0 0 176px', minWidth: 0 }}>
                                {equipment.filter((e) => e.side === 'l').map(EquipCard)}
                            </div>

                            {/* Centre: telescoping guyed workover mast */}
                            <div style={{ position: 'relative', flex: '1 1 0', minWidth: 140 }}>
                                <svg viewBox="0 0 100 150" preserveAspectRatio="xMidYMid meet" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                                    {/* ground + rig floor + substructure */}
                                    <line x1="6" y1="118" x2="94" y2="118" stroke={c.line2} strokeWidth="0.9" />
                                    <polygon points="37,108 63,108 60,118 40,118" fill={c.bg3} stroke={c.line2} strokeWidth="0.6" />
                                    <rect x="34" y="103" width="32" height="5" rx="0.6" fill={c.bg3} stroke={c.line2} strokeWidth="0.7" />

                                    {/* guy lines + ground anchors (guyed mast, not a lattice derrick) */}
                                    <line x1="46.5" y1="46" x2="15" y2="118" stroke={c.line} strokeWidth="0.45" strokeDasharray="2 1.5" />
                                    <line x1="53.5" y1="46" x2="85" y2="118" stroke={c.line} strokeWidth="0.45" strokeDasharray="2 1.5" />
                                    <polygon points="13,118 17,118 15,114.5" fill={c.line2} />
                                    <polygon points="83,118 87,118 85,114.5" fill={c.line2} />

                                    {/* mast: outer (lower) section */}
                                    <line x1="41" y1="103" x2="44.5" y2="60" stroke={c.line2} strokeWidth="1.5" />
                                    <line x1="59" y1="103" x2="55.5" y2="60" stroke={c.line2} strokeWidth="1.5" />
                                    {/* telescoping splice */}
                                    <rect x="43" y="56.5" width="14" height="3.5" rx="0.6" fill={c.bg3} stroke={c.txt3} strokeWidth="0.6" />
                                    <text x="58.5" y="59.4" fontSize="2.2" fill={c.txt3} fontFamily={MONO}>TELESCOPING</text>
                                    {/* mast: inner (upper) section */}
                                    <line x1="45.5" y1="56.5" x2="47" y2="15" stroke={c.line2} strokeWidth="1.1" />
                                    <line x1="54.5" y1="56.5" x2="53" y2="15" stroke={c.line2} strokeWidth="1.1" />

                                    {/* crown block */}
                                    <rect x="43" y="9.5" width="14" height="5.5" rx="1" fill={c.bg3} stroke={c.txt3} strokeWidth="0.7" />
                                    <circle cx="46.8" cy="12.2" r="1.1" fill={c.txt3} />
                                    <circle cx="53.2" cy="12.2" r="1.1" fill={c.txt3} />
                                    <text x="41.5" y="13" fontSize="2.3" textAnchor="end" fill={c.txt3} fontFamily={MONO}>CROWN</text>

                                    {/* drilling line to travelling block */}
                                    <line x1="47.5" y1="15" x2="47.5" y2={blockY.toFixed(1)} stroke={A.a1} strokeWidth="0.45" opacity="0.85" />
                                    <line x1="52.5" y1="15" x2="52.5" y2={blockY.toFixed(1)} stroke={A.a1} strokeWidth="0.45" opacity="0.85" />

                                    {/* travelling block */}
                                    <rect x="44" y={blockY.toFixed(1)} width="12" height="4.6" rx="1" fill={live ? A.a1 : c.line2} />
                                    <text x="42.5" y={(blockY + 3.4).toFixed(1)} fontSize="2.6" fontWeight="800" textAnchor="end" fill={A.a1} fontFamily={MONO}>{live ? `${fmt(blockMm, 0)} mm` : '--'}</text>

                                    {/* hydraulic top drive (HTD) hanging under the block */}
                                    <rect x="45" y={(blockY + 5).toFixed(1)} width="10" height="6.5" rx="0.8" fill={c.bg3} stroke={htdStat.color} strokeWidth="0.8" />
                                    <text x="50" y={(blockY + 9.2).toFixed(1)} fontSize="2.2" textAnchor="middle" fontWeight="700" fill={htdStat.color} fontFamily={MONO}>HTD</text>
                                    {/* elevator links + elevator */}
                                    <line x1="46.5" y1={(blockY + 11.5).toFixed(1)} x2="46.5" y2={(blockY + 15).toFixed(1)} stroke={c.txt3} strokeWidth="0.5" />
                                    <line x1="53.5" y1={(blockY + 11.5).toFixed(1)} x2="53.5" y2={(blockY + 15).toFixed(1)} stroke={c.txt3} strokeWidth="0.5" />
                                    <rect x="45.8" y={(blockY + 15).toFixed(1)} width="8.4" height="2.6" rx="0.5" fill="transparent" stroke={elevStat.color} strokeWidth="0.7" />

                                    {/* tubing string from elevator down through the floor */}
                                    <line x1="50" y1={(blockY + 17.6).toFixed(1)} x2="50" y2="118" stroke={A.a2} strokeWidth="0.8" opacity="0.8" />

                                    {/* PCT power tong at floor level */}
                                    <rect x="43.5" y="110.5" width="13" height="5" rx="0.8" fill={c.bg3} stroke={pctSeqStat.color} strokeWidth="0.8" />
                                    <text x="50" y="113.9" fontSize="2.2" textAnchor="middle" fontWeight="700" fill={pctSeqStat.color} fontFamily={MONO}>PCT</text>

                                    {/* catwalk ramp entering the floor from the left */}
                                    <polygon points="8,116 34,108 34,111 12,118" fill={c.bg3} stroke={cwkWorking ? A.warn : c.line2} strokeWidth="0.6" />
                                    <text x="12" y="114.5" fontSize="2.1" fill={cwkWorking ? A.warn : c.txt3} fontFamily={MONO}>CATWALK</text>

                                    {/* wellhead: casing head + tubing head + wing valves */}
                                    <rect x="44" y="118" width="12" height="4.4" rx="0.6" fill={c.bg3} stroke={c.line2} strokeWidth="0.8" />
                                    <text x="57.5" y="121.4" fontSize="2.1" fill={c.txt3} fontFamily={MONO}>TUBING HEAD</text>
                                    <rect x="42.5" y="122.4" width="15" height="4.6" rx="0.6" fill={c.bg3} stroke={c.line2} strokeWidth="0.8" />
                                    <text x="59" y="125.8" fontSize="2.1" fill={c.txt3} fontFamily={MONO}>CASING HEAD</text>
                                    {/* wing valves */}
                                    <rect x="38.5" y="123.2" width="4" height="3" fill={c.bg3} stroke={c.line2} strokeWidth="0.6" />
                                    <rect x="57.5" y="123.2" width="4" height="3" fill={c.bg3} stroke={c.line2} strokeWidth="0.6" />
                                    <text x="50" y="131" fontSize="2.2" textAnchor="middle" fontWeight="700" fill={c.txt2} fontFamily={MONO}>
                                        TBG {wh.tubing_pressure != null && live ? `${fmt(wh.tubing_pressure, 0)}` : '--'} / CSG {wh.casing_pressure != null && live ? `${fmt(wh.casing_pressure, 0)}` : '--'} bar
                                    </text>

                                    {/* BOP / annular — only drawn when a real source exists */}
                                    {wcLive ? (
                                        <>
                                            <rect x="43" y="133" width="14" height="4.6" rx="2" fill={rams[0].state === 'CLOSED' ? A.crit : 'transparent'} stroke={c.line2} strokeWidth="0.8" />
                                            <text x="50" y="136.3" fontSize="2" textAnchor="middle" fontWeight="700" fill={c.txt} fontFamily={MONO}>ANNULAR</text>
                                            <rect x="44" y="138" width="12" height="4.2" rx="0.8" fill={rams[1].state === 'CLOSED' ? A.crit : 'transparent'} stroke={c.line2} strokeWidth="0.8" />
                                            <text x="50" y="141" fontSize="1.9" textAnchor="middle" fontWeight="700" fill={c.txt} fontFamily={MONO}>PIPE</text>
                                        </>
                                    ) : (
                                        <>
                                            <rect x="43" y="133" width="14" height="9.2" rx="1" fill="none" stroke={c.line2} strokeWidth="0.7" strokeDasharray="1.5 1.5" />
                                            <text x="50" y="138.6" fontSize="2" textAnchor="middle" fontWeight="700" fill={c.txt3} fontFamily={MONO}>NO BOP SOURCE</text>
                                        </>
                                    )}
                                </svg>
                                <div style={{ position: 'absolute', left: '50%', bottom: 2, transform: 'translateX(-50%)', textAlign: 'center', pointerEvents: 'none' }}>
                                    <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '.2em', color: c.txt3, opacity: .5 }}>WORKOVER MAST · ACS ENVELOPE</div>
                                </div>
                            </div>

                            {/* Right equipment column */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: '0 0 176px', minWidth: 0 }}>
                                {equipment.filter((e) => e.side === 'r').map(EquipCard)}
                            </div>
                        </div>
                    </div>

                    {/* Well-control bar */}
                    <div onClick={() => navigate('/wellcontrol')} role="button" tabIndex={0}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/wellcontrol'); }}
                        title="Open well control"
                        style={{ marginTop: 14, ...card, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap', cursor: 'pointer' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: wcStat.color, boxShadow: `0 0 6px ${wcStat.color}` }} />
                            <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.1em', color: c.txt }}>WELL CONTROL</span>
                            <span style={{ fontSize: 10, fontWeight: 700, color: wcStat.color }}>{wcStat.text}</span>
                        </span>
                        <span style={{ width: 1, height: 26, background: c.line2 }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
                            {[
                                { k: 'ACCUM', v: wcv(wc.accumulator_pressure, 0), u: 'psi', dk: 'well_control.accumulator_pressure' },
                                { k: 'ANNULAR', v: wcv(wc.annular_pressure, 0), u: 'psi' },
                                { k: 'MANIFOLD', v: wcv(wc.manifold_pressure, 0), u: 'psi' },
                                { k: 'TUBING', v: sv(wh.tubing_pressure, 1), u: 'bar', dk: 'wellhead.tubing_pressure' },
                                { k: 'CASING', v: sv(wh.casing_pressure, 1), u: 'bar', dk: 'wellhead.casing_pressure' },
                            ].map((p) => {
                                const pa = alarmFor(p.dk);
                                return (
                                    <span key={p.k} style={{ display: 'flex', flexDirection: 'column', gap: 2, animation: blinkAnim(pa) }}>
                                        <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.1em', color: pa ? pa.color : c.txt3 }}>{p.k}{pa ? ` · ${pa.condition}` : ''}</span>
                                        <span style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
                                            <span style={{ fontFamily: MONO, fontSize: 17, fontWeight: 800, lineHeight: 1, color: pa ? pa.color : A.info }}>{p.v}</span>
                                            <span style={{ fontSize: 8, color: c.txt3 }}>{p.u}</span>
                                        </span>
                                    </span>
                                );
                            })}
                        </div>
                        <span style={{ width: 1, height: 26, background: c.line2 }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                            {rams.map((r) => {
                                const col = r.state === 'CLOSED' ? A.crit : r.state === 'OPEN' ? '#7c8aa0' : c.txt3;
                                return (
                                    <span key={r.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 6, background: c.bg3, border: `1px solid ${c.line}` }}>
                                        <span style={{ width: 6, height: 6, borderRadius: '50%', background: col, boxShadow: `0 0 5px ${col}` }} />
                                        <span style={{ fontSize: 9, fontWeight: 700, color: c.txt2 }}>{r.name}</span>
                                        <span style={{ fontSize: 9, fontWeight: 800, color: col }}>{r.state}</span>
                                    </span>
                                );
                            })}
                        </div>
                    </div>
                </div>

                {/* PRIMARY INSTRUMENTS + TRENDS */}
                <div style={{ flex: '1 1 560px', display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
                    <div style={{ ...card, padding: '13px 14px' }}>
                        <span style={sectionLabel}>PRIMARY INSTRUMENTS</span>
                        <div style={{ display: 'flex', gap: 12, marginTop: 11, flexWrap: 'wrap' }}>
                            {gauges.map((g) => <Gauge key={g.label} g={g} />)}
                        </div>
                    </div>

                    <div style={{ ...card, padding: '13px 14px', flex: 1 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 11 }}>
                            <span style={sectionLabel}>WORKING-DAY TRENDS</span>
                            <span style={{ flex: 1, height: 1, background: c.line }} />
                            <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 600, color: c.txt3, whiteSpace: 'nowrap' }}>
                                06:00 → 06:00 IST · {workingDayLabel}
                            </span>
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {trends.map((t) => (
                                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                                    <span style={{ width: 84, flex: 'none', fontSize: 9, fontWeight: 700, letterSpacing: '.06em', color: c.txt2 }}>{t.label}</span>
                                    <div style={{ flex: 1, height: 28, minWidth: 0, borderLeft: `1px solid ${c.line}`, borderRight: `1px solid ${c.line}` }}>
                                        <svg viewBox="0 0 100 24" width="100%" height="100%" preserveAspectRatio="none">
                                            {/* tour midpoint (18:00 IST) for orientation */}
                                            <line x1="50" y1="0" x2="50" y2="24" stroke={c.line} strokeWidth="0.5" />
                                            <path d={t.area} fill={t.color} opacity="0.16" />
                                            <path d={t.line} fill="none" stroke={t.color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                                        </svg>
                                    </div>
                                    <span style={{ width: 62, flex: 'none', textAlign: 'right', fontFamily: MONO, fontSize: 14, fontWeight: 800, color: t.color }}>{t.valueStr}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}
