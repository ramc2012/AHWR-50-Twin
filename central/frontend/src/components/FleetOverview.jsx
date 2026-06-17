import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    Box, Grid, Paper, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
    Typography, Stack, ToggleButton, ToggleButtonGroup, TextField, InputAdornment, Chip,
} from '@mui/material';
import { Search, SignalCellularAlt, NotificationsActive, FactCheck, Dvr } from '@mui/icons-material';
import { useFleet } from '../context/FleetContext';
import { KpiCard, StatusChip, HealthBar, PriorityChip, fmtAgo } from './common';
import FleetMap from './FleetMap';

export default function FleetOverview() {
    const { fleet, summary } = useFleet();
    const nav = useNavigate();
    const [filter, setFilter] = useState('all');
    const [q, setQ] = useState('');
    const s = summary || {};

    const rows = useMemo(() => fleet.filter((r) => {
        if (filter !== 'all' && r.status !== filter) return false;
        if (q && !(`${r.name} ${r.rigId} ${r.activeJob || ''}`.toLowerCase().includes(q.toLowerCase()))) return false;
        return true;
    }), [fleet, filter, q]);

    return (
        <Box>
            <Grid container spacing={2} mb={2}>
                <Grid item xs={6} sm={4} md={2}><KpiCard label="Rigs online" value={s.online ?? 0} sub={`of ${s.total ?? 0} in fleet`} color="success.main" icon={<SignalCellularAlt fontSize="small" color="success" />} /></Grid>
                <Grid item xs={6} sm={4} md={2}><KpiCard label="Degraded" value={s.degraded ?? 0} sub="missing tags / lag" color="warning.main" /></Grid>
                <Grid item xs={6} sm={4} md={2}><KpiCard label="Offline" value={s.offline ?? 0} sub="no recent data" color="error.main" /></Grid>
                <Grid item xs={6} sm={4} md={2}><KpiCard label="Active alarms" value={s.alarmsActive ?? 0} sub={`${s.alarmsP1 ?? 0} priority-1`} color={s.alarmsP1 ? 'error.main' : 'text.primary'} icon={<NotificationsActive fontSize="small" color={s.alarmsP1 ? 'error' : 'disabled'} />} /></Grid>
                <Grid item xs={6} sm={4} md={2}><KpiCard label="Avg health" value={s.avgHealth ?? 0} sub="data-quality score" icon={<FactCheck fontSize="small" color="info" />} /></Grid>
                <Grid item xs={6} sm={4} md={2}><KpiCard label="Reporting" value={`${s.rigsReporting ?? 0}`} sub="streaming now" icon={<Dvr fontSize="small" color="primary" />} /></Grid>
            </Grid>

            <Grid container spacing={2}>
                <Grid item xs={12} md={7}>
                    <FleetMap rigs={fleet} />
                </Grid>
                <Grid item xs={12} md={5}>
                    <Paper sx={{ p: 2, height: '100%' }}>
                        <Typography variant="subtitle2" color="text.secondary" gutterBottom>ROLLOUT BY STAGE-GATE</Typography>
                        <Stack spacing={1.2} mt={1}>
                            {[
                                ['Online & reporting', s.online ?? 0, 'success.main'],
                                ['Degraded', s.degraded ?? 0, 'warning.main'],
                                ['Stale', s.stale ?? 0, 'warning.main'],
                                ['Offline', s.offline ?? 0, 'error.main'],
                                ['Pending onboarding', s.pending ?? 0, 'text.secondary'],
                            ].map(([label, val, color]) => {
                                const pct = s.total ? Math.round((val / s.total) * 100) : 0;
                                return (
                                    <Box key={label}>
                                        <Stack direction="row" justifyContent="space-between">
                                            <Typography variant="body2">{label}</Typography>
                                            <Typography variant="body2" color="text.secondary">{val} · {pct}%</Typography>
                                        </Stack>
                                        <Box sx={{ height: 8, borderRadius: 4, bgcolor: 'rgba(255,255,255,0.06)', mt: 0.5, overflow: 'hidden' }}>
                                            <Box sx={{ width: `${pct}%`, height: '100%', bgcolor: color }} />
                                        </Box>
                                    </Box>
                                );
                            })}
                        </Stack>
                        <Typography variant="caption" color="text.secondary" display="block" mt={2}>
                            Streaming rigs publish 100 channels at 1 Hz; central latency target &lt; 30 s.
                        </Typography>
                    </Paper>
                </Grid>
            </Grid>

            <Paper sx={{ mt: 2 }}>
                <Stack direction="row" spacing={2} alignItems="center" sx={{ p: 2, flexWrap: 'wrap' }} useFlexGap>
                    <Typography variant="h6" sx={{ flexGrow: 1 }}>Fleet — {rows.length} rig{rows.length !== 1 ? 's' : ''}</Typography>
                    <TextField size="small" placeholder="Search rig / job" value={q} onChange={(e) => setQ(e.target.value)}
                        InputProps={{ startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> }} />
                    <ToggleButtonGroup size="small" exclusive value={filter} onChange={(_e, v) => v && setFilter(v)}>
                        <ToggleButton value="all">All</ToggleButton>
                        <ToggleButton value="online">Online</ToggleButton>
                        <ToggleButton value="degraded">Degraded</ToggleButton>
                        <ToggleButton value="offline">Offline</ToggleButton>
                        <ToggleButton value="pending">Pending</ToggleButton>
                    </ToggleButtonGroup>
                </Stack>
                <TableContainer>
                    <Table size="small" stickyHeader>
                        <TableHead>
                            <TableRow>
                                <TableCell>Rig</TableCell>
                                <TableCell>Status</TableCell>
                                <TableCell>Activity / Job</TableCell>
                                <TableCell>Alarms</TableCell>
                                <TableCell sx={{ minWidth: 140 }}>Data quality</TableCell>
                                <TableCell align="right">Sync lag</TableCell>
                                <TableCell align="right">Last data</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {rows.map((r) => (
                                <TableRow key={r.rigId} hover sx={{ cursor: 'pointer' }} onClick={() => nav(`/rigs/${r.rigId}`)}>
                                    <TableCell>
                                        <Typography variant="body2" fontWeight={700}>{r.name}</Typography>
                                        <Typography variant="caption" color="text.secondary">{r.rigId}</Typography>
                                    </TableCell>
                                    <TableCell><StatusChip status={r.status} /></TableCell>
                                    <TableCell>
                                        <Typography variant="body2">{r.activeActivity || '—'}</Typography>
                                        <Typography variant="caption" color="text.secondary">{r.activeJob || ''}</Typography>
                                    </TableCell>
                                    <TableCell>
                                        <Stack direction="row" spacing={0.5} alignItems="center">
                                            {r.alarm?.highest ? <PriorityChip priority={r.alarm.highest} /> : <Typography variant="caption" color="text.secondary">none</Typography>}
                                            {r.alarm?.active > 0 && <Chip size="small" variant="outlined" label={r.alarm.active} />}
                                        </Stack>
                                    </TableCell>
                                    <TableCell><HealthBar value={r.healthScore} /></TableCell>
                                    <TableCell align="right">
                                        <Typography variant="body2" color={r.syncLagSec > 30 ? 'warning.main' : 'text.secondary'}>
                                            {r.syncLagSec == null ? '—' : `${r.syncLagSec}s`}
                                        </Typography>
                                    </TableCell>
                                    <TableCell align="right"><Typography variant="caption" color="text.secondary">{fmtAgo(r.lastDataAt)}</Typography></TableCell>
                                </TableRow>
                            ))}
                            {!rows.length && <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>No rigs match the filter.</TableCell></TableRow>}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>
        </Box>
    );
}
