import React from 'react';
import { Chip, Paper, Box, Typography } from '@mui/material';
import { STATUS_COLOR, WELL_STATUS_COLOR } from '../theme';

// ---- Shared formatters (UI-29 / UI-30) ------------------------------------

// '' counts as missing too (mirrors the old rig/hmi `num`), so a blank field
// never renders as "0".
export const fmtNum = (v, d = 1) => (v == null || v === '' || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: d }));

// Relative "x ago". `nullLabel` covers both call-site conventions:
// 'never' (default) for liveness columns, '—' for optional record timestamps.
export function fmtAgo(ts, nullLabel = 'never') {
    if (ts == null || ts === '') return nullLabel;
    const ms = typeof ts === 'number' ? ts : new Date(ts).getTime();
    if (!Number.isFinite(ms)) return nullLabel;
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}

// 24-hour date/time formatters: fmtDate -> "DD Mmm YYYY",
// fmtDateTime -> "DD Mmm HH:mm" (UI-30 — locale-independent, never 12-hour).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n) => String(n).padStart(2, '0');

export function fmtDate(v) {
    if (!v) return '—';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '—' : `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function fmtDateTime(v) {
    if (!v) return '—';
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? '—' : `${pad2(d.getDate())} ${MONTHS[d.getMonth()]} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDuration(sec) {
    if (sec == null || Number.isNaN(Number(sec))) return '—';
    const s = Math.max(0, Math.round(Number(sec)));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
}

// ---- Tinted chip primitive (UI-41) ----------------------------------------
// The shared bgcolor c+'22' / border c+'55' recipe every coloured chip uses.
export function TintChip({ label, color, size = 'small', sx }) {
    return (
        <Chip size={size} label={label}
            sx={{ bgcolor: color + '22', color, border: `1px solid ${color}55`, fontWeight: 700, ...sx }} />
    );
}

export function StatusChip({ status, size = 'small' }) {
    const color = STATUS_COLOR[status] || '#64748b';
    return <TintChip size={size} label={(status || 'unknown').toUpperCase()} color={color} sx={{ letterSpacing: 0.4 }} />;
}

export function PriorityChip({ priority }) {
    if (!priority) return <Chip size="small" label="—" variant="outlined" />;
    const map = { P1: '#ef4444', P2: '#f59e0b', P3: '#38bdf8' };
    return <TintChip label={priority} color={map[priority] || '#64748b'} />;
}

// Well lifecycle chip (colours from theme WELL_STATUS_COLOR, not rig liveness).
export function WellStatusChip({ status, size = 'small' }) {
    const c = WELL_STATUS_COLOR[status] || '#64748b';
    return <TintChip size={size} label={(status || 'unknown').toUpperCase()} color={c} sx={{ letterSpacing: 0.4 }} />;
}

export function KpiCard({ label, value, sub, color, icon }) {
    return (
        <Paper sx={{ p: 2, flex: 1, minWidth: 150, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.6 }}>{label}</Typography>
                {icon}
            </Box>
            <Typography variant="h4" sx={{ fontWeight: 800, color: color || 'text.primary', lineHeight: 1.1 }}>{value}</Typography>
            {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
        </Paper>
    );
}

export function HealthBar({ value }) {
    const v = Math.max(0, Math.min(100, value || 0));
    const c = v >= 80 ? STATUS_COLOR.online : v >= 50 ? STATUS_COLOR.degraded : STATUS_COLOR.offline;
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 120 }}>
            <Box sx={{ flex: 1, height: 8, borderRadius: 4, bgcolor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                <Box sx={{ width: `${v}%`, height: '100%', bgcolor: c }} />
            </Box>
            <Typography variant="caption" sx={{ width: 32, textAlign: 'right', color: c, fontWeight: 700 }}>{v}</Typography>
        </Box>
    );
}

export function SectionTitle({ children, action }) {
    return (
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5, mt: 1 }}>
            <Typography variant="h6">{children}</Typography>
            {action}
        </Box>
    );
}
