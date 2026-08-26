import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Box, Paper, Typography, Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
    TableSortLabel, Grid, Chip, Stack, Alert,
} from '@mui/material';
import { api } from '../api';
import { KpiCard, StatusChip, HealthBar, fmtAgo } from './common';

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

export default function DataQuality() {
    const nav = useNavigate();
    const [rows, setRows] = useState([]);
    const [err, setErr] = useState('');
    const [loading, setLoading] = useState(true);
    // Worst-first by default: lowest health score at the top (appendix fix).
    const { key: sortKey, dir: sortDir, onSort, sorted } = useTableSort('health', 'asc');

    const load = useCallback(() => {
        setErr('');
        api.dataQuality()
            .then((d) => setRows(Array.isArray(d) ? d : []))
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load data-quality view'); })
            .finally(() => setLoading(false));
    }, []);
    useEffect(() => { setLoading(true); load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

    const reporting = rows.filter((r) => r.lastDataAt);
    const avg = reporting.length ? Math.round(reporting.reduce((s, r) => s + (r.healthScore || 0), 0) / reporting.length) : 0;
    const stale = rows.filter((r) => r.staleFlag && !r.offline).length;
    const below = rows.filter((r) => r.lastDataAt && r.healthScore < 98).length;

    const view = sorted(rows, {
        health: (r) => r.healthScore ?? 0,
        lag: (r) => r.syncLagSec,
    });

    const openRig = (rigId) => nav(`/rigs/${rigId}?tab=trends`);

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Typography variant="h5" fontWeight={800} mb={2}>Data Quality Monitor</Typography>
            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}
            <Grid container spacing={2} mb={2}>
                <Grid item xs={6} md={3}><KpiCard label="Avg freshness score" value={avg} sub="target ≥ 98" color={avg >= 98 ? 'success.main' : 'warning.main'} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Reporting rigs" value={reporting.length} sub={`of ${rows.length}`} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Stale (lag > 30s)" value={stale} color={stale ? 'warning.main' : 'success.main'} /></Grid>
                <Grid item xs={6} md={3}><KpiCard label="Below 98 target" value={below} color={below ? 'warning.main' : 'success.main'} /></Grid>
            </Grid>

            <Paper sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <TableContainer sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                <TableCell>Rig</TableCell>
                                <TableCell>Status</TableCell>
                                <TableCell sx={{ minWidth: 150 }} sortDirection={sortKey === 'health' ? sortDir : false}>
                                    <TableSortLabel active={sortKey === 'health'} direction={sortKey === 'health' ? sortDir : 'asc'} onClick={() => onSort('health')}>Health score</TableSortLabel>
                                </TableCell>
                                <TableCell align="right">Tags present</TableCell>
                                <TableCell align="right" sortDirection={sortKey === 'lag' ? sortDir : false}>
                                    <TableSortLabel active={sortKey === 'lag'} direction={sortKey === 'lag' ? sortDir : 'desc'} onClick={() => onSort('lag')}>Sync lag</TableSortLabel>
                                </TableCell>
                                <TableCell>Flags</TableCell>
                                <TableCell align="right">Last data</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {view.map((r) => (
                                <TableRow key={r.rigId} hover role="button" tabIndex={0}
                                    aria-label={`Open ${r.name || r.rigId} trends`}
                                    onClick={() => openRig(r.rigId)}
                                    onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openRig(r.rigId); } }}
                                    sx={{ cursor: 'pointer', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}>
                                    <TableCell>
                                        <Typography variant="body2" fontWeight={700} sx={{ color: 'primary.main', '&:hover': { textDecoration: 'underline' } }}>{r.name}</Typography>
                                        <Typography variant="caption" color="text.secondary">{r.rigId}</Typography>
                                    </TableCell>
                                    <TableCell><StatusChip status={r.status} /></TableCell>
                                    <TableCell><HealthBar value={r.healthScore} /></TableCell>
                                    <TableCell align="right">
                                        {/* metricCount counts ALL distinct tags the rig reports (can exceed the
                                            standard set), expectedMetrics is the standard expected set — so a
                                            "131/27" fraction was misleading (live finding). */}
                                        <Typography variant="body2" color={r.metricCount < r.expectedMetrics ? 'warning.main' : 'text.primary'}>
                                            {r.status === 'pending' ? '—' : `${r.metricCount} tags`}
                                        </Typography>
                                        {r.status !== 'pending' && (
                                            <Typography variant="caption" color="text.secondary">{r.expectedMetrics} expected</Typography>
                                        )}
                                    </TableCell>
                                    <TableCell align="right"><Typography variant="body2" color={r.staleFlag ? 'warning.main' : 'text.secondary'}>{r.syncLagSec == null ? '—' : `${r.syncLagSec}s`}</Typography></TableCell>
                                    <TableCell>
                                        <Stack direction="row" spacing={0.5}>
                                            {r.offline && <Chip size="small" color="error" variant="outlined" label="offline" />}
                                            {r.staleFlag && !r.offline && <Chip size="small" color="warning" variant="outlined" label="stale" />}
                                            {r.status !== 'pending' && r.metricCount < r.expectedMetrics && !r.offline && <Chip size="small" color="warning" variant="outlined" label="missing tags" />}
                                            {r.status === 'online' && <Chip size="small" color="success" variant="outlined" label="healthy" />}
                                            {r.status === 'pending' && <Chip size="small" variant="outlined" label="not onboarded" />}
                                        </Stack>
                                    </TableCell>
                                    <TableCell align="right"><Typography variant="caption" color="text.secondary">{fmtAgo(r.lastDataAt)}</Typography></TableCell>
                                </TableRow>
                            ))}
                            {!loading && !rows.length && (
                                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 5, color: 'text.secondary' }}>No rigs reporting.</TableCell></TableRow>
                            )}
                            {loading && !rows.length && (
                                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 5, color: 'text.secondary' }}>Loading data-quality view…</TableCell></TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>
        </Box>
    );
}
