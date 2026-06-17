import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    Box, Grid, Paper, Typography, Stack, Chip, Button, Table, TableBody, TableCell, TableHead, TableRow,
    Select, MenuItem, ToggleButtonGroup, ToggleButton, Divider, Breadcrumbs, Link as MLink, Alert,
} from '@mui/material';
import { ArrowBack } from '@mui/icons-material';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { api } from '../api';
import { socket } from '../socket';
import { StatusChip, HealthBar, PriorityChip, fmtAgo, fmtNum } from './common';

export default function RigDetail() {
    const { id } = useParams();
    const nav = useNavigate();
    const [rig, setRig] = useState(null);
    const [err, setErr] = useState('');
    const [metric, setMetric] = useState('drawworks.hook_load');
    const [minutes, setMinutes] = useState(30);
    const [series, setSeries] = useState([]);

    const load = useCallback(() => {
        api.rig(id).then(setRig).catch((e) => setErr(e?.response?.data?.error || 'failed to load rig'));
    }, [id]);

    useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

    // Reflect live deltas for this rig immediately.
    useEffect(() => {
        const onUpdate = (row) => { if (row.rigId === id) setRig((r) => (r ? { ...r, ...row } : r)); };
        socket.on('fleet_update', onUpdate);
        return () => socket.off('fleet_update', onUpdate);
    }, [id]);

    const loadSeries = useCallback(() => {
        api.history(id, metric, minutes).then((d) =>
            setSeries(d.map((p) => ({ t: new Date(p.ts).getTime(), v: p.value })))).catch(() => setSeries([]));
    }, [id, metric, minutes]);
    useEffect(() => { loadSeries(); const t = setInterval(loadSeries, 5000); return () => clearInterval(t); }, [loadSeries]);

    const metricOptions = useMemo(() => {
        if (!rig?.groups) return [];
        return Object.entries(rig.groups).flatMap(([g, items]) => items.map((it) => ({ ...it, group: g })));
    }, [rig]);
    const selMeta = metricOptions.find((m) => m.metric === metric);

    if (err) return <Alert severity="error">{err} — <MLink sx={{ cursor: 'pointer' }} onClick={() => nav('/')}>back to fleet</MLink></Alert>;
    if (!rig) return <Typography color="text.secondary">Loading {id}…</Typography>;

    return (
        <Box>
            <Breadcrumbs sx={{ mb: 1 }}>
                <MLink sx={{ cursor: 'pointer' }} color="inherit" onClick={() => nav('/')}>Fleet</MLink>
                <Typography color="text.primary">{rig.name}</Typography>
            </Breadcrumbs>

            <Paper sx={{ p: 2, mb: 2 }}>
                <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Button startIcon={<ArrowBack />} onClick={() => nav('/')} size="small" variant="outlined">Fleet</Button>
                    <Box>
                        <Typography variant="h5" fontWeight={800}>{rig.name}</Typography>
                        <Typography variant="caption" color="text.secondary">{rig.rigId} · {rig.field} · {rig.section}</Typography>
                    </Box>
                    <StatusChip status={rig.status} size="medium" />
                    {rig.alarm?.highest && <PriorityChip priority={rig.alarm.highest} />}
                    <Box sx={{ flexGrow: 1 }} />
                    <Stack alignItems="flex-end">
                        <Typography variant="caption" color="text.secondary">Activity</Typography>
                        <Typography variant="body2" fontWeight={700}>{rig.activeActivity || '—'} · {rig.activeJob || 'no job'}</Typography>
                    </Stack>
                    <Divider orientation="vertical" flexItem />
                    <Stack alignItems="flex-end" sx={{ minWidth: 160 }}>
                        <Typography variant="caption" color="text.secondary">Data quality</Typography>
                        <HealthBar value={rig.healthScore} />
                        <Typography variant="caption" color="text.secondary">{rig.metricCount} tags · lag {rig.syncLagSec == null ? '—' : rig.syncLagSec + 's'} · {fmtAgo(rig.lastDataAt)}</Typography>
                    </Stack>
                </Stack>
            </Paper>

            {/* Key KPIs */}
            <Grid container spacing={1.5} mb={2}>
                {rig.keyMetrics?.map((k) => (
                    <Grid item xs={6} sm={4} md={2} key={k.metric}>
                        <Paper sx={{ p: 1.5, cursor: 'pointer', borderColor: metric === k.metric ? 'primary.main' : undefined }} onClick={() => setMetric(k.metric)}>
                            <Typography variant="caption" color="text.secondary" noWrap>{k.label}</Typography>
                            <Typography variant="h6" fontWeight={800}>{fmtNum(k.value)} <Typography component="span" variant="caption" color="text.secondary">{k.unit}</Typography></Typography>
                        </Paper>
                    </Grid>
                ))}
            </Grid>

            <Grid container spacing={2}>
                {/* Trend */}
                <Grid item xs={12} md={8}>
                    <Paper sx={{ p: 2 }}>
                        <Stack direction="row" spacing={1} alignItems="center" mb={1} flexWrap="wrap" useFlexGap>
                            <Typography variant="h6" sx={{ flexGrow: 1 }}>Trend</Typography>
                            <Select size="small" value={metric} onChange={(e) => setMetric(e.target.value)} sx={{ minWidth: 220 }}>
                                {metricOptions.map((m) => <MenuItem key={m.metric} value={m.metric}>{m.label} ({m.group})</MenuItem>)}
                            </Select>
                            <ToggleButtonGroup size="small" exclusive value={minutes} onChange={(_e, v) => v && setMinutes(v)}>
                                <ToggleButton value={5}>5m</ToggleButton>
                                <ToggleButton value={30}>30m</ToggleButton>
                                <ToggleButton value={180}>3h</ToggleButton>
                            </ToggleButtonGroup>
                        </Stack>
                        <Box sx={{ height: 320 }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart data={series} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                                    <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                                    <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} scale="time"
                                        tickFormatter={(t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        stroke="#64748b" fontSize={11} />
                                    <YAxis stroke="#64748b" fontSize={11} width={56} />
                                    <Tooltip labelFormatter={(t) => new Date(t).toLocaleTimeString()}
                                        contentStyle={{ background: '#0d1526', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
                                        formatter={(v) => [`${fmtNum(v, 2)} ${selMeta?.unit || ''}`, selMeta?.label || metric]} />
                                    <Line type="monotone" dataKey="v" stroke="#3ea6ff" dot={false} strokeWidth={2} isAnimationActive={false} />
                                </LineChart>
                            </ResponsiveContainer>
                        </Box>
                    </Paper>
                </Grid>

                {/* Deployment + alarms */}
                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 2, mb: 2 }}>
                        <Typography variant="subtitle2" color="text.secondary" gutterBottom>DEPLOYMENT</Typography>
                        <Stack spacing={0.5}>
                            <Row k="Stage-gate" v={rig.deployment?.gate || '—'} />
                            <Row k="Commissioning" v={rig.deployment?.commissioning || '—'} />
                            <Row k="Edge version" v={rig.deployment?.edge_version || '—'} />
                            <Row k="Adoption" v={`${rig.deployment?.adoption_pct ?? 0}%`} />
                            <Row k="Site ready" v={rig.deployment?.site_ready ? 'yes' : 'no'} />
                            <Row k="Security review" v={rig.deployment?.security_review ? 'passed' : 'pending'} />
                        </Stack>
                    </Paper>
                    <Paper sx={{ p: 2 }}>
                        <Typography variant="subtitle2" color="text.secondary" gutterBottom>RECENT ALARM EVENTS</Typography>
                        {rig.recentAlarms?.length ? rig.recentAlarms.slice(0, 8).map((a, i) => (
                            <Stack key={i} direction="row" spacing={1} alignItems="center" py={0.4}>
                                <PriorityChip priority={a.payload?.highest} />
                                <Typography variant="caption" sx={{ flexGrow: 1 }}>{a.payload?.active ?? 0} active · {a.payload?.unack ?? 0} unack</Typography>
                                <Typography variant="caption" color="text.secondary">{fmtAgo(a.ts)}</Typography>
                            </Stack>
                        )) : <Typography variant="caption" color="text.secondary">No alarm events.</Typography>}
                    </Paper>
                </Grid>

                {/* Equipment groups */}
                <Grid item xs={12} md={8}>
                    <Paper sx={{ p: 2 }}>
                        <Typography variant="h6" gutterBottom>Equipment & parameters</Typography>
                        <Grid container spacing={2}>
                            {Object.entries(rig.groups || {}).map(([group, items]) => (
                                <Grid item xs={12} sm={6} key={group}>
                                    <Typography variant="subtitle2" color="primary" gutterBottom>{group}</Typography>
                                    <Table size="small">
                                        <TableBody>
                                            {items.map((it) => (
                                                <TableRow key={it.metric}>
                                                    <TableCell sx={{ border: 0, py: 0.3 }}><Typography variant="body2">{it.label}</Typography></TableCell>
                                                    <TableCell sx={{ border: 0, py: 0.3 }} align="right">
                                                        <Typography variant="body2" fontWeight={700}>{fmtNum(it.value, 2)} <Typography component="span" variant="caption" color="text.secondary">{it.unit}</Typography></Typography>
                                                    </TableCell>
                                                </TableRow>
                                            ))}
                                        </TableBody>
                                    </Table>
                                </Grid>
                            ))}
                            {!Object.keys(rig.groups || {}).length && <Grid item xs={12}><Typography color="text.secondary">No telemetry received yet for this rig.</Typography></Grid>}
                        </Grid>
                    </Paper>
                </Grid>

                {/* Connections */}
                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 2 }}>
                        <Typography variant="h6" gutterBottom>Recent connections</Typography>
                        <Table size="small">
                            <TableHead><TableRow><TableCell>Joint</TableCell><TableCell align="right">Peak torque</TableCell><TableCell>Result</TableCell><TableCell align="right">When</TableCell></TableRow></TableHead>
                            <TableBody>
                                {rig.recentConnections?.length ? rig.recentConnections.map((c, i) => (
                                    <TableRow key={i}>
                                        <TableCell>{c.joint ?? '—'}</TableCell>
                                        <TableCell align="right">{fmtNum(c.peak_torque, 0)}</TableCell>
                                        <TableCell><Chip size="small" label={c.result || '—'} color={c.result === 'FAIL' ? 'error' : 'success'} variant="outlined" /></TableCell>
                                        <TableCell align="right"><Typography variant="caption" color="text.secondary">{fmtAgo(c.ts)}</Typography></TableCell>
                                    </TableRow>
                                )) : <TableRow><TableCell colSpan={4}><Typography variant="caption" color="text.secondary">No connection records.</Typography></TableCell></TableRow>}
                            </TableBody>
                        </Table>
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );
}

function Row({ k, v }) {
    return (
        <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">{k}</Typography>
            <Typography variant="body2" fontWeight={600} textTransform="capitalize">{v}</Typography>
        </Stack>
    );
}
