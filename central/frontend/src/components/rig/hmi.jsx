import React from 'react';
import { Box, Paper, Typography, Chip, Stack, Tooltip } from '@mui/material';
import CATALOG from '../../edrMetrics.json';
import { fmtNum, TintChip } from '../common';

// =====================================================================
// Shared HMI primitives + edge status-enum maps for the per-rig remote HMI
// mirror (proposal §6.1 rig drill-down). Enum codes mirror the edge field map.
// =====================================================================

// Number formatter is the shared one (UI-29); kept exported as `num` for the
// existing panel imports.
export const num = fmtNum;

// ---- EDR metric catalog lookup ---------------------------------------
// edrMetrics.json is the single source of truth for label/unit/precision/
// range. Keyed "category.field" (e.g. 'drawworks.hook_load').
export const METRIC = {};
for (const cat of (CATALOG.categories || [])) {
    for (const f of (cat.fields || [])) {
        METRIC[`${cat.id}.${f.id}`] = { label: f.label, unit: f.unit, d: f.precision, min: f.defaultMin, max: f.defaultMax };
    }
}
export const metricInfo = (id) => METRIC[id] || {};
// Prop bundles to spread into the HMI primitives instead of hardcoded literals.
export const gaugeProps = (id) => { const m = metricInfo(id); return { unit: m.unit, d: m.d, min: m.min, max: m.max }; };
export const tileProps = (id) => { const m = metricInfo(id); return { unit: m.unit, d: m.d }; };

// Shared tank gain/loss alarm threshold (m³) — identical on every panel.
export const TANK_GAIN_LOSS_WARN_M3 = 1;
// Warn colorizer for tank gain/loss tiles: amber on gain, red on loss.
export const tankGainLossWarn = (n) => (Math.abs(n) > TANK_GAIN_LOSS_WARN_M3 ? (n > 0 ? '#f59e0b' : '#ef4444') : null);

// ---- Status-code -> {text, color} maps (from the edge rig_data enums) ----
const C = { ok: '#22c55e', warn: '#f59e0b', bad: '#ef4444', idle: '#64748b', info: '#38bdf8' };

export const ENUM = {
    onoff:        { 0: ['OFF', C.idle], 1: ['ON · IDLE', C.info], 2: ['ON', C.ok] },              // hpu/htd/pct/engine status
    engine:       { '-1': ['UNKNOWN', C.idle], 0: ['READY', C.info], 1: ['STARTING', C.warn], 2: ['RUNNING', C.ok], 3: ['EMG NOT OK', C.bad], 4: ['NOT READY', C.warn], 5: ['FAULT', C.bad], 6: ['RUN+FAULT', C.bad], 7: ['STOP FORCED', C.bad] },
    pumpStatus:   { 0: ['NOT READY', C.warn], 1: ['READY', C.info], 2: ['ENABLE', C.ok] },
    oilFilter:    { 0: ['OK', C.ok], 1: ['LOW', C.info], 2: ['HIGH', C.warn], 3: ['CRIT', C.bad] },
    brake:        { 1: ['CLOSING', C.warn], 2: ['CLOSED', C.ok], 3: ['OPENING', C.warn], 4: ['OPEN', C.info], 5: ['FAULT', C.bad] },
    ibop:         { 1: ['OPENING', C.warn], 2: ['CLOSING', C.warn], 3: ['OPEN', C.info], 4: ['CLOSE', C.ok], 5: ['FAULT', C.bad] },
    elevator:     { 1: ['OPENING', C.warn], 2: ['CLOSING', C.warn], 3: ['OPEN', C.info], 4: ['CLOSE', C.ok], 5: ['FAULT', C.bad] },
    tilt:         { 1: ['FLOAT ON', C.info], 2: ['VERTICAL', C.ok], 3: ['FLOAT OFF', C.idle], 4: ['EXTEND', C.warn], 5: ['RETRACT', C.warn], 6: ['FAULT', C.bad] },
    clamp:        { 1: ['OPENING', C.warn], 2: ['CLOSING', C.warn], 3: ['OPEN', C.info], 4: ['CLOSE', C.ok], 5: ['FAULT', C.bad] },
    pctSeq:       { 0: ['IDLE', C.idle], 1: ['MAKE-UP', C.ok], 2: ['BREAK-OUT', C.warn], 3: ['RESET', C.info], 4: ['FAULT', C.bad] },
    dolly:        { 1: ['HOME', C.ok], 2: ['FWD', C.info], 3: ['REV', C.info], 4: ['MID', C.idle], 5: ['FAULT', C.bad], 6: ['READY', C.ok] },
    rotation:     { 0: ['STOP', C.idle], 1: ['CW', C.ok], 2: ['CCW', C.info], 3: ['FAULT', C.bad] },
    acs:          { 1: ['ON', C.ok], 2: ['OFF', C.idle], 3: ['DISABLE', C.warn] },
    cwkParked:    { 0: ['NOT PARKED', C.warn], 1: ['PARKED', C.ok] },
    opMode:       { 0: ['IDLE', C.idle], 1: ['CIRCULATE', C.info], 2: ['TRIP IN', C.ok], 3: ['TRIP OUT', C.ok], 4: ['CASING', C.warn] },
    sourceCmd:    { 0: ['NONE', C.idle], 1: ['LOCAL', C.info], 2: ['REMOTE', C.ok], 3: ['MANUAL', C.warn], 4: ['AUTO', C.ok], 5: ['DCC', C.info] },
    bool:         { 0: ['OFF', C.idle], 1: ['ACTIVE', C.ok] },
    ramOpen:      { 0: ['NOT OPEN', C.idle], 1: ['OPEN', C.info] },
    ramClose:     { 0: ['NOT CLOSED', C.idle], 1: ['CLOSED', C.ok] },
    // Safety trips: active state is an alarm (red), inactive is neutral —
    // NEVER the generic green bool map (green "ACTIVE" reads as healthy).
    esd:          { 0: ['NORMAL', C.idle], 1: ['ESD ACTIVE', C.bad] },
    lockout:      { 0: ['NORMAL', C.idle], 1: ['LOCKOUT ACTIVE', C.bad] },
};

