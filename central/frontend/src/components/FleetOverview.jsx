import React, { useCallback, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
    Box, Paper, Typography, Stack, ToggleButton, ToggleButtonGroup, TextField,
    InputAdornment, Select, MenuItem, FormControl, InputLabel, Skeleton,
} from '@mui/material';
import { Search } from '@mui/icons-material';
import { useFleet } from '../context/FleetContext';
import { PriorityChip } from './common';
import { STATUS_COLOR, statusDotSx } from '../theme';
import FleetMap from './FleetMap';

const healthColor = (v) => (v >= 80 ? STATUS_COLOR.online : v >= 50 ? STATUS_COLOR.degraded : STATUS_COLOR.offline);

// Statuses selectable in the filter group (minus 'all') double as the legend order.
const FILTERS = ['all', 'online', 'degraded', 'stale', 'offline', 'pending'];

// Colourblind-safe status dot: shape + fill treatment carries status alongside hue (UI-37).
function StatusDot({ status, size = 10, sx }) {
    return <Box component="span" sx={{ ...statusDotSx(status, size), ...sx }} />;
}

// Compact clickable rig tile, coloured by status. The name/activity/location line
// wraps (no tight ellipsis); a short health bar + alarm sit below. Active P1/P2
// alarms visually dominate the tile (red ring + prominent chip) regardless of the
// health number, which measures data quality only. Clicking zooms briefly then
// opens the rig. Memoised so fleet deltas only re-render tiles whose rig changed.
const RigTile = React.memo(function RigTile({ rig, onOpen }) {
    const [zoom, setZoom] = useState(false);
    const status = rig.status || 'pending';
    const color = STATUS_COLOR[status] || STATUS_COLOR.pending;
    const location = rig.assetUnit || rig.field || '—';
    const hv = Math.max(0, Math.min(100, rig.healthScore || 0));

    const alarmSev = rig.alarm?.highest;
    const alarmHot = alarmSev === 'P1' || alarmSev === 'P2';
    const alarmColor = alarmSev === 'P1' ? '#ef4444' : '#f59e0b';
    const edgeColor = alarmHot ? alarmColor : color;

    const open = () => { if (zoom) return; setZoom(true); setTimeout(() => onOpen(rig.rigId), 150); };
    const onKeyDown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };

    const restShadow = alarmHot ? `0 0 0 2px ${alarmColor}cc` : 'none';
    return (
        <Paper
            role="button"
            tabIndex={0}
            aria-label={`Open rig ${rig.name} (${rig.rigId}) — status ${status}${alarmSev ? `, highest alarm ${alarmSev}` : ''}`}
            onClick={open}
            onKeyDown={onKeyDown}
            title={`${rig.name} · ${rig.activeActivity || '—'} · ${location} · ${status.toUpperCase()}${alarmSev ? ` · ${alarmSev} alarm` : ''}`}
            sx={{
                px: 1, py: 0.85, height: '100%', display: 'flex', flexDirection: 'column', gap: 0.5,
                cursor: 'pointer', borderLeft: `3px solid ${edgeColor}`,
                bgcolor: alarmHot ? `${alarmColor}14` : `${color}0d`,
                transition: 'transform 150ms ease, box-shadow 150ms ease',
                transform: zoom ? 'scale(1.05)' : 'scale(1)',
                boxShadow: zoom ? `0 0 0 2px ${edgeColor}, 0 8px 22px rgba(0,0,0,0.45)` : restShadow,
                '&:hover': { transform: zoom ? 'scale(1.05)' : 'translateY(-1px)', boxShadow: `0 0 0 2px ${edgeColor}${alarmHot ? '' : '55'}` },
                '&:focus-visible': { outline: `2px solid ${edgeColor}`, outlineOffset: 2 },
                // P1 pulses so it stays dominant on a wall full of green tiles.
                ...(alarmSev === 'P1' && {
                    animation: 'rigTileAlarmPulse 1.6s ease-in-out infinite',
                    '@keyframes rigTileAlarmPulse': {
                        '0%, 100%': { boxShadow: `0 0 0 2px ${alarmColor}cc` },
                        '50%': { boxShadow: `0 0 0 5px ${alarmColor}44` },
                    },
                }),
            }}
        >
            {/* Name · activity · location — wraps instead of ellipsis-truncating. */}
            <Stack direction="row" spacing={0.6} alignItems="flex-start">
                <StatusDot status={status} sx={{ mt: '3px' }} />
                <Typography variant="body2" sx={{ lineHeight: 1.25, minWidth: 0, overflowWrap: 'anywhere' }}>
                    <Box component="span" sx={{ fontWeight: 800 }}>{rig.name}</Box>
                    {status === 'stale' && (
                        <Box component="span" sx={{
                            ml: 0.6, px: 0.5, py: '1px', borderRadius: 0.5, fontSize: 10, fontWeight: 800,
                            letterSpacing: 0.5, color: STATUS_COLOR.stale, border: `1px solid ${STATUS_COLOR.stale}`,
                            verticalAlign: 'middle', display: 'inline-block', lineHeight: 1.3,
                        }}>STALE</Box>
                    )}
                    <Box component="span" sx={{ color: 'text.secondary' }}> · {rig.activeActivity || '—'} · {location}</Box>
                </Typography>
            </Stack>

            {/* Short health bar + alarm. Health measures DATA quality; the alarm chip wins visually. */}
            <Stack direction="row" alignItems="center" spacing={0.75}>
                <Box sx={{ width: 56, height: 5, borderRadius: 3, bgcolor: 'rgba(255,255,255,0.08)', overflow: 'hidden', flex: '0 0 auto' }}>
                    <Box sx={{ width: `${hv}%`, height: '100%', bgcolor: healthColor(hv) }} />
                </Box>
                <Typography variant="caption" sx={{ color: healthColor(hv), fontWeight: 700, width: 22 }}>{hv}</Typography>
                <Box sx={{ flexGrow: 1 }} />
                {alarmSev
                    ? (
                        <Box sx={alarmHot ? { transform: 'scale(1.1)', transformOrigin: 'right center', filter: `drop-shadow(0 0 4px ${alarmColor}88)` } : undefined}>
                            <PriorityChip priority={alarmSev} />
                        </Box>
                    )
                    : <StatusDot status="online" size={8} sx={{ opacity: 0.5 }} />}
            </Stack>
        </Paper>
    );
});

