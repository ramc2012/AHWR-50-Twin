import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
    Box, Paper, Grid, Typography, Chip, Stack, Alert, Skeleton,
    Table, TableBody, TableCell, TableHead, TableRow, TableContainer,
} from '@mui/material';
import { api } from '../../../api';
import { useRigData } from '../../../context/RigDataContext';
import { PanelHead, freshness } from '../hmi';

// =====================================================================
// Per-rig MAINTENANCE panel — remote HMI mirror (proposal §6.1).
// READ-ONLY mirror of the central maintenance records filtered to this rig.
// No add/edit/advance actions: central edits live on the fleet Maintenance page.
// =====================================================================

const TYPE_COLOR = { PM: 'info', calibration: 'secondary', breakdown: 'error', inspection: 'default' };
const STATUS_COLOR = { open: 'warning', in_progress: 'info', done: 'success', overdue: 'error' };

const FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'open', label: 'Open' },
    { key: 'in_progress', label: 'In progress' },
    { key: 'done', label: 'Done' },
    { key: 'overdue', label: 'Overdue' },
];

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString() : '—');
const fmtAgo = (ts) => {
    if (!ts) return '—';
    const s = Math.max(0, Math.round((Date.now() - new Date(ts).getTime()) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
};

// An "effective" overdue check: explicit overdue status OR an open/in-progress item past its due date.
const isOverdue = (r) => {
    if (r?.status === 'overdue') return true;
    if ((r?.status === 'open' || r?.status === 'in_progress') && r?.due_date) {
        const due = new Date(r.due_date);
        if (!Number.isNaN(due.getTime())) return due.getTime() < Date.now();
    }
    return false;
};

function KpiTile({ label, value, color }) {
    return (
        <Paper sx={{ p: 1.75, height: '100%' }}>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }} noWrap>
                {label}
            </Typography>
            <Typography variant="h4" sx={{ fontWeight: 800, color: color || 'text.primary', lineHeight: 1.15, mt: 0.25 }}>
                {value}
            </Typography>
        </Paper>
    );
}

