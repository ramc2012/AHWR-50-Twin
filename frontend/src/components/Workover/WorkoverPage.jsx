import React, { useState, useEffect, useMemo } from 'react';
import {
    Box, Typography, Paper, Grid, Chip, Table, TableBody, TableCell,
    TableContainer, TableHead, TableRow
} from '@mui/material';
import {
    LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
    ReferenceLine, Legend
} from 'recharts';
import { Gauge as GaugeIcon, Wrench, ListChecks } from 'lucide-react';
import axios from '../../api';
import { socket } from '../../socket';
import AnalogGauge from '../Common/AnalogGauge';
import GaugeCard from '../Common/GaugeCard';
import { formatClock } from '../../utils/format';

const headSx = { color: '#94a3b8', fontWeight: 'bold', borderColor: '#334155', whiteSpace: 'nowrap' };
const cellSx = { color: 'white', borderColor: '#1e293b' };

// Configured alarm hi-limits (labelled on the gauges). Tubing hi 200, casing hi 150.
const DEFAULT_LIMITS = { tubing_pressure: 200, casing_pressure: 150, wellhead_pressure: 200 };

function PressureGauge({ label, value, max, hiLimit }) {
    const v = Number(value) || 0;
    // Critical band ratio = hi-limit position on the dial.
    const critical = hiLimit && max ? Math.min(hiLimit / max, 0.99) : 0.8;
    return (
        <GaugeCard
            sx={{ minHeight: { xs: 280, md: 330 } }}
            footer={hiLimit != null && (
                <Typography variant="caption" sx={{ color: '#94a3b8', mt: 0.5 }}>
                    HI limit: <span style={{ color: '#ef4444', fontWeight: 'bold' }}>{hiLimit} bar</span>
                </Typography>
            )}
        >
            <AnalogGauge
                value={v}
                min={0}
                max={max}
                label={label}
                unit="bar"
                size="fill"
                criticalLevel={critical}
                warnLevel={critical * 0.85}
            />
        </GaugeCard>
    );
}

