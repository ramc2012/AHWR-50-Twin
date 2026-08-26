import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Box, Paper, Typography, Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    TableSortLabel, ToggleButton, ToggleButtonGroup, Stack, Chip, Alert, IconButton, Collapse,
} from '@mui/material';
import { ExpandLess, ExpandMore } from '@mui/icons-material';
import { api } from '../api';
import { socket } from '../socket';
import { useFleet } from '../context/FleetContext';
import { PriorityChip, fmtAgo } from './common';
import NotificationsPanel from './NotificationsPanel';

// Small table-sort helper (duplicated per file for now — a later pass consolidates).
function useTableSort(initialKey, initialDir = 'desc') {
    const [key, setKey] = useState(initialKey);
    const [dir, setDir] = useState(initialDir);
    const onSort = (k) => {
        if (k === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        else { setKey(k); setDir('desc'); }
    };
    const sorted = (rows, getters) => {
        const g = key && getters[key];
        if (!g) return rows;
        return [...rows].sort((x, y) => {
            const a = g(x), b = g(y);
            if (a == null && b == null) return 0;
            if (a == null) return 1;
            if (b == null) return -1;
            const c = (typeof a === 'number' && typeof b === 'number') ? a - b : String(a).localeCompare(String(b));
            return dir === 'desc' ? -c : c;
        });
    };
    return { key, dir, onSort, sorted };
}

export default function AlarmCommandCentre() {
    const nav = useNavigate();
    const { fleet } = useFleet();
    const [priority, setPriority] = useState('all');
    const [rows, setRows] = useState([]);
    const [err, setErr] = useState('');
    const [loading, setLoading] = useState(true);
    const [notifOpen, setNotifOpen] = useState(true);
    const { key: sortKey, dir: sortDir, onSort, sorted } = useTableSort('p1');

    const load = useCallback(() => {
        setErr('');
        api.alarms(priority === 'all' ? undefined : priority)
            // Defensive parse (live finding): accept either a bare array or an
            // object envelope ({ rows: [...] }) so a shape change never blanks the table.
            .then((d) => setRows(Array.isArray(d) ? d : (Array.isArray(d?.rows) ? d.rows : [])))
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load alarms'); })
            .finally(() => setLoading(false));
    }, [priority]);

    useEffect(() => { setLoading(true); load(); const t = setInterval(load, 4000); return () => clearInterval(t); }, [load]);
    // Refetch on alarm_update only; fleet_update fires per-rig every few seconds
    // across the fleet and was hammering /api/alarms (audit UI-25). A trailing 3s
    // debounce still picks up alarm-counter changes that ride on fleet rows.
    const debounceRef = useRef(null);
    useEffect(() => {
        const onAlarm = () => load();
        const onFleet = () => {
            if (debounceRef.current) return;
            debounceRef.current = setTimeout(() => { debounceRef.current = null; load(); }, 3000);
        };
        socket.on('alarm_update', onAlarm);
        socket.on('fleet_update', onFleet);
        return () => {
            socket.off('alarm_update', onAlarm);
            socket.off('fleet_update', onFleet);
            if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
        };
    }, [load]);

    // Live finding: /api/alarms only rows up rigs it considers alarm-active, so the
    // table could sit empty while fleet rows (the source of the top-strip banners)
    // still carried P1/P2/P3 counts. Merge in any fleet rig with active alarm
    // counters that the endpoint missed, so every alarming rig always rows up.
    const merged = useMemo(() => {
        const have = new Set(rows.map((r) => r.rigId));
        const extra = (fleet || [])
            .filter((f) => !have.has(f.rigId) && f.status !== 'offline' && f.alarm
                && ((f.alarm.active || 0) > 0 || (f.alarm.p1 || 0) > 0 || (f.alarm.p2 || 0) > 0 || (f.alarm.p3 || 0) > 0))
            .map((f) => ({
                rigId: f.rigId, name: f.name,
                active: f.alarm.active || 0, unack: f.alarm.unack || 0,
                p1: f.alarm.p1 || 0, p2: f.alarm.p2 || 0, p3: f.alarm.p3 || 0,
                highest: f.alarm.highest || (f.alarm.p1 ? 'P1' : f.alarm.p2 ? 'P2' : 'P3'),
                activeActivity: f.activeActivity, lastDataAt: f.lastDataAt,
            }));
        let all = rows.concat(extra);
        if (priority !== 'all') all = all.filter((r) => (r[priority] || 0) > 0);
        return all.sort((a, b) => ((b.p1 || 0) - (a.p1 || 0)) || ((b.active || 0) - (a.active || 0)));
    }, [rows, fleet, priority]);

    const view = sorted(merged, {
        p1: (r) => r.p1 || 0,
        unack: (r) => r.unack || 0,
    });

    const p1 = merged.reduce((s, r) => s + (r.p1 || 0), 0);

    const openRig = (rigId) => nav(`/rigs/${rigId}?tab=alarms`);

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Stack direction="row" alignItems="center" spacing={2} mb={2} flexWrap="wrap" useFlexGap>
                <Typography variant="h5" fontWeight={800} sx={{ flexGrow: 1 }}>Alarm Command Centre</Typography>
                <ToggleButtonGroup size="small" exclusive value={priority} onChange={(_e, v) => v && setPriority(v)}>
                    <ToggleButton value="all">All</ToggleButton>
                    <ToggleButton value="p1">P1</ToggleButton>
                    <ToggleButton value="p2">P2</ToggleButton>
                    <ToggleButton value="p3">P3</ToggleButton>
                </ToggleButtonGroup>
            </Stack>

            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}
            {p1 > 0
                ? <Alert severity="error" sx={{ mb: 2 }}>{p1} priority-1 condition(s) active — ESD / lockout / well-control. Read-only: the CRMF surfaces these for surveillance; it never actuates rig control.</Alert>
                : <Alert severity="success" sx={{ mb: 2 }}>No priority-1 conditions across the fleet.</Alert>}

            <Paper sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <TableContainer sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                <TableCell>Rig</TableCell>
                                <TableCell>Highest</TableCell>
                                <TableCell align="right">Active</TableCell>
                                <TableCell align="right" sortDirection={sortKey === 'unack' ? sortDir : false}>
                                    <TableSortLabel active={sortKey === 'unack'} direction={sortKey === 'unack' ? sortDir : 'desc'} onClick={() => onSort('unack')}>Unack</TableSortLabel>
                                </TableCell>
                                <TableCell align="right" sortDirection={sortKey === 'p1' ? sortDir : false}>
                                    <TableSortLabel active={sortKey === 'p1'} direction={sortKey === 'p1' ? sortDir : 'desc'} onClick={() => onSort('p1')}>P1</TableSortLabel>
                                </TableCell>
                                <TableCell align="right">P2</TableCell>
                                <TableCell align="right">P3</TableCell>
                                <TableCell>Activity</TableCell>
                                <TableCell align="right">Last data</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {view.map((r) => (
                                <TableRow key={r.rigId} hover role="button" tabIndex={0}
                                    aria-label={`Open ${r.name || r.rigId} alarms`}
                                    onClick={() => openRig(r.rigId)}
                                    onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openRig(r.rigId); } }}
                                    sx={{ cursor: 'pointer', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}>
                                    <TableCell>
                                        <Typography variant="body2" fontWeight={700} sx={{ color: 'primary.main', '&:hover': { textDecoration: 'underline' } }}>{r.name}</Typography>
                                        <Typography variant="caption" color="text.secondary">{r.rigId}</Typography>
                                    </TableCell>
                                    <TableCell><PriorityChip priority={r.highest} /></TableCell>
                                    <TableCell align="right">{r.active}</TableCell>
                                    <TableCell align="right">{r.unack}</TableCell>
                                    <TableCell align="right">{r.p1 ? <Chip size="small" color="error" label={r.p1} /> : 0}</TableCell>
                                    <TableCell align="right">{r.p2 || 0}</TableCell>
                                    <TableCell align="right">{r.p3 || 0}</TableCell>
                                    <TableCell><Typography variant="caption">{r.activeActivity || '—'}</Typography></TableCell>
                                    <TableCell align="right"><Typography variant="caption" color="text.secondary">{fmtAgo(r.lastDataAt)}</Typography></TableCell>
                                </TableRow>
                            ))}
                            {!view.length && <TableRow><TableCell colSpan={9} align="center" sx={{ py: 5, color: 'text.secondary' }}>{loading ? 'Loading alarms…' : 'No active alarms.'}</TableCell></TableRow>}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>

            {/* Compact dispatch log only — channel CRUD lives in Settings → Notifications (UI-18). */}
            <Box sx={{ mt: 3 }}>
                <Stack direction="row" alignItems="center" spacing={0.5}>
                    <Typography variant="h6" sx={{ cursor: 'pointer' }} onClick={() => setNotifOpen((o) => !o)}>Recent notifications</Typography>
                    <IconButton size="small" aria-label={notifOpen ? 'Collapse notifications' : 'Expand notifications'} onClick={() => setNotifOpen((o) => !o)}>
                        {notifOpen ? <ExpandLess fontSize="small" /> : <ExpandMore fontSize="small" />}
                    </IconButton>
                    <Typography variant="caption" color="text.secondary">Channels are managed in Settings → Notifications.</Typography>
                </Stack>
                <Collapse in={notifOpen}>
                    <NotificationsPanel section="log" />
                </Collapse>
            </Box>
        </Box>
    );
}