// ---- Freshness threading ---------------------------------------------
// Panels wrap their tree in <FreshProvider value={freshness(data?._meta)}>
// once; every primitive below then dims + annotates itself when stale.
// A `fresh` prop on a primitive overrides the context value if ever needed.
const FreshContext = React.createContext(null);
export const FreshProvider = FreshContext.Provider;
function useFresh(override) {
    const ctx = React.useContext(FreshContext);
    return override !== undefined ? override : ctx;
}
const STALE_GREY = '#94a3b8';
const asOfTitle = (fr) => `as of ${fr?.asOf || 'unknown time'} — ${fr?.text || 'stale'}`;

// Render a coded status as a coloured chip. (Named EnumChip — the fleet-status
// chip in components/common.jsx owns the StatusChip name.)
export function EnumChip({ value, map, size = 'small', fallback = '—', fresh }) {
    const fr = useFresh(fresh);
    const stale = !!(fr && fr.stale);
    const m = ENUM[map] || {};
    const hit = value == null ? null : m[String(value)] || m[Number(value)];
    let chip;
    if (!hit) {
        chip = <Chip size={size} variant="outlined" label={value == null ? fallback : String(value)} sx={{ color: 'text.secondary', ...(stale ? { opacity: 0.6 } : null) }} />;
    } else {
        const [text, color] = hit;
        const c = stale ? STALE_GREY : color;
        chip = <TintChip size={size} label={text} color={c} sx={stale ? { opacity: 0.7 } : undefined} />;
    }
    return stale ? <Tooltip title={asOfTitle(fr)}>{chip}</Tooltip> : chip;
}