export default function FleetOverview() {
    const { fleet, loading } = useFleet();
    const nav = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const [unit, setUnit] = useState('all');
    const [q, setQ] = useState('');

    // Filter preselect comes from ?filter=… (UI-31); unknown values fall back to 'all'.
    const urlFilter = searchParams.get('filter');
    const filter = FILTERS.includes(urlFilter) ? urlFilter : 'all';
    const setFilter = useCallback((v) => {
        setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            if (v === 'all') next.delete('filter'); else next.set('filter', v);
            return next;
        }, { replace: true });
    }, [setSearchParams]);

    // Stable handler so React.memo on RigTile isn't defeated (UI-26).
    const openRig = useCallback((id) => nav(`/rigs/${id}`), [nav]);

    const units = useMemo(() => {
        const set = new Set(fleet.map((r) => r.assetUnit || r.field).filter(Boolean));
        return Array.from(set).sort((a, b) => a.localeCompare(b));
    }, [fleet]);

    const rows = useMemo(() => fleet.filter((r) => {
        if (filter !== 'all' && r.status !== filter) return false;
        if (unit !== 'all' && (r.assetUnit || r.field) !== unit) return false;
        if (q && !(`${r.name} ${r.rigId} ${r.assetUnit || r.field || ''} ${r.activeJob || ''}`.toLowerCase().includes(q.toLowerCase()))) return false;
        return true;
    }), [fleet, filter, unit, q]);

    // Skeletons only cover the initial load; once rigs are streaming, keep them visible.
    const showSkeletons = Boolean(loading) && !fleet.length;

    return (
        // Full-height two-pane: interactive map (left) + rig tiles (right). The status
        // bubbles in the top app bar already carry the fleet KPIs, so no redundant cards.
        <Box sx={{ height: '100%', display: 'flex', flexDirection: { xs: 'column', md: 'row' }, gap: 2, minHeight: 0 }}>
            {/* LEFT — smaller interactive pan/zoom map; click a marker to open the rig. */}
            <Box sx={{ flex: { md: '0.85 1 0' }, minHeight: { xs: 300, md: 0 }, display: 'flex' }}>
                <FleetMap rigs={fleet} />
            </Box>

            {/* RIGHT — denser grid of compact rig tiles, filling the (now larger) pane. */}
            <Box sx={{ flex: { md: '1.7 1 0' }, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <Paper sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    <Box sx={{ p: 1.5, flex: '0 0 auto' }}>
                        <Stack direction="row" alignItems="center" justifyContent="space-between" mb={1}>
                            <Typography variant="h6">Fleet — {rows.length} rig{rows.length !== 1 ? 's' : ''}</Typography>
                        </Stack>
                        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                            <TextField size="small" placeholder="Search rig / unit / job" value={q} onChange={(e) => setQ(e.target.value)} sx={{ flex: 1, minWidth: 160 }}
                                InputProps={{ startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> }} />
                            <FormControl size="small" sx={{ minWidth: 150 }}>
                                <InputLabel id="asset-unit-label">Asset unit</InputLabel>
                                <Select labelId="asset-unit-label" label="Asset unit" value={unit} onChange={(e) => setUnit(e.target.value)}>
                                    <MenuItem value="all">All units</MenuItem>
                                    {units.map((u) => <MenuItem key={u} value={u}>{u}</MenuItem>)}
                                </Select>
                            </FormControl>
                        </Stack>
                        <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_e, v) => v && setFilter(v)} sx={{ mt: 1, flexWrap: 'wrap' }}>
                            <ToggleButton value="all">All</ToggleButton>
                            <ToggleButton value="online">Online</ToggleButton>
                            <ToggleButton value="degraded">Degraded</ToggleButton>
                            <ToggleButton value="stale">Stale</ToggleButton>
                            <ToggleButton value="offline">Offline</ToggleButton>
                            <ToggleButton value="pending">Pending</ToggleButton>
                        </ToggleButtonGroup>
                        {/* Persistent status legend — dot SHAPE + colour, matching the tile dots (UI-37). */}
                        <Stack direction="row" spacing={1.25} flexWrap="wrap" useFlexGap sx={{ mt: 0.75 }} aria-label="Status legend">
                            {FILTERS.filter((s) => s !== 'all').map((s) => (
                                <Stack key={s} direction="row" spacing={0.5} alignItems="center">
                                    <StatusDot status={s} />
                                    <Typography variant="caption" color="text.secondary" textTransform="capitalize">{s}</Typography>
                                </Stack>
                            ))}
                        </Stack>
                    </Box>

                    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 1.5, pb: 1.5 }}>
                        {/* Container-relative grid: many compact tiles per row. */}
                        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(168px, 1fr))', gap: 1, alignItems: 'stretch' }}>
                            {showSkeletons
                                ? Array.from({ length: 12 }).map((_, i) => (
                                    <Skeleton key={i} variant="rounded" height={62} sx={{ borderRadius: 1 }} />
                                ))
                                : rows.map((r) => <RigTile key={r.rigId} rig={r} onOpen={openRig} />)}
                        </Box>
                        {!showSkeletons && !rows.length && (
                            <Box sx={{ py: 6, textAlign: 'center', color: 'text.secondary' }}>
                                <Typography variant="body2">
                                    {fleet.length
                                        ? 'No rigs match the filter.'
                                        : 'No rigs registered yet — add rigs under Settings.'}
                                </Typography>
                            </Box>
                        )}
                    </Box>
                </Paper>
            </Box>
        </Box>
    );
}