function TorqueTurnGraph({ tt }) {
    const active = tt?.active;
    const samples = tt?.samples || [];
    const limits = tt?.limits || {};
    const unit = limits.unit || 'daN·m';

    const data = useMemo(() => samples.map((s) => ({
        t: typeof s.t === 'number' ? s.t : Number(s.t) || 0,
        torque: s.torque,
    })), [samples]);

    return (
        <Paper sx={{ p: 3, bgcolor: '#1e293b', border: '1px solid #334155' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Wrench size={18} /> Make-up Torque vs Time
                </Typography>
                <Chip
                    label={active ? 'MAKE-UP IN PROGRESS' : 'IDLE'}
                    size="small"
                    sx={{
                        bgcolor: active ? 'rgba(74,222,128,0.15)' : '#0f172a',
                        color: active ? '#4ade80' : '#64748b',
                        fontWeight: 'bold', border: `1px solid ${active ? '#4ade80' : '#334155'}`,
                    }}
                />
            </Box>
            {active && data.length > 0 ? (
                <ResponsiveContainer width="100%" height={300}>
                    <LineChart data={data}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                        <XAxis dataKey="t" stroke="#94a3b8" fontSize={12}
                            label={{ value: 'Time (s)', position: 'insideBottom', offset: -4, fill: '#94a3b8', fontSize: 12 }} />
                        <YAxis stroke="#94a3b8" fontSize={12}
                            label={{ value: unit, angle: -90, position: 'insideLeft', fill: '#94a3b8', fontSize: 12 }} />
                        <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155' }} />
                        <Legend />
                        {limits.minTorque != null && (
                            <ReferenceLine y={limits.minTorque} stroke="#f59e0b" strokeDasharray="6 4"
                                label={{ value: `Min ${limits.minTorque}`, fill: '#f59e0b', fontSize: 11, position: 'insideTopLeft' }} />
                        )}
                        {limits.maxTorque != null && (
                            <ReferenceLine y={limits.maxTorque} stroke="#ef4444" strokeDasharray="6 4"
                                label={{ value: `Max ${limits.maxTorque}`, fill: '#ef4444', fontSize: 11, position: 'insideTopLeft' }} />
                        )}
                        {limits.dumpTorque != null && (
                            <ReferenceLine y={limits.dumpTorque} stroke="#38bdf8" strokeDasharray="2 4"
                                label={{ value: `Dump ${limits.dumpTorque}`, fill: '#38bdf8', fontSize: 11, position: 'insideBottomLeft' }} />
                        )}
                        <Line type="monotone" dataKey="torque" name={`Torque (${unit})`} stroke="#38bdf8" strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                </ResponsiveContainer>
            ) : (
                <Box sx={{ height: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#64748b', gap: 1 }}>
                    <Wrench size={40} />
                    <Typography variant="body1">No make-up in progress</Typography>
                </Box>
            )}
        </Paper>
    );
}

export default function WorkoverPage() {
    const [wellhead, setWellhead] = useState({ tubing_pressure: 0, casing_pressure: 0, wellhead_pressure: 0 });
    const [tt, setTt] = useState({ active: false, samples: [], limits: {} });
    const [conn, setConn] = useState({ tally: { run: 0, pass: 0, fail: 0 }, limits: {}, jointCounter: 0, records: [] });
    const [limits, setLimits] = useState(DEFAULT_LIMITS);

    const loadConnections = () => {
        axios.get('/api/connections')
            .then((res) => setConn((prev) => ({ ...prev, ...res.data })))
            .catch((err) => console.error('Failed to load connections:', err));
    };

    useEffect(() => {
        // Seed from REST.
        axios.get('/api/rig/latest')
            .then((res) => { if (res.data?.wellhead) setWellhead((p) => ({ ...p, ...res.data.wellhead })); })
            .catch(() => {});
        axios.get('/api/torqueturn/current')
            .then((res) => { if (res.data) setTt(res.data); })
            .catch((err) => console.error('Failed to load torque-turn:', err));
        loadConnections();
        // Read configured pressure hi-limits where available.
        axios.get('/api/alarms/config')
            .then((res) => {
                const cfg = res.data || {};
                const next = { ...DEFAULT_LIMITS };
                // Config may be keyed by dataKey with hi/hihi thresholds.
                const pick = (k) => cfg[k]?.hi ?? cfg[k]?.hihi ?? cfg[k]?.limit;
                ['tubing_pressure', 'casing_pressure', 'wellhead_pressure'].forEach((k) => {
                    const v = pick(k);
                    if (typeof v === 'number') next[k] = v;
                });
                setLimits(next);
            })
            .catch(() => { /* fall back to labelled defaults */ });

        // Live wellhead + torque-turn from rig_data.
        const handleRig = (data) => {
            if (data?.wellhead) setWellhead((p) => ({ ...p, ...data.wellhead }));
            if (data?._torqueturn) setTt(data._torqueturn);
        };
        socket.on('rig_data', handleRig);

        // Prepend new connections live.
        const handleConnection = (rec) => {
            if (!rec) return;
            setConn((prev) => {
                const tally = { ...prev.tally };
                tally.run = (tally.run || 0) + 1;
                if (rec.result === 'PASS') tally.pass = (tally.pass || 0) + 1;
                if (rec.result === 'FAIL') tally.fail = (tally.fail || 0) + 1;
                return {
                    ...prev,
                    tally,
                    jointCounter: rec.joint ?? prev.jointCounter,
                    records: [rec, ...(prev.records || [])].slice(0, 100),
                };
            });
        };
        socket.on('connection_made', handleConnection);

        return () => {
            socket.off('rig_data', handleRig);
            socket.off('connection_made', handleConnection);
        };
    }, []);

    const records = conn.records || [];
    const tally = conn.tally || { run: 0, pass: 0, fail: 0 };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Typography variant="h6" sx={{ fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
                <GaugeIcon size={22} /> Workover — Pressures & Torque-Turn
            </Typography>

            {/* Wellhead pressures */}
            <Paper sx={{ p: 3, bgcolor: '#1e293b', border: '1px solid #334155' }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8', mb: 2 }}>
                    Wellhead Pressures
                </Typography>
                <Grid container spacing={2} justifyContent="space-around">
                    <Grid item xs={12} sm={4} sx={{ display: 'flex', justifyContent: 'center' }}>
                        <PressureGauge label="Tubing" value={wellhead.tubing_pressure} max={250} hiLimit={limits.tubing_pressure} />
                    </Grid>
                    <Grid item xs={12} sm={4} sx={{ display: 'flex', justifyContent: 'center' }}>
                        <PressureGauge label="Casing" value={wellhead.casing_pressure} max={200} hiLimit={limits.casing_pressure} />
                    </Grid>
                    <Grid item xs={12} sm={4} sx={{ display: 'flex', justifyContent: 'center' }}>
                        <PressureGauge label="Wellhead" value={wellhead.wellhead_pressure} max={250} hiLimit={limits.wellhead_pressure} />
                    </Grid>
                </Grid>
            </Paper>

            {/* Torque-turn graph */}
            <TorqueTurnGraph tt={tt} />

            {/* Connections tally + table */}
            <Paper sx={{ bgcolor: '#1e293b', border: '1px solid #334155' }}>
                <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
                        <ListChecks size={18} /> Connections
                    </Typography>
                    <Box sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                        <TallyChip label="Joint #" value={conn.jointCounter ?? 0} color="#38bdf8" />
                        <TallyChip label="Run" value={tally.run ?? 0} color="#94a3b8" />
                        <TallyChip label="Pass" value={tally.pass ?? 0} color="#4ade80" />
                        <TallyChip label="Fail" value={tally.fail ?? 0} color="#ef4444" />
                    </Box>
                </Box>
                <TableContainer>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell sx={headSx}>Joint #</TableCell>
                                <TableCell sx={headSx}>Peak Torque</TableCell>
                                <TableCell sx={headSx}>Result</TableCell>
                                <TableCell sx={headSx}>Duration</TableCell>
                                <TableCell sx={headSx}>Time</TableCell>
                                <TableCell sx={headSx}>Activity</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {records.map((r, i) => {
                                const pass = r.result === 'PASS';
                                const c = pass ? '#4ade80' : '#ef4444';
                                return (
                                    <TableRow key={`${r.ts}-${r.joint}-${i}`} hover>
                                        <TableCell sx={cellSx}>{r.joint}</TableCell>
                                        <TableCell sx={cellSx}>{r.peakTorque} <span style={{ color: '#64748b' }}>{r.unit}</span></TableCell>
                                        <TableCell sx={cellSx}>
                                            <Chip label={r.result} size="small"
                                                sx={{ bgcolor: `${c}22`, color: c, fontWeight: 'bold', height: 22 }} />
                                        </TableCell>
                                        <TableCell sx={cellSx}>{r.durationSec != null ? `${r.durationSec}s` : '--'}</TableCell>
                                        <TableCell sx={cellSx}>{formatClock(r.ts)}</TableCell>
                                        <TableCell sx={cellSx}>{r.activity || '--'}</TableCell>
                                    </TableRow>
                                );
                            })}
                            {records.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={6} align="center" sx={{ color: '#94a3b8', py: 4, borderColor: '#1e293b' }}>
                                        No connections recorded.
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>
        </Box>
    );
}

function TallyChip({ label, value, color }) {
    return (
        <Box sx={{ px: 2, py: 0.5, bgcolor: '#0f172a', borderRadius: 1, border: `1px solid ${color}`, textAlign: 'center', minWidth: 70 }}>
            <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', lineHeight: 1 }}>{label}</Typography>
            <Typography variant="h6" sx={{ color, fontWeight: 'bold', lineHeight: 1.3 }}>{value}</Typography>
        </Box>
    );
}
