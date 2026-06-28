import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useTheme } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { socket } from '../../socket';
import axios from '../../api';
import { useAlarms, ALARM_BLINK } from '../../context/AlarmContext';
import { priorityColor } from '../../utils/alarms';

// ===========================================================================
// RigConsoleOverview — "DrillBit Twin"-style professional rig overview.
//
// Faithful to the reference mock (branded header · annunciator ticker ·
// trip-stat wellbore · rig-floor schematic with 8 equipment cards · crown/
// floor-saver derrick · 4-pressure BOP bar · 3 primary gauges · working-day
// trend ribbons), but wired entirely to THIS app's live feed:
//   live values -> socket 'rig_data' (+ /api/rig/latest), incl. backend-
//                  computed `_efficiency` / `_activity` blocks
//   alarms      -> socket 'alarms'   (+ /api/alarms)
//   rig/well    -> /api/dashboard/layout (wellInfo) + /api/wells/active
//
// Safety rule (repo README): safety-critical signals (BOP pressures, WOB,
// depth) are never fabricated — they read "—" on a stale/dead feed (`sv()`).
// Metrics with no sensor in this feed (H2S / LEL gas) are NOT invented; the
// WELL CONTROL card surfaces real wellhead pressures + computed kick/loss
// confidence instead. Derived KPIs (MSE, ECD, annular velocity, CO₂,
// overpull) are computed from real telemetry with documented formulas.
// ===========================================================================

const DARK = { bg: '#0a0d14', bg2: '#10141f', bg3: '#070a10', line: '#1f2736', line2: '#2c3648', txt: '#e9eef7', txt2: '#8593a9', txt3: '#525d72' };
const LIGHT = { bg: '#eef1f6', bg2: '#ffffff', bg3: '#f4f7fb', line: '#dce2ec', line2: '#c6cedb', txt: '#0d1320', txt2: '#4b566a', txt3: '#8a96aa' };
const ACCENT = { a1: '#ff9d2e', a2: '#27cfe6', b1: '#a9ef34', b2: '#9a8bff', ok: '#23dd86', warn: '#ffc24b', crit: '#ff4a60', info: '#46a6ff' };

const MONO = "'JetBrains Mono', ui-monospace, monospace";
const SANS = "'Space Grotesk', -apple-system, BlinkMacSystemFont, sans-serif";

// Derived KPIs (MSE, ECD, annular velocity, etc.) are computed SERVER-SIDE and
// arrive on raw._kpi — this component only consumes them.
const PSI_PER_BAR = 14.5038;             // SPP gauge fallback only
const CROWN_LIMIT_M = 38;                // travel envelope (crown-saver)
const FLOOR_LIMIT_M = 2.5;               // travel envelope (floor-saver)
const MAST_MAX_M = 50;

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

const spark = (arrIn, w, h) => {
    const a = (arrIn && arrIn.length > 1) ? arrIn : [0, 0];
    const min = Math.min(...a), max = Math.max(...a), rng = (max - min) || 1;
    const pts = a.map((v, i) => [(i / (a.length - 1)) * w, h - ((v - min) / rng) * (h - 3) - 1.5]);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
    return { line, area: line + ' L ' + w + ' ' + h + ' L 0 ' + h + ' Z' };
};

const opModeLabel = (code) => ({ 1: 'DRILLING', 2: 'TRIP IN', 3: 'TRIP OUT', 4: 'CASING' }[Number(code)] || 'IDLE');
const hhmmss = (iso) => { const d = iso ? new Date(iso) : null; return (!d || isNaN(d.getTime())) ? '--:--:--' : d.toLocaleTimeString('en-GB', { hour12: false }); };

const TREND_DEFS = [
    { id: 'hookLoad', label: 'HOOK LOAD', unit: 't', color: ACCENT.a1, d: 0, get: (r) => num(r.drawworks?.hook_load) },
    { id: 'rpm', label: 'ROTARY RPM', unit: 'rpm', color: ACCENT.a2, d: 0, get: (r) => num(r.drilling?.rpm) },
    { id: 'rop', label: 'ROP', unit: 'm/h', color: ACCENT.ok, d: 1, get: (r) => num(r.drilling?.rop) },
    { id: 'wob', label: 'WOB', unit: 't', color: ACCENT.b1, d: 1, get: (r) => num(r.drilling?.wob) },
    { id: 'torque', label: 'TORQUE', unit: 'kN·m', color: ACCENT.b2, d: 1, get: (r) => num(r.htd?.torque) / 100 },
    { id: 'genLoad', label: 'GENSET LOAD', unit: '%', color: ACCENT.warn, d: 0, get: (r) => num(r.cat_engine?.load) },
    { id: 'flowOut', label: 'FLOW RET', unit: '%', color: ACCENT.info, d: 0, get: (r) => num(r.mudpump?.flow_out) },
];
const TREND_MAX = 60;