export default function RigMaintenancePanel({ rigId, rig }) {
    const { data } = useRigData();
    const fresh = freshness(data?._meta);

    const [rows, setRows] = useState([]);
    const [err, setErr] = useState('');
    const [loading, setLoading] = useState(true);
    const [filter, setFilter] = useState('all');

    const load = useCallback(() => {
        if (!rigId) return;
        setErr('');
        api.maintenance({ rigId })
            .then((list) => setRows(Array.isArray(list) ? list : []))
            .catch((e) => {
                if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load maintenance records');
            })
            .finally(() => setLoading(false));
    }, [rigId]);

    useEffect(() => {
        setLoading(true);
        load();
        const t = setInterval(load, 15000);
        return () => clearInterval(t);
    }, [load]);

    const kpis = useMemo(() => {
        const total = rows.length;
        const openCount = rows.filter((r) => r.status === 'open' || r.status === 'in_progress').length;
        const overdue = rows.filter(isOverdue).length;
        const pmCount = rows.filter((r) => r.type === 'PM').length;
        return { total, openCount, overdue, pmCount };
    }, [rows]);

    const visible = useMemo(() => {
        if (filter === 'all') return rows;
        if (filter === 'overdue') return rows.filter(isOverdue);
        return rows.filter((r) => r.status === filter);
    }, [rows, filter]);

    const counts = useMemo(() => ({
        all: rows.length,
        open: rows.filter((r) => r.status === 'open').length,
        in_progress: rows.filter((r) => r.status === 'in_progress').length,
        done: rows.filter((r) => r.status === 'done').length,
        overdue: rows.filter(isOverdue).length,
    }), [rows]);

    return (
        <Paper sx={{ p: 2 }}>
            <PanelHead
                title="Maintenance & Reliability"
                right={
                    <Stack direction="row" alignItems="center" spacing={1}>
                        <Chip
                            size="small"
                            label={fresh.text}
                            sx={{ bgcolor: fresh.color + '22', color: fresh.color, border: `1px solid ${fresh.color}55`, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4 }}
                        />
                        <Chip size="small" variant="outlined" label="read-only mirror" sx={{ color: 'text.secondary' }} />
                    </Stack>
                }
            />

            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
                {(rig?.name || rigId || '—')} · records mirrored from the central maintenance log. Edits happen on the fleet Maintenance page.
            </Typography>

            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}

            <Grid container spacing={1.5} sx={{ mb: 2 }}>
                <Grid item xs={6} md={3}>
                    <KpiTile label="Total records" value={loading && !rows.length ? <Skeleton width={40} /> : kpis.total} />
                </Grid>
                <Grid item xs={6} md={3}>
                    <KpiTile label="Open / in-progress" value={loading && !rows.length ? <Skeleton width={40} /> : kpis.openCount} color={kpis.openCount ? 'info.main' : 'text.primary'} />
                </Grid>
                <Grid item xs={6} md={3}>
                    <KpiTile label="Overdue" value={loading && !rows.length ? <Skeleton width={40} /> : kpis.overdue} color={kpis.overdue ? 'error.main' : 'success.main'} />
                </Grid>
                <Grid item xs={6} md={3}>
                    <KpiTile label="PM records" value={loading && !rows.length ? <Skeleton width={40} /> : kpis.pmCount} />
                </Grid>
            </Grid>

            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
                {FILTERS.map((f) => {
                    const active = filter === f.key;
                    return (
                        <Chip
                            key={f.key}
                            size="small"
                            label={`${f.label} (${counts[f.key] ?? 0})`}
                            onClick={() => setFilter(f.key)}
                            color={active ? 'primary' : 'default'}
                            variant={active ? 'filled' : 'outlined'}
                            sx={{ fontWeight: active ? 700 : 500 }}
                        />
                    );
                })}
            </Stack>

            <TableContainer sx={{ maxHeight: 520 }}>
                <Table size="small" stickyHeader>
                    <TableHead>
                        <TableRow>
                            <TableCell>Type</TableCell>
                            <TableCell>Title</TableCell>
                            <TableCell>Status</TableCell>
                            <TableCell align="right">Due</TableCell>
                            <TableCell align="right">Performed</TableCell>
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {visible.map((r) => {
                            const overdue = isOverdue(r);
                            const statusKey = overdue && r.status !== 'overdue' ? 'overdue' : r.status;
                            return (
                                <TableRow key={r.id ?? `${r.type}-${r.title}-${r.due_date}`} hover>
                                    <TableCell>
                                        <Chip size="small" variant="outlined" color={TYPE_COLOR[r.type] || 'default'} label={r.type || '—'} />
                                    </TableCell>
                                    <TableCell>
                                        <Typography variant="body2">{r.title || '—'}</Typography>
                                        {r.outcome && <Typography variant="caption" color="text.secondary" display="block">{r.outcome}</Typography>}
                                        {r.notes && <Typography variant="caption" color="text.secondary" display="block">{r.notes}</Typography>}
                                    </TableCell>
                                    <TableCell>
                                        <Chip
                                            size="small"
                                            color={STATUS_COLOR[statusKey] || 'default'}
                                            variant={statusKey === 'done' ? 'filled' : 'outlined'}
                                            label={(statusKey || 'unknown').replace('_', ' ')}
                                        />
                                    </TableCell>
                                    <TableCell align="right">
                                        <Typography variant="caption" color={overdue ? 'error.main' : 'text.secondary'} fontWeight={overdue ? 700 : 400}>
                                            {fmtDate(r.due_date)}
                                        </Typography>
                                    </TableCell>
                                    <TableCell align="right">
                                        <Typography variant="caption" color="text.secondary">{fmtAgo(r.performed_at)}</Typography>
                                    </TableCell>
                                </TableRow>
                            );
                        })}

                        {!loading && !visible.length && (
                            <TableRow>
                                <TableCell colSpan={5} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                                    {filter === 'all' ? 'No maintenance records for this rig.' : `No ${FILTERS.find((f) => f.key === filter)?.label.toLowerCase() || filter} records.`}
                                </TableCell>
                            </TableRow>
                        )}
                        {loading && !rows.length && (
                            <TableRow>
                                <TableCell colSpan={5} align="center" sx={{ py: 5, color: 'text.secondary' }}>Loading maintenance records…</TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </TableContainer>
        </Paper>
    );
}
