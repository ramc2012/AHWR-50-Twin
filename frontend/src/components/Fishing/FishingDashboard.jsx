import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Typography, Paper, Grid, TextField, Button, Alert, LinearProgress, Tooltip as MuiTooltip } from '@mui/material';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, AreaChart, Area } from 'recharts';
import { Anchor, Activity, ArrowDown, ArrowUp, Clock, RefreshCw } from 'lucide-react';
import { socket } from '../../socket';
import axios from '../../api';
import AnalogGauge from '../Common/AnalogGauge';

const FishingDashboard = () => {
    const [timeRange, setTimeRange] = useState('-12h');
    const [customRange, setCustomRange] = useState({ start: '', end: '' });
    const [isCustom, setIsCustom] = useState(false);
    const [showCustomDate, setShowCustomDate] = useState(false);

    // 1. Critical Hoisting Parameters
    const [hoisting, setHoisting] = useState({
        hookLoad: 0,        // tons
        stringWeight: 210,  // tons (Tare / Free String Weight) - USER INPUT
        slackOffWeight: 0,  // tons
        blockPosition: 0    // %
    });

    // 2. Depth & Speed
    const [depth, setDepth] = useState({
        bitDepth: 0,        // m, from drilling.bit_depth PLC tag
        fishTopDepth: 5150, // m - USER INPUT
        lineSpeed: 0        // m/min
    });

    // 3. Jarring
    const [jarring, setJarring] = useState({
        upImpacts: 12,
        downImpacts: 5,
        lastImpactLoad: 80 // tons
    });

    // 4. Pressure & Pumping
    const [pressure, setPressure] = useState({
        tbg: 2500, // psi
        csg: 500,  // psi
        pump: 2800 // psi
    });

    // 5. Torque
    const [rotation, setRotation] = useState({
        rpm: 0,
        torque: 0 // ft-lbs
    });

    const [graphData, setGraphData] = useState([]);
    const [alarms, setAlarms] = useState([]);

    const getRangeMs = useCallback((range) => {
        if (range === '-1m') return 60 * 1000;
        if (range === '-5m') return 5 * 60 * 1000;
        if (range === '-10m') return 10 * 60 * 1000;
        if (range === '-15m') return 15 * 60 * 1000;
        if (range === '-30m') return 30 * 60 * 1000;
        if (range === '-1h') return 60 * 60 * 1000;
        if (range === '-12h') return 12 * 60 * 60 * 1000;
        return 12 * 60 * 60 * 1000;
    }, []);

    const activeRangeLabel = useMemo(() => {
        if (isCustom && customRange.start && customRange.end) {
            return `${new Date(customRange.start).toLocaleString()} to ${new Date(customRange.end).toLocaleString()}`;
        }
        const labels = {
            '-1m': 'Last 1 minute',
            '-5m': 'Last 5 minutes',
            '-10m': 'Last 10 minutes',
            '-15m': 'Last 15 minutes',
            '-30m': 'Last 30 minutes',
            '-1h': 'Last 1 hour',
            '-12h': 'Last 12 hours'
        };
        return labels[timeRange] || 'Last 12 hours';
    }, [customRange.end, customRange.start, isCustom, timeRange]);

    const fetchHistory = useCallback(async (rangeOverride = null) => {
        try {
            const useCustom = rangeOverride?.start && rangeOverride?.end;
            const url = useCustom
                ? `/api/history?start=${new Date(rangeOverride.start).toISOString()}&stop=${new Date(rangeOverride.end).toISOString()}`
                : `/api/history?range=${timeRange}`;
            const res = await axios.get(url);
            setGraphData(Array.isArray(res.data) ? res.data.map(row => {
                const timestamp = Number(row.timestamp) || (row.time ? Date.parse(row.time) : NaN) || Date.now();
                const hookload = Number(row.hookload ?? row['drawworks.hook_load']) || 0;
                const bitDepth = Number(row.depth ?? row['drilling.bit_depth']) || 0;
                const torque = Number(row.torque ?? row['engine.torque'] ?? row['drilling.torque']) || 0;
                return {
                    ...row,
                    timestamp,
                    time: row.time || new Date(timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                    hookload,
                    depth: bitDepth,
                    overpull: Number(row.overpull) || Math.max(0, hookload - hoisting.stringWeight),
                    torque
                };
            }) : []);
        } catch (err) {
            console.error('Failed to fetch fishing history', err);
            setGraphData([]);
        }
    }, [hoisting.stringWeight, timeRange]);

    // Derived: Overpull
    const overpull = Math.max(0, hoisting.hookLoad - hoisting.stringWeight);
    const tensileLimit = 500; // tons (Pipe Limit)
    const overpullPercentage = Math.min(100, (overpull / (tensileLimit - hoisting.stringWeight)) * 100);

    // Socket Listener
    useEffect(() => {
        fetchHistory();
    }, [fetchHistory]);

    useEffect(() => {
        const handleSocketData = (data) => {
            if (data.drawworks) {
                setHoisting(prev => ({
                    ...prev,
                    hookLoad: Number(data.drawworks.hook_load) || 0,
                    blockPosition: Number(data.drawworks.block_position) || 0
                }));
            }
            if (data.engine) {
                setRotation(prev => ({
                    ...prev,
                    rpm: Number(data.engine.rpm) || 0,
                    torque: Number(data.engine.torque) || 0
                }));
            }
            if (data.mudpump) {
                setPressure(prev => ({
                    ...prev,
                    pump: Number(data.mudpump.pressure) || 0
                }));
            }
            if (data.drilling) {
                setDepth(prev => ({
                    ...prev,
                    bitDepth: Number(data.drilling.bit_depth) || 0
                }));
            }

            const now = new Date();
            const timestamp = now.getTime();

            // Update graph with live data
            setGraphData(prev => {
                const newData = [...prev];
                newData.push({
                    time: now.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                    timestamp,
                    hookload: Number(data.drawworks?.hook_load) || 0,
                    depth: Number(data.drilling?.bit_depth) || depth.bitDepth,
                    overpull: Math.max(0, (Number(data.drawworks?.hook_load) || 0) - hoisting.stringWeight),
                    torque: Number(data.engine?.torque) || 0
                });

                const cutoff = timestamp - getRangeMs(timeRange);
                const filtered = newData
                    .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0))
                    .filter(point => (point.timestamp || 0) >= cutoff);

                if (filtered.length > 2000) filtered.splice(0, filtered.length - 2000);
                return filtered;
            });
        };

        socket.on('rig_data', handleSocketData);
        return () => socket.off('rig_data', handleSocketData);
    }, [depth.bitDepth, getRangeMs, hoisting.stringWeight, timeRange]);

    useEffect(() => {
        if (!isCustom) fetchHistory();
    }, [fetchHistory, isCustom, timeRange]);

    // Safety Alarms Logic
    useEffect(() => {
        const newAlarms = [];
        if (overpull > 100) newAlarms.push({ id: 'overpull', msg: 'HIGH OVERPULL WARNING', severity: 'error' });
        if (pressure.pump > 4500) newAlarms.push({ id: 'pump', msg: 'PUMP OVERPRESSURE', severity: 'warning' });
        setAlarms(newAlarms);
    }, [overpull, pressure.pump]);

    const applyCustomRange = () => {
        if (!customRange.start || !customRange.end) return;
        const start = new Date(customRange.start).getTime();
        const end = new Date(customRange.end).getTime();
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
        setIsCustom(true);
        setShowCustomDate(false);
        fetchHistory({ start: customRange.start, end: customRange.end });
    };

    const handlePresetClick = (val) => {
        setIsCustom(false);
        setTimeRange(val);
        setCustomRange({ start: '', end: '' });
    };

    const activeWindow = useMemo(() => {
        if (isCustom && customRange.start && customRange.end) {
            const start = new Date(customRange.start).getTime();
            const end = new Date(customRange.end).getTime();
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
                return { start, end };
            }
        }
        const end = Date.now();
        return { start: end - getRangeMs(timeRange), end };
    }, [customRange.end, customRange.start, getRangeMs, isCustom, timeRange]);

    const chartData = useMemo(() => {
        return graphData
            .filter(point => {
                const ts = point.timestamp || (point.time ? Date.parse(point.time) : NaN);
                return Number.isFinite(ts) ? ts >= activeWindow.start && ts <= activeWindow.end : true;
            })
            .map(point => ({
                ...point,
                timestamp: point.timestamp || Date.now()
            }));
    }, [activeWindow.end, activeWindow.start, graphData]);


    const MetricBox = ({ label, value, unit, color = 'white', subLabel, subValue }) => (
        <Paper sx={{ p: 2, bgcolor: '#1e293b', border: '1px solid #334155', height: '100%' }}>
            <Typography variant="caption" sx={{ color: '#94a3b8', textTransform: 'uppercase' }}>{label}</Typography>
            <Typography variant="h4" sx={{ color: color, fontWeight: 'bold' }}>
                {value} <span style={{ fontSize: '0.5em', color: '#64748b' }}>{unit}</span>
            </Typography>
            {subLabel && (
                <Box sx={{ mt: 1, pt: 1, borderTop: '1px solid #334155', display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="caption" sx={{ color: '#94a3b8' }}>{subLabel}</Typography>
                    <Typography variant="body2" sx={{ color: 'white', fontWeight: 'bold' }}>{subValue}</Typography>
                </Box>
            )}
        </Paper>
    );

    return (
        <Box sx={{ p: 3, color: 'white' }}>
            {/* Header */}
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                    <Anchor size={32} color="#fbbf24" />
                    <Box>
                        <Typography variant="body2" sx={{ color: '#94a3b8' }}>Live Well Intervention Monitoring</Typography>
                    </Box>
                </Box>

                {/* Alarms Banner */}
                <Box sx={{ display: 'flex', gap: 2 }}>
                    {alarms.map(alarm => (
                        <Alert key={alarm.id} severity={alarm.severity} variant="filled" sx={{ fontWeight: 'bold' }}>
                            {alarm.msg}
                        </Alert>
                    ))}
                </Box>
            </Box>

            <Grid container spacing={3}>
                {/* --- LEFT COLUMN: CRITICAL HOISTING --- */}
                <Grid item xs={12} md={3}>
                    <Typography variant="subtitle1" sx={{ color: '#fbbf24', mb: 2, fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1 }}>
                        <ArrowUp size={18} /> Critical Hoisting (Primary)
                    </Typography>

                    <Grid container spacing={2}>
                        <Grid item xs={12}>
                            <MetricBox
                                label="Actual Hook Load"
                                value={hoisting.hookLoad.toFixed(1)}
                                unit="tons"
                                color="#38bdf8"
                                subLabel="String Weight (Tare)"
                                subValue={`${hoisting.stringWeight} tons`}
                            />
                        </Grid>
                        <Grid item xs={12}>
                            <Paper sx={{ p: 2, bgcolor: '#0f172a', border: '1px solid #ef4444' }}>
                                <Typography variant="caption" sx={{ color: '#ef4444', fontWeight: 'bold' }}>CALCULATED OVERPULL</Typography>
                                <Typography variant="h3" sx={{ color: '#ef4444', fontWeight: 'bold' }}>
                                    {overpull.toFixed(1)} <span style={{ fontSize: '0.4em' }}>tons</span>
                                </Typography>
                                <Box sx={{ mt: 2 }}>
                                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                                        <Typography variant="caption" sx={{ color: '#94a3b8' }}>Tensile Limit Utilized</Typography>
                                        <Typography variant="caption" sx={{ color: overpullPercentage > 80 ? '#ef4444' : '#fbbf24' }}>{overpullPercentage.toFixed(0)}%</Typography>
                                    </Box>
                                    <LinearProgress
                                        variant="determinate"
                                        value={overpullPercentage}
                                        sx={{ height: 10, borderRadius: 1, bgcolor: '#334155', '& .MuiLinearProgress-bar': { bgcolor: overpullPercentage > 80 ? '#ef4444' : '#fbbf24' } }}
                                    />
                                </Box>
                            </Paper>
                        </Grid>

                        <Grid item xs={12}>
                            <Box sx={{ p: 2, bgcolor: '#1e293b', borderRadius: 1 }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8' }}>SETTINGS</Typography>
                                <Grid container spacing={1} sx={{ mt: 1 }}>
                                    <Grid item xs={6}>
                                        <TextField
                                            label="String Wt (tons)"
                                            type="number"
                                            size="small"
                                            value={hoisting.stringWeight}
                                            onChange={(e) => setHoisting({ ...hoisting, stringWeight: Number(e.target.value) })}
                                            sx={{ bgcolor: '#0f172a', input: { color: 'white' }, label: { color: '#64748b' } }}
                                        />
                                    </Grid>
                                    <Grid item xs={6}>
                                        <TextField
                                            label="Tensile Limit"
                                            type="number"
                                            size="small"
                                            value={tensileLimit}
                                            disabled
                                            sx={{ bgcolor: '#0f172a', input: { color: 'white' }, label: { color: '#64748b' } }}
                                        />
                                    </Grid>
                                </Grid>
                            </Box>
                        </Grid>
                    </Grid>
                </Grid>

                {/* --- CENTER: GRAPHS & VISUALS --- */}
                <Grid item xs={12} md={6}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 1 }}>
                        <Typography variant="subtitle1" sx={{ color: '#fbbf24', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Activity size={18} /> Operation Analytics
                        </Typography>
                        <Typography variant="caption" sx={{ color: '#94a3b8' }}>
                            {activeRangeLabel}
                        </Typography>
                    </Box>

                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', mb: 2, flexWrap: 'wrap' }}>
                        <Box sx={{ position: 'relative' }}>
                            <MuiTooltip title="Custom range">
                                <Button
                                    variant="outlined"
                                    onClick={() => setShowCustomDate(!showCustomDate)}
                                    sx={{ color: 'white', borderColor: '#334155', height: '100%', bgcolor: '#1e293b', minWidth: '40px', px: 1 }}
                                >
                                    <Clock size={20} />
                                </Button>
                            </MuiTooltip>
                            {showCustomDate && (
                                <Paper sx={{ position: 'absolute', top: '100%', left: 0, mt: 1, p: 2, bgcolor: '#0f172a', border: '1px solid #334155', zIndex: 50, width: 'max-content' }}>
                                    <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                                        <Typography sx={{ color: '#94a3b8', fontSize: '0.875rem', fontWeight: 'bold' }}>CUSTOM RANGE</Typography>
                                        <Box
                                            component="input"
                                            type="datetime-local"
                                            value={customRange.start}
                                            onChange={(e) => setCustomRange(prev => ({ ...prev, start: e.target.value }))}
                                            sx={{ bgcolor: 'transparent', color: 'white', border: '1px solid #334155', borderRadius: '4px', p: '4px', colorScheme: 'dark' }}
                                        />
                                        <Box component="span" sx={{ color: '#94a3b8' }}>-</Box>
                                        <Box
                                            component="input"
                                            type="datetime-local"
                                            value={customRange.end}
                                            onChange={(e) => setCustomRange(prev => ({ ...prev, end: e.target.value }))}
                                            sx={{ bgcolor: 'transparent', color: 'white', border: '1px solid #334155', borderRadius: '4px', p: '4px', colorScheme: 'dark' }}
                                        />
                                        <Button variant="contained" size="small" onClick={applyCustomRange} sx={{ ml: 1 }}>Go</Button>
                                    </Box>
                                </Paper>
                            )}
                        </Box>

                        <Box sx={{ width: '1px', height: '24px', bgcolor: '#334155', mx: 1 }} />

                        {[
                            { label: '1m', val: '-1m' },
                            { label: '5m', val: '-5m' },
                            { label: '10m', val: '-10m' },
                            { label: '15m', val: '-15m' },
                            { label: '30m', val: '-30m' },
                            { label: '1h', val: '-1h' },
                            { label: '12h', val: '-12h' }
                        ].map((opt) => (
                            <Button
                                key={opt.val}
                                variant={!isCustom && timeRange === opt.val ? 'contained' : 'outlined'}
                                onClick={() => handlePresetClick(opt.val)}
                                size="small"
                                sx={{
                                    bgcolor: !isCustom && timeRange === opt.val ? '#38bdf8' : 'transparent',
                                    color: !isCustom && timeRange === opt.val ? '#0f172a' : '#94a3b8',
                                    borderColor: '#334155',
                                    minWidth: '40px',
                                    textTransform: 'none',
                                    fontWeight: 'bold'
                                }}
                            >
                                {opt.label}
                            </Button>
                        ))}

                        <Button
                            variant="outlined"
                            startIcon={<RefreshCw size={16} />}
                            onClick={fetchHistory}
                            sx={{ color: '#38bdf8', borderColor: '#334155', ml: 1 }}
                        >
                            Resync
                        </Button>
                    </Box>

                    <Paper sx={{ p: 2, bgcolor: '#1e293b', mb: 2, height: 300 }}>
                        <Typography variant="caption" sx={{ color: '#94a3b8' }}>WOH vs DEPTH (Trend)</Typography>
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={chartData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                <XAxis dataKey="time" stroke="#94a3b8" />
                                <YAxis yAxisId="left" stroke="#38bdf8" label={{ value: 'HKLD (tons)', angle: -90, position: 'insideLeft', fill: '#38bdf8' }} />
                                <YAxis yAxisId="right" orientation="right" stroke="#fbbf24" label={{ value: 'Depth (m)', angle: 90, position: 'insideRight', fill: '#fbbf24' }} />
                                <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155' }} />
                                <Legend />
                                <Line yAxisId="left" type="monotone" dataKey="hookload" stroke="#38bdf8" dot={false} strokeWidth={2} />
                                <Line yAxisId="right" type="monotone" dataKey="depth" stroke="#fbbf24" dot={false} strokeWidth={2} />
                            </LineChart>
                        </ResponsiveContainer>
                    </Paper>

                    <Paper sx={{ p: 2, bgcolor: '#1e293b', height: 250 }}>
                        <Typography variant="caption" sx={{ color: '#94a3b8' }}>OVERPULL HISTORY</Typography>
                        <ResponsiveContainer width="100%" height="100%">
                            <AreaChart data={chartData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                <XAxis dataKey="time" stroke="#94a3b8" />
                                <YAxis stroke="#ef4444" />
                                <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155' }} />
                                <Area type="monotone" dataKey="overpull" stroke="#ef4444" fill="#ef4444" fillOpacity={0.3} />
                            </AreaChart>
                        </ResponsiveContainer>
                    </Paper>
                </Grid>

                {/* --- RIGHT COLUMN: AUXILIARY PARAMETERS --- */}
                <Grid item xs={12} md={3}>
                    {/* Depth */}
                    <Typography variant="subtitle1" sx={{ color: '#fbbf24', mb: 2, fontWeight: 'bold' }}>Depth & Position</Typography>
                    <Grid container spacing={2} sx={{ mb: 3 }}>
                        <Grid item xs={6}>
                            <MetricBox label="Bit Depth" value={depth.bitDepth.toFixed(1)} unit="m" color="#22c55e" />
                        </Grid>
                        <Grid item xs={6}>
                            <MetricBox label="Fish Top" value={depth.fishTopDepth} unit="m" color="#fbbf24" />
                        </Grid>
                        <Grid item xs={12}>
                            <Box sx={{ p: 1.5, bgcolor: '#1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography variant="body2" sx={{ color: '#94a3b8' }}>Distance to Fish</Typography>
                                <Typography variant="h6" sx={{ color: 'white', fontWeight: 'bold' }}>
                                    {(depth.fishTopDepth - depth.bitDepth).toFixed(1)} m
                                </Typography>
                            </Box>
                        </Grid>
                    </Grid>

                    {/* Jarring */}
                    <Typography variant="subtitle1" sx={{ color: '#fbbf24', mb: 2, fontWeight: 'bold' }}>Jarring Ops</Typography>
                    <Box sx={{ display: 'flex', gap: 2, mb: 3 }}>
                        <Paper sx={{ flex: 1, p: 2, bgcolor: '#1e293b', textAlign: 'center' }}>
                            <ArrowUp size={24} color="#38bdf8" style={{ margin: 'auto' }} />
                            <Typography variant="h5" sx={{ fontWeight: 'bold', mt: 1 }}>{jarring.upImpacts}</Typography>
                            <Typography variant="caption" sx={{ color: '#94a3b8' }}>UP JARS</Typography>
                        </Paper>
                        <Paper sx={{ flex: 1, p: 2, bgcolor: '#1e293b', textAlign: 'center' }}>
                            <ArrowDown size={24} color="#fbbf24" style={{ margin: 'auto' }} />
                            <Typography variant="h5" sx={{ fontWeight: 'bold', mt: 1 }}>{jarring.downImpacts}</Typography>
                            <Typography variant="caption" sx={{ color: '#94a3b8' }}>DOWN JARS</Typography>
                        </Paper>
                    </Box>

                    {/* Pressure */}
                    <Typography variant="subtitle1" sx={{ color: '#fbbf24', mb: 2, fontWeight: 'bold' }}>Well Pressure</Typography>
                    <Grid container spacing={1}>
                        <Grid item xs={6}>
                            <MetricBox label="Pump Press" value={pressure.pump} unit="psi" color="#f472b6" />
                        </Grid>
                        <Grid item xs={6}>
                            <MetricBox label="Torque" value={rotation.torque.toFixed(0)} unit="ft-lbs" color="#a78bfa" />
                        </Grid>
                    </Grid>
                </Grid>
            </Grid>
        </Box>
    );
};

export default FishingDashboard;