// Big numeric tile with unit + label, optional range bar + warn coloring.
// `warn(n)` may return a boolean (red) or a colour string (e.g. amber vs red).
export function ValueTile({ label, value, unit, d = 1, min, max, warn, fresh, sx }) {
    const fr = useFresh(fresh);
    const stale = !!(fr && fr.stale);
    const n = Number(value);
    const has = Number.isFinite(n);
    let pct = null;
    if (has && min != null && max != null && max > min) pct = Math.max(0, Math.min(100, ((n - min) / (max - min)) * 100));
    const w = has && warn ? warn(n) : null;
    const warnColor = w ? (typeof w === 'string' ? w : '#ef4444') : null;
    const color = stale ? 'text.secondary' : (warnColor || 'text.primary');
    const tile = (
        <Paper sx={{ p: 1.5, minWidth: 120, ...(stale ? { opacity: 0.6 } : null), ...sx }}>
            <Typography variant="caption" color="text.secondary" noWrap sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</Typography>
            <Typography variant="h6" fontWeight={800} sx={{ color, lineHeight: 1.2 }}>
                {has ? num(value, d) : '—'} <Typography component="span" variant="caption" color="text.secondary">{unit}</Typography>
            </Typography>
            {pct != null && (
                <Box sx={{ height: 5, borderRadius: 3, bgcolor: 'rgba(255,255,255,0.08)', mt: 0.5, overflow: 'hidden' }}>
                    <Box sx={{ width: `${pct}%`, height: '100%', bgcolor: stale ? STALE_GREY : (warnColor || 'primary.main') }} />
                </Box>
            )}
        </Paper>
    );
    return stale ? <Tooltip title={asOfTitle(fr)}>{tile}</Tooltip> : tile;
}

// Labelled status row: label on the left, EnumChip on the right.
export function StatusRow({ label, value, map }) {
    return (
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ py: 0.4 }}>
            <Typography variant="body2" color="text.secondary">{label}</Typography>
            <EnumChip value={value} map={map} />
        </Stack>
    );
}

// Compact circular gauge (SVG arc) for a single value.
export function MiniGauge({ label, value, unit, min = 0, max = 100, d = 0, warn, fresh }) {
    const fr = useFresh(fresh);
    const stale = !!(fr && fr.stale);
    const n = Number(value);
    const has = Number.isFinite(n);
    const frac = has ? Math.max(0, Math.min(1, (n - min) / ((max - min) || 1))) : 0;
    const R = 34, C0 = Math.PI * R, dash = C0 * frac;
    const col = stale ? STALE_GREY : (warn && warn(n) ? '#ef4444' : (frac > 0.85 ? '#f59e0b' : '#3ea6ff'));
    const gauge = (
        <Paper sx={{ p: 1.5, textAlign: 'center', minWidth: 120, ...(stale ? { opacity: 0.6 } : null) }}>
            <svg viewBox="0 0 90 56" style={{ width: '100%', maxWidth: 130 }}>
                <path d="M8 50 A37 37 0 0 1 82 50" fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="7" strokeLinecap="round" />
                <path d="M8 50 A37 37 0 0 1 82 50" fill="none" stroke={col} strokeWidth="7" strokeLinecap="round"
                    strokeDasharray={`${dash} ${C0}`} />
                <text x="45" y="44" textAnchor="middle" fontSize="16" fontWeight="800" fill={stale ? STALE_GREY : '#e8eefc'}>{has ? num(value, d) : '—'}</text>
            </svg>
            <Typography variant="caption" color="text.secondary" display="block" noWrap>{label}{unit ? ` (${unit})` : ''}</Typography>
        </Paper>
    );
    return stale ? <Tooltip title={asOfTitle(fr)}>{gauge}</Tooltip> : gauge;
}

// Section header used inside panels.
export function PanelHead({ title, right }) {
    return (
        <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={700}>{title}</Typography>
            {right}
        </Stack>
    );
}

// Stale / disconnected banner data helper. `asOf` is the wall-clock time of
// the last sample (for "as of <time>" tooltips on dimmed primitives).
export function freshness(meta) {
    if (!meta) return { stale: true, text: 'no data', color: '#ef4444', asOf: null };
    const ts = meta.ts || meta.timestamp || meta.last_update ||
        (meta.age_ms != null ? Date.now() - meta.age_ms : null);
    const asOf = ts ? new Date(ts).toLocaleTimeString() : null;
    if (!meta.connected) return { stale: true, text: 'OFFLINE', color: '#ef4444', asOf };
    if (meta.stale) return { stale: true, text: 'STALE', color: '#f59e0b', asOf };
    const age = meta.age_ms != null ? Math.round(meta.age_ms / 1000) : null;
    return { stale: false, text: age != null ? `live · ${age}s` : 'live', color: '#22c55e', asOf };
}