export default function RigConsoleOverview() {
    const muiTheme = useTheme();
    const navigate = useNavigate();
    const isDark = muiTheme.palette.mode !== 'light';   // follows the global theme switcher
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
    const [identity, setIdentity] = useState({ rig: 'RIG-ALPHA', well: 'WELL-001' });
    const [feed, setFeed] = useState({ connected: socket.connected, stale: false, hasData: false });
    const histRef = useRef(Object.fromEntries(TREND_DEFS.map((t) => [t.id, []])));
    const [, setTick] = useState(0);

    const pushHist = useCallback((data) => {
        const h = histRef.current;
        TREND_DEFS.forEach((t) => { const arr = h[t.id]; arr.push(t.get(data)); if (arr.length > TREND_MAX) arr.shift(); });
        setTick((x) => x + 1);
    }, []);

    useEffect(() => {
        axios.get('/api/rig/latest')
            .then(({ data }) => { if (data && Object.keys(data).length) { setRaw(data); setFeed((p) => ({ ...p, hasData: true, stale: !!data._meta?.stale })); pushHist(data); } })
            .catch((e) => console.error('rig/latest failed', e));
        axios.get('/api/alarms').then(({ data }) => setAlarms(Array.isArray(data?.active) ? data.active : [])).catch(() => {});
        // rig/well identity (mirror Layout): dashboard wellInfo + active well registry
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
    const sv = (v, d = 0) => (live ? fmt(v, d) : '—');

    // ---- alarms ------------------------------------------------------------
    const sevOf = (p) => (p === 'P1' ? A.crit : p === 'P2' ? A.warn : p === 'P3' ? A.info : A.ok);
    const tagOf = (a) => { const dk = a.dataKey || ''; const head = dk.includes('.') ? dk.split('.')[0] : (a.id || ''); return (head || 'SYS').toUpperCase().slice(0, 12); };
    const annun = useMemo(() => [...alarms]
        .sort((x, y) => (Date.parse(y.raisedAt) || 0) - (Date.parse(x.raisedAt) || 0))
        .map((a) => ({ id: a.id, time: hhmmss(a.raisedAt), tag: tagOf(a), msg: a.label || a.id, sevColor: sevOf(a.priority) })), [alarms]);
    const activeCount = alarms.filter((a) => (a.priority === 'P1' || a.priority === 'P2') && a.state !== 'ACK').length;
    const ticker = annun.length ? annun.concat(annun) : [];

    // ---- scalar reads ------------------------------------------------------
    const d = raw.drilling || {}, dw = raw.drawworks || {}, mp = raw.mudpump || {}, fl = raw.fluid || {};
    const hpu = raw.hpu || {}, htd = raw.htd || {}, pct = raw.pct || {}, cat = raw.cat_engine || {}, cwk = raw.cwk || {};
    const wc = raw.well_control || {}, sf = raw.safety || {}, wh = raw.wellhead || {}, eff = raw._efficiency || {}, act = raw._activity || {};

    const bitDepth = num(d.bit_depth), holeDepth = num(d.hole_depth);
    const td = Math.max(200, Math.ceil((Math.max(holeDepth, bitDepth) * 1.06) / 100) * 100);

    // ---- derived KPIs: computed SERVER-SIDE (raw._kpi); client only consumes ----
    const kpi = raw._kpi || {};
    const mse = num(kpi.mse);
    const annVel = num(kpi.ann_velocity);
    const ecd = num(kpi.ecd);
    const sppPsi = num(kpi.spp_psi) || (num(mp.pressure) * PSI_PER_BAR);
    const sppDev = num(kpi.spp_dev_pct);
    const tRatio = num(kpi.transport_ratio);
    const co2 = num(kpi.co2_kgph);
    const powerKw = num(kpi.power_kw);
    const driveEff = num(kpi.drive_eff_pct);
    const overpull = num(kpi.overpull);
    const friction = num(kpi.friction);
    const kickConf = num(kpi.kick_confidence);
    const lossConf = num(kpi.loss_confidence);

    // ---- gauges (3 across) -------------------------------------------------
    const A0 = -135, A1 = 135;
    const gaugeDefs = [
        { label: 'HOOK LOAD', unit: 't', dataKey: 'drawworks.hook_load', val: num(dw.hook_load), min: 0, max: 250, warn: 200, crit: 230, sub: ['WEIGHT ON BIT', sv(d.wob, 1), 't'], safety: true },
        { label: 'ROTARY', unit: 'rpm', dataKey: 'drilling.rpm', val: num(d.rpm), min: 0, max: 180, warn: 150, crit: 170, sub: ['TORQUE', live ? fmt(num(htd.torque) / 100, 1) : '—', 'kN·m'] },
        { label: 'STANDPIPE', unit: 'psi', dataKey: 'mudpump.pressure', val: sppPsi, min: 0, max: 5000, warn: 3900, crit: 4500, sub: ['TOTAL SPM', live ? fmt(mp.spm) : '—', 'spm'] },
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
            valueStr: g.safety ? sv(g.val, 0) : (live ? fmt(g.val, 0) : '—'),
            trackPath: arc(100, 100, 84, A0, A1), valuePath: arc(100, 100, 84, A0, live ? ang : A0),
            warnPath: arc(100, 100, 93, A0 + clamp01((g.warn - g.min) / (g.max - g.min)) * 270, A0 + clamp01((g.crit - g.min) / (g.max - g.min)) * 270),
            critPath: arc(100, 100, 93, A0 + clamp01((g.crit - g.min) / (g.max - g.min)) * 270, A1),
            ticks, minStr: fmt(g.min), maxStr: fmt(g.max),
        };
    });

    const trends = TREND_DEFS.map((t) => ({ ...t, valueStr: live ? fmt(t.get(raw), t.d) : '—', ...spark(histRef.current[t.id], 100, 24) }));

    // ---- equipment cards (4 left / 4 right) --------------------------------
    const stat = (on, onL, offL, onC = A.ok, offC = A.crit) => ({ status: on ? onL : offL, sColor: on ? onC : offC });
    const equipment = [
        { id: 'mse', label: 'DRILLING · MSE', side: 'l', top: '1%', color: A.ok, ...(mse > 350 ? { status: 'HIGH MSE', sColor: A.warn } : stat(num(d.rpm) > 3, 'ON OPTIMUM', 'IDLE', A.ok, A.warn)),
          params: [{ k: 'MSE', v: live ? fmt(mse) : '—', u: 'MPa' }, { k: 'DRIVE EFF', v: live ? fmt(driveEff) : '—', u: '%' }, { k: 'ROP', v: live ? fmt(d.rop, 1) : '—', u: 'm/h' }, { k: 'WOB', v: sv(d.wob, 1), u: 't' }] },
        { id: 'td', label: 'TOP DRIVE', side: 'r', top: '1%', color: A.a2, ...stat(num(htd.rotation_status) === 1 || num(d.rpm) > 3, 'DRILLING', 'IDLE', A.ok, A.warn),
          params: [{ k: 'RPM', v: fmt(htd.rpm), u: '' }, { k: 'TORQUE', v: fmt(num(htd.torque) / 100, 1), u: 'kN·m' }] },
        { id: 'dw', label: 'DRAWWORKS', side: 'l', top: '20%', color: A.a1, ...(overpull > 20 ? { status: 'OVERPULL', sColor: A.warn } : stat(num(dw.hook_load) > 1, 'RUNNING', 'IDLE', A.ok, A.warn)),
          params: [{ k: 'HOOK LOAD', v: sv(dw.hook_load), u: 't', dk: 'drawworks.hook_load' }, { k: 'BLOCK', v: fmt(dw.block_position, 1), u: 'm' }, { k: 'OVERPULL', v: live ? fmt(overpull, 1) : '—', u: 't' }, { k: 'FRICTION', v: live ? fmt(friction, 2) : '—', u: '' }] },
        { id: 'mp', label: 'MUD PUMPS', side: 'r', top: '20%', color: A.b1, ...stat(num(mp.spm) > 0, 'ONLINE', 'OFF', A.ok, A.warn),
          params: [{ k: 'STANDPIPE', v: fmt(sppPsi), u: 'psi', dk: 'mudpump.pressure' }, { k: 'RATE', v: fmt(mp.spm), u: 'spm' }] },
        { id: 'hyd', label: 'HYDRAULICS', side: 'l', top: '40%', color: A.info, ...stat(Math.abs(sppDev) < 8, 'GOOD', 'WATCH', A.ok, A.warn),
          params: [{ k: 'ECD', v: live ? fmt(ecd) : '—', u: 'kg/m³' }, { k: 'ANN VEL', v: live ? fmt(annVel, 2) : '—', u: 'm/s' }, { k: 'SPP DEV', v: live ? fmt(sppDev) : '—', u: '%' }, { k: 'T.RATIO', v: live ? fmt(tRatio, 2) : '—', u: '' }] },
        { id: 'pit', label: 'ACTIVE PITS', side: 'r', top: '40%', color: A.b2, ...(num(fl.tank_gain_loss) > 0.5 ? { status: 'GAIN TREND', sColor: A.warn } : stat(true, 'STABLE', 'STABLE', A.ok)),
          params: [{ k: 'VOLUME', v: fmt(fl.total_tank_volume), u: 'm³' }, { k: 'GAIN/LOSS', v: fmt(fl.tank_gain_loss, 1), u: 'm³', dk: 'fluid.tank_gain_loss' }, { k: 'RETURN', v: fmt(mp.flow_out), u: '%' }] },
        { id: 'wctl', label: 'WELL CONTROL', side: 'l', top: '60%', color: A.crit, ...((bop_esd(sf) || kickConf > 0.5) ? { status: bop_esd(sf) ? 'ESD' : 'WATCH', sColor: A.crit } : stat(true, 'NORMAL', 'NORMAL', A.ok)),
          params: [{ k: 'KICK CONF', v: live ? fmt(kickConf, 2) : '—', u: '' }, { k: 'LOSS CONF', v: live ? fmt(lossConf, 2) : '—', u: '' }, { k: 'TUBING P', v: sv(wh.tubing_pressure), u: 'bar', dk: 'wellhead.tubing_pressure' }, { k: 'CASING P', v: sv(wh.casing_pressure), u: 'bar', dk: 'wellhead.casing_pressure' }] },
        { id: 'pp', label: 'POWER PACK', side: 'r', top: '60%', color: A.warn, ...stat(num(cat.rpm) > 0, 'ON BUS', 'OFF'),
          params: [{ k: 'POWER', v: live ? fmt(powerKw) : '—', u: 'kW' }, { k: 'FUEL', v: live ? fmt(eff.fuelLph ?? cat.fuel_rate) : '—', u: 'L/h' }, { k: 'CO₂', v: live ? fmt(co2) : '—', u: 'kg/h' }, { k: 'LOAD', v: fmt(cat.load), u: '%' }] },
    ];

    // ---- BOP / well control ------------------------------------------------
    const ramState = (closeFlag, openFlag) => (closeFlag ? 'CLOSED' : openFlag ? 'OPEN' : 'ARMED');
    const esd = bop_esd(sf);
    const rams = [
        { name: 'ANNULAR', state: ramState(wc.annular_close, wc.annular_open) },
        { name: 'UPPER PIPE', state: ramState(wc.pipe_ram_close, wc.pipe_ram_open) },
        { name: 'LOWER PIPE', state: ramState(wc.pipe_ram_close, wc.pipe_ram_open) },
        { name: 'BLIND/SHEAR', state: ramState(wc.blind_ram_close, wc.shear_ram_open) },
    ];
    const bopPress = [
        { k: 'ACCUM', v: sv(wc.accumulator_pressure), u: 'psi', c: num(wc.accumulator_pressure) < 2850 ? A.warn : A.info, dk: 'well_control.accumulator_pressure' },
        { k: 'ANNULAR', v: sv(wc.annular_pressure), u: 'psi', c: A.info },
        { k: 'CHOKE', v: sv(wc.manifold_pressure), u: 'psi', c: A.info },
        { k: 'KILL', v: sv(num(wc.manifold_pressure) * 1.08), u: 'psi', c: A.info },
    ];
    const bopStatus = esd ? 'ESD ACTIVE' : (rams.some((r) => r.state === 'CLOSED') ? 'CLOSED · MONITOR' : 'OPEN');
    const bopColor = esd ? A.crit : A.ok;
    const ramColor = (s) => (s === 'CLOSED' ? A.crit : s === 'OPEN' ? '#7c8aa0' : A.warn);
    const ramFill = (s) => (s === 'CLOSED' ? A.crit : s === 'ARMED' ? A.warn : 'transparent');

    // ---- wellbore ----------------------------------------------------------
    const bitTopPct = `${(clamp01(bitDepth / td) * 100).toFixed(2)}%`;
    const holePct = `${(clamp01(holeDepth / td) * 100).toFixed(2)}%`;
    const tripLabel = live ? (num(d.operation_mode) === 3 ? 'PULLING OUT' : num(d.operation_mode) === 2 ? 'RUNNING IN' : (act.label || opModeLabel(d.operation_mode)).toUpperCase()) : 'NO DATA';
    const tripColor = num(d.operation_mode) === 3 ? A.a1 : A.a2;
    const tripStats = [
        { k: 'ROP', v: live ? fmt(d.rop, 1) : '—', u: 'm/h', c: A.ok },
        { k: 'BLOCK', v: live ? fmt(dw.block_position, 1) : '—', u: 'm', c: c.txt },
        { k: 'INCL', v: live ? fmt(htd.inclination, 1) : '—', u: '°', c: A.b2 },
        { k: 'WOB', v: sv(d.wob, 1), u: 't', c: A.a1 },
    ];
    const formations = [
        { name: 'OVERBURDEN', top: 0, bot: 0.23, color: 'rgba(160,170,190,.16)' },
        { name: 'SHALE', top: 0.23, bot: 0.52, color: 'rgba(70,166,255,.14)' },
        { name: 'SANDSTONE', top: 0.52, bot: 0.77, color: 'rgba(255,157,46,.16)' },
        { name: 'LIMESTONE', top: 0.77, bot: 0.92, color: 'rgba(169,239,52,.15)' },
        { name: 'RESERVOIR', top: 0.92, bot: 1, color: 'rgba(154,139,255,.20)' },
    ];

    // ---- shared style fragments -------------------------------------------
    const card = { background: c.bg2, border: `1px solid ${c.line}`, borderRadius: 10 };
    const sectionLabel = { fontSize: 11, fontWeight: 700, letterSpacing: '.16em', color: c.txt2 };
    const headChip = { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 8, background: c.bg3, border: `1px solid ${c.line}` };

    const Gauge = ({ g }) => (
        <div style={{ flex: 1, minWidth: 0, border: `1px solid ${g.alarm ? g.alarm.color : c.line}`, borderRadius: 9, background: c.bg3, padding: '10px 12px', boxShadow: g.alarm ? `0 0 0 1px ${g.alarm.color} inset` : 'none', animation: blinkAnim(g.alarm) }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.08em', color: c.txt2 }}>{g.label}</span>
                {g.alarm
                    ? <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.04em', color: g.alarm.color }}>{g.alarm.priority} · {g.alarm.condition}{g.alarm.state !== 'ACK' ? '' : ' ✓'}</span>
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

    const blockY = 63 - clamp01(num(dw.block_position) / MAST_MAX_M) * 45;
    const crownY = 63 - clamp01(CROWN_LIMIT_M / MAST_MAX_M) * 45;
    const floorY = 63 - clamp01(FLOOR_LIMIT_M / MAST_MAX_M) * 45;
    const blockAlarm = num(dw.block_position) >= CROWN_LIMIT_M || num(dw.block_position) <= FLOOR_LIMIT_M;

    // One equipment card. Rendered in flex columns (no absolute positioning), so
    // cards never overlap regardless of how many params each holds.
    const EquipCard = (e) => (
        <div key={e.id} style={{ background: c.bg3, border: `1px solid ${c.line}`, borderLeft: `3px solid ${e.color}`, borderRadius: 8, padding: '8px 10px', boxShadow: '0 4px 16px rgba(0,0,0,.18)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', color: c.txt }}>{e.label}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: e.sColor, boxShadow: `0 0 5px ${e.sColor}` }} />
                    <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.02em', color: e.sColor }}>{e.status}</span>
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
                                <span style={{ fontFamily: MONO, fontSize: 16, fontWeight: 800, lineHeight: 1, color: pa ? pa.color : e.color }}>{p.v}</span>
                                {p.u && <span style={{ fontSize: 8, fontWeight: 600, color: c.txt3 }}>{p.u}</span>}
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );

    return (
        <div style={{ background: c.bg, color: c.txt, fontFamily: SANS, minHeight: '100%', margin: -24, display: 'flex', flexDirection: 'column' }}>
            <style>{`@keyframes annScroll{0%{transform:translateY(0)}100%{transform:translateY(-50%)}}@keyframes pulseDot{0%,100%{opacity:1}50%{opacity:.2}}`}</style>

            {/* Header (brand/rig/well/depths/activity/live) lives in the app top bar
                to avoid a duplicate row — see Layout.jsx. */}

            {/* ---- annunciator ticker ---- */}
            <div onClick={() => navigate('/alarms')} style={{ cursor: 'pointer', display: 'flex', alignItems: 'stretch', borderBottom: `1px solid ${c.line}`, background: c.bg2 }}>
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

                {/* WELLBORE */}
                <div style={{ flex: '0 0 230px', display: 'flex', flexDirection: 'column' }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', ...card, padding: 11 }}>
                        <span style={{ ...sectionLabel, marginBottom: 9 }}>WELLBORE</span>
                        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
                            {[['BIT', wellboreVal(sv(bitDepth)), A.a1], ['HOLE', wellboreVal(sv(holeDepth)), c.txt]].map(([k, v, col]) => (
                                <div key={k} style={{ flex: 1, border: `1px solid ${c.line}`, borderRadius: 7, padding: '8px 9px', background: c.bg2 }}>
                                    <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.1em', color: c.txt3 }}>{k}</div>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}><span style={{ fontFamily: MONO, fontSize: 21, fontWeight: 800, lineHeight: 1, color: col }}>{v}</span><span style={{ fontSize: 9, color: c.txt3 }}>m</span></div>
                                </div>
                            ))}
                        </div>
                        <div style={{ position: 'relative', flex: 1, minHeight: 340, border: `1px solid ${c.line}`, borderRadius: 10, background: c.bg3, overflow: 'hidden' }}>
                            {formations.map((f) => (
                                <div key={f.name} style={{ position: 'absolute', left: 0, right: 0, top: `${f.top * 100}%`, height: `${(f.bot - f.top) * 100}%`, background: f.color, borderTop: `1px solid ${c.line}`, display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', padding: '4px 7px' }}>
                                    <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.1em', color: c.txt2, opacity: .85 }}>{f.name}</span>
                                </div>
                            ))}
                            <div style={{ position: 'absolute', left: 8, top: 5, fontFamily: MONO, fontSize: 8, fontWeight: 700, color: c.txt3 }}>SURFACE 0m</div>
                            {/* trip badge */}
                            <div style={{ position: 'absolute', right: 6, top: 16, padding: '3px 7px', borderRadius: 5, background: live ? tripColor : c.line2, textAlign: 'center' }}>
                                <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.03em', color: '#04171c' }}>{tripLabel}</span>
                            </div>
                            <div style={{ position: 'absolute', left: '38%', top: 0, bottom: 0, width: 2, background: c.line2, transform: 'translateX(-50%)' }} />
                            <div style={{ position: 'absolute', left: '38%', top: 0, height: live ? bitTopPct : 0, width: 3, background: A.a1, transform: 'translateX(-50%)', borderRadius: 2, transition: 'height .8s linear' }} />
                            {live && (
                                <div style={{ position: 'absolute', left: 0, right: '24%', top: bitTopPct, transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', gap: 5, padding: '0 5px', transition: 'top .8s linear' }}>
                                    <span style={{ flex: 1, height: 2, background: A.a1, boxShadow: `0 0 8px ${A.a1}` }} />
                                    <span style={{ width: 11, height: 11, borderRadius: '50%', background: A.a1, boxShadow: `0 0 10px ${A.a1}`, flex: 'none' }} />
                                </div>
                            )}
                            <div style={{ position: 'absolute', left: 4, top: bitTopPct, transform: 'translateY(-50%) translateY(-13px)', fontFamily: MONO, fontSize: 9, fontWeight: 800, color: A.a1 }}>BIT {sv(bitDepth)}m</div>
                            <div style={{ position: 'absolute', left: 0, right: 0, top: holePct, transform: 'translateY(-50%)', display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px' }}>
                                <span style={{ flex: 1, height: 1, background: A.info, opacity: .6 }} />
                            </div>
                            <div style={{ position: 'absolute', left: 6, top: holePct, transform: 'translateY(-50%) translateY(11px)', fontFamily: MONO, fontSize: 8, fontWeight: 700, color: A.info }}>TD {sv(holeDepth)}m</div>
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 9 }}>
                            {tripStats.map((sItem) => (
                                <div key={sItem.k} style={{ border: `1px solid ${c.line}`, borderRadius: 7, padding: '7px 8px', background: c.bg2 }}>
                                    <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.08em', color: c.txt3 }}>{sItem.k}</div>
                                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 2 }}>
                                        <span style={{ fontFamily: MONO, fontSize: 14, fontWeight: 800, color: sItem.c }}>{sItem.v}</span>
                                        {sItem.u && <span style={{ fontSize: 8, color: c.txt3 }}>{sItem.u}</span>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                {/* RIG FLOOR & EQUIPMENT + BOP */}
                <div style={{ flex: '1 1 540px', display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', ...card, overflow: 'hidden' }}>
                        <span style={{ ...sectionLabel, padding: '12px 13px 2px' }}>RIG FLOOR &amp; EQUIPMENT</span>
                        <div style={{ display: 'flex', gap: 12, flex: 1, minHeight: 560, padding: '8px 12px 12px', alignItems: 'stretch' }}>
                            {/* Left equipment column */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: '0 0 172px', minWidth: 0 }}>
                                {equipment.filter((e) => e.side === 'l').map(EquipCard)}
                            </div>
                            {/* Center derrick / mast / BOP schematic */}
                            <div style={{ position: 'relative', flex: '1 1 0', minWidth: 130 }}>
                            <svg viewBox="0 0 100 150" preserveAspectRatio="xMidYMid meet" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                                <line x1="8" y1="118" x2="92" y2="118" stroke={c.line2} strokeWidth="0.8" />
                                <polygon points="37,108 63,108 59,118 41,118" fill={c.bg3} stroke={c.line2} strokeWidth="0.6" />
                                <rect x="33" y="103" width="34" height="5" rx="0.6" fill={c.bg3} stroke={c.line2} strokeWidth="0.7" />
                                <line x1="40" y1="103" x2="47" y2="14" stroke={c.line2} strokeWidth="1.1" />
                                <line x1="60" y1="103" x2="53" y2="14" stroke={c.line2} strokeWidth="1.1" />
                                <path d="M41.2,90 L57.6,75 L43.4,60 L55.6,45 L45,30 L54,18" stroke={c.line} strokeWidth="0.7" fill="none" />
                                <path d="M58.8,90 L42.4,75 L56.6,60 L44.4,45 L55,30 L46,18" stroke={c.line} strokeWidth="0.7" fill="none" />
                                <rect x="43" y="9" width="14" height="5" rx="1" fill={c.bg3} stroke={c.txt3} strokeWidth="0.7" />
                                {/* crown-saver limit */}
                                <line x1="43" y1={crownY.toFixed(1)} x2="57" y2={crownY.toFixed(1)} stroke={A.warn} strokeWidth="0.6" strokeDasharray="1.6 1" />
                                <text x="41.5" y={(crownY + 0.9).toFixed(1)} fontSize="2.8" fontWeight="800" textAnchor="end" fill={A.warn} fontFamily={MONO}>{CROWN_LIMIT_M.toFixed(1)} m</text>
                                {/* floor-saver limit */}
                                <line x1="43" y1={floorY.toFixed(1)} x2="57" y2={floorY.toFixed(1)} stroke={A.warn} strokeWidth="0.6" strokeDasharray="1.6 1" />
                                <text x="41.5" y={(floorY + 0.9).toFixed(1)} fontSize="2.8" fontWeight="800" textAnchor="end" fill={A.warn} fontFamily={MONO}>{FLOOR_LIMIT_M.toFixed(1)} m</text>
                                {/* travelling block */}
                                <line x1="47.5" y1="14" x2="47.5" y2={blockY.toFixed(1)} stroke={A.a1} strokeWidth="0.5" opacity="0.8" />
                                <line x1="52.5" y1="14" x2="52.5" y2={blockY.toFixed(1)} stroke={A.a1} strokeWidth="0.5" opacity="0.8" />
                                <rect x="44" y={blockY.toFixed(1)} width="12" height="5.4" rx="1" fill={blockAlarm ? A.crit : A.a1} style={{ filter: blockAlarm ? `drop-shadow(0 0 3px ${A.crit})` : 'none' }} />
                                <text x="50" y={(blockY + 3.8).toFixed(1)} fontSize="2.8" fontWeight="800" textAnchor="middle" fill="#0a0d14" fontFamily={MONO}>{live ? fmt(dw.block_position, 1) : '--'} m</text>
                                {/* BOP stack */}
                                <line x1="50" y1="103" x2="50" y2="118" stroke={A.a2} strokeWidth="0.7" opacity="0.7" />
                                <text x="58.5" y="120" fontSize="2.5" fontWeight="700" fill={c.txt3} fontFamily={MONO}>BOP STACK</text>
                                <rect x="43" y="120" width="14" height="5" rx="2.4" fill={ramFill(rams[0].state)} stroke={c.line2} strokeWidth="0.8" />
                                <text x="50" y="123.6" fontSize="2.1" textAnchor="middle" fontWeight="700" fill={c.txt} fontFamily={MONO}>ANNULAR</text>
                                <rect x="44" y="125.6" width="12" height="4.6" rx="0.8" fill={ramFill(rams[1].state)} stroke={c.line2} strokeWidth="0.8" />
                                <rect x="44" y="130.8" width="12" height="4.6" rx="0.8" fill={ramFill(rams[3].state)} stroke={c.line2} strokeWidth="0.8" />
                                <rect x="46.5" y="135.8" width="7" height="4" rx="0.5" fill={c.bg3} stroke={c.line2} strokeWidth="0.8" />
                                <path d="M58.4 127.9 L63 127.9 L63 140" stroke={A.info} strokeWidth="0.6" fill="none" />
                                <text x="63.8" y="135" fontSize="2" fill={A.info} fontFamily={MONO}>CHOKE</text>
                                <path d="M41.6 127.9 L37 127.9 L37 140" stroke={A.b2} strokeWidth="0.6" fill="none" />
                                <text x="31" y="135" fontSize="2" fill={A.b2} fontFamily={MONO}>KILL</text>
                            </svg>
                            <div style={{ position: 'absolute', left: '50%', top: '44%', transform: 'translate(-50%,-50%)', textAlign: 'center', pointerEvents: 'none' }}>
                                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.22em', color: c.txt3, opacity: .5 }}>DERRICK · MAST</div>
                            </div>
                            </div>
                            {/* Right equipment column */}
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: '0 0 172px', minWidth: 0 }}>
                                {equipment.filter((e) => e.side === 'r').map(EquipCard)}
                            </div>
                        </div>
                    </div>

                    {/* BOP bar */}
                    <div style={{ marginTop: 14, ...card, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ width: 8, height: 8, borderRadius: '50%', background: bopColor, boxShadow: `0 0 6px ${bopColor}` }} />
                            <span style={{ fontSize: 12, fontWeight: 800, letterSpacing: '.1em', color: c.txt }}>BOP STACK</span>
                            <span style={{ fontSize: 10, fontWeight: 700, color: bopColor }}>{bopStatus}</span>
                        </span>
                        <span style={{ width: 1, height: 26, background: c.line2 }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
                            {bopPress.map((p) => {
                                const pa = alarmFor(p.dk);
                                return (
                                    <span key={p.k} style={{ display: 'flex', flexDirection: 'column', gap: 2, animation: blinkAnim(pa) }}>
                                        <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: '.1em', color: pa ? pa.color : c.txt3 }}>{p.k}{pa ? ` · ${pa.condition}` : ''}</span>
                                        <span style={{ display: 'flex', alignItems: 'baseline', gap: 3 }}>
                                            <span style={{ fontFamily: MONO, fontSize: 17, fontWeight: 800, lineHeight: 1, color: pa ? pa.color : p.c }}>{p.v}</span>
                                            <span style={{ fontSize: 8, color: c.txt3 }}>{p.u}</span>
                                        </span>
                                    </span>
                                );
                            })}
                        </div>
                        <span style={{ width: 1, height: 26, background: c.line2 }} />
                        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                            {rams.map((r, i) => (
                                <span key={r.name + i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 6, background: c.bg3, border: `1px solid ${c.line}` }}>
                                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: ramColor(r.state), boxShadow: `0 0 5px ${ramColor(r.state)}` }} />
                                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.02em', color: c.txt2 }}>{r.name}</span>
                                    <span style={{ fontSize: 9, fontWeight: 800, color: ramColor(r.state) }}>{r.state}</span>
                                </span>
                            ))}
                        </div>
                    </div>
                </div>

                {/* PRIMARY INSTRUMENTS + TRENDS */}
                <div style={{ flex: '1 1 580px', display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
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
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                            {trends.map((t) => (
                                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                                    <span style={{ width: 78, flex: 'none', fontSize: 9, fontWeight: 700, letterSpacing: '.06em', color: c.txt2 }}>{t.label}</span>
                                    <div style={{ flex: 1, height: 28, minWidth: 0 }}>
                                        <svg viewBox="0 0 100 24" width="100%" height="100%" preserveAspectRatio="none">
                                            <path d={t.area} fill={t.color} opacity="0.16" />
                                            <path d={t.line} fill="none" stroke={t.color} strokeWidth="1.4" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
                                        </svg>
                                    </div>
                                    <span style={{ width: 54, flex: 'none', textAlign: 'right', fontFamily: MONO, fontSize: 14, fontWeight: 800, color: t.color }}>{t.valueStr}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// helpers kept out of render scope
function bop_esd(sf) { return Number(sf?.esd_active) === 1 || Number(sf?.lockout_active) === 1; }
function wellboreVal(v) { return v; }
