import React, { useState, useEffect } from 'react';
import { Box, Typography, Paper, Grid, MenuItem, Select, FormControl, Button, FormGroup, ListSubheader } from '@mui/material';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import io from 'socket.io-client';
import axios from 'axios';
import { Clock } from 'lucide-react';

const socket = io('/');

const AVAILABLE_METRICS = {
    drilling: ['hook_load', 'wob', 'bit_depth', 'hole_depth', 'rop', 'rpm', 'torque', 'delta_torque'],
    mudpump: ['spm', 'pressure', 'total_spm', 'flow_in', 'flow_out_percentage'],
    fluid: ['total_tank_volume', 'tank_gain_loss', 'trip_tank'],
    cat_engine: ['rpm', 'load', 'coolant_temp', 'fuel_pressure', 'oil_pressure', 'battery_voltage', 'fuel_rate'],
    htd: ['rpm', 'torque', 'inclination', 'vertical_speed'],
    hpu: ['aux_pressure', 'discharge_pressure', 'oil_temp', 'oil_level'],
    pct: ['makeup_torque', 'last_makeup_torque', 'clamp_up_pressure', 'clamp_low_pressure'],
    cwk: ['clamp_pressure', 'clamp_force'],
    acs: ['block_position', 'crownsaver', 'floorsaver', 'bottomsaver', 'upper_tag', 'lower_tag']
};

const ALL_METRICS = Object.entries(AVAILABLE_METRICS).flatMap(([category, fields]) =>
    fields.map(field => ({
        value: `${category}.${field}`,
        label: `${category.toUpperCase()} - ${field.replace(/_/g, ' ')}`,
        shortLabel: field.replace(/_/g, ' ')
    }))
);

const DEFAULT_TRACKS = [
    {
        left: { metric: 'cat_engine.rpm', min: 0, max: 2000 },
        right: { metric: 'drilling.hook_load', min: 0, max: 500 }
    },
    {
        left: { metric: 'mudpump.pressure', min: 0, max: 500 },
        right: { metric: 'mudpump.spm', min: 0, max: 200 }
    },
    {
        left: { metric: 'cat_engine.coolant_temp', min: 0, max: 120 },
        right: { metric: 'cat_engine.oil_pressure', min: 0, max: 10 }
    }
];

export default function EdrDashboard() {
    const [data, setData] = useState([]);
    const [tracks, setTracks] = useState(DEFAULT_TRACKS);
    const [timeRange, setTimeRange] = useState('-15m');
    const [customRange, setCustomRange] = useState({ start: '', end: '' });
    const [isCustom, setIsCustom] = useState(false);
    const [showCustomDate, setShowCustomDate] = useState(false);

    // How many ms worth of data to keep for each range
    const getRangeMs = (range) => {
        if (range === '-1m') return 60 * 1000;
        if (range === '-5m') return 5 * 60 * 1000;
        if (range === '-10m') return 10 * 60 * 1000;
        if (range === '-15m') return 15 * 60 * 1000;
        if (range === '-1h') return 60 * 60 * 1000;
        if (range === '-12h') return 12 * 60 * 60 * 1000;
        if (range === '-24h') return 24 * 60 * 60 * 1000;
        return 15 * 60 * 1000;
    };

    // Fetch history from API
    const fetchHistory = async () => {
        try {
            let url = '/api/history';
            if (customRange.start && customRange.end) {
                url += `?start=${new Date(customRange.start).toISOString()}&stop=${new Date(customRange.end).toISOString()}`;
            } else {
                url += `?range=${timeRange}`;
            }

            const res = await axios.get(url);
            if (res.data && res.data.length > 0) {
                setData(res.data);
            } else {
                if (isCustom || (customRange.start && customRange.end)) {
                    setData([]);
                }
            }
        } catch (err) {
            console.error("Failed to fetch history", err);
            if (isCustom || (customRange.start && customRange.end)) {
                setData([]);
            }
        }
    };

    useEffect(() => {
        if (!isCustom) {
            fetchHistory();

            // Also fetch the single latest point for immediate readout update
            fetch('/api/rig/latest')
                .then(res => res.json())
                .then(latestPoint => {
                    if (latestPoint && Object.keys(latestPoint).length > 0) {
                        processLivePoint(latestPoint);
                    }
                })
                .catch(err => console.error("Failed to fetch latest EDR point:", err));
        }

        if (!isCustom) {
            const handleSocketData = (newData) => {
                processLivePoint(newData);
            };

            socket.on('rig_data', handleSocketData);
            return () => socket.off('rig_data', handleSocketData);
        }
    }, [tracks, timeRange, isCustom]);

    const processLivePoint = (newData) => {
        setData(prev => {
            const now = new Date();
            const newPoint = {
                name: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
                timestamp: now.getTime()
            };

            Object.keys(newData).forEach(measurement => {
                if (typeof newData[measurement] === 'object' && newData[measurement] !== null) {
                    Object.keys(newData[measurement]).forEach(field => {
                        newPoint[`${measurement}.${field}`] = newData[measurement][field];
                    });
                }
            });

            // Ensure all track metrics have at least a 0 value if missing
            tracks.forEach(track => {
                if (newPoint[track.left.metric] === undefined) newPoint[track.left.metric] = 0;
                if (newPoint[track.right.metric] === undefined) newPoint[track.right.metric] = 0;
            });

            // Merge and deduplicate
            const merged = [...prev, newPoint];
            const uniqueMap = new Map();
            merged.forEach(item => {
                // If timestamp is within 1s, consider it same for EDR chart smoothing
                const key = Math.floor(item.timestamp / 1000);
                if (!uniqueMap.has(key)) {
                    uniqueMap.set(key, item);
                }
            });

            const sorted = Array.from(uniqueMap.values()).sort((a, b) => a.timestamp - b.timestamp);

            // Trim data older than selected range
            const cutoff = now.getTime() - getRangeMs(timeRange);
            const trimmed = sorted.filter(pt => (pt.timestamp || 0) >= cutoff);

            return trimmed;
        });
    };

    const applyCustomRange = () => {
        if (customRange.start && customRange.end) {
            setIsCustom(true);
            fetchHistory();
        }
    };

    const handlePresetClick = (val) => {
        setIsCustom(false);
        setTimeRange(val);
        setCustomRange({ start: '', end: '' });
    };

    const handleTrackMetricChange = (trackIndex, side, newMetric) => {
        const newTracks = [...tracks];
        newTracks[trackIndex][side] = { ...newTracks[trackIndex][side], metric: newMetric };
        setTracks(newTracks);
    };

    const handleTrackScaleChange = (trackIndex, side, field, value) => {
        const newTracks = [...tracks];
        newTracks[trackIndex][side] = { ...newTracks[trackIndex][side], [field]: Number(value) };
        setTracks(newTracks);
    };

    // Helper to get latest value
    const getLatestValue = (metric) => {
        if (data.length === 0) return 0;
        return Number(data[data.length - 1][metric] || 0).toFixed(1);
    };

    return (
        <Box sx={{ height: 'calc(100vh - 100px)', display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2, alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                <Typography variant="h5" sx={{ fontWeight: 'bold' }}>Electronic Drilling Recorder (EDR)</Typography>

                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                    {/* Watch Symbol for Custom Range Dropdown */}
                    <Box sx={{ position: 'relative' }}>
                        <Button
                            variant="outlined"
                            onClick={() => setShowCustomDate(!showCustomDate)}
                            sx={{ color: 'white', borderColor: '#334155', height: '100%', bgcolor: '#1e293b', minWidth: '40px', px: 1 }}
                        >
                            <Clock size={20} />
                        </Button>
                        {showCustomDate && (
                            <Paper sx={{ position: 'absolute', top: '100%', left: 0, mt: 1, p: 2, bgcolor: '#0f172a', border: '1px solid #334155', zIndex: 50, width: 'max-content' }}>
                                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
                                    <Typography sx={{ color: '#94a3b8', fontSize: '0.875rem', fontWeight: 'bold' }}>CUSTOM RANGE</Typography>
                                    <input
                                        type="datetime-local"
                                        style={{ background: 'transparent', color: 'white', border: '1px solid #334155', borderRadius: '4px', padding: '4px', colorScheme: 'dark' }}
                                        onChange={(e) => setCustomRange(prev => ({ ...prev, start: e.target.value }))}
                                    />
                                    <span style={{ color: '#94a3b8' }}>-</span>
                                    <input
                                        type="datetime-local"
                                        style={{ background: 'transparent', color: 'white', border: '1px solid #334155', borderRadius: '4px', padding: '4px', colorScheme: 'dark' }}
                                        onChange={(e) => setCustomRange(prev => ({ ...prev, end: e.target.value }))}
                                    />
                                    <Button variant="contained" size="small" onClick={() => { applyCustomRange(); setShowCustomDate(false); }} sx={{ ml: 1 }}>Go</Button>
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
                        { label: '1h', val: '-1h' },
                        { label: '12h', val: '-12h' },
                        { label: '24h', val: '-24h' }
                    ].map((opt) => (
                        <Button
                            key={opt.val}
                            variant={!isCustom && timeRange === opt.val ? "contained" : "outlined"}
                            onClick={() => handlePresetClick(opt.val)}
                            size="small"
                            sx={{
                                bgcolor: !isCustom && timeRange === opt.val ? '#38bdf8' : 'transparent',
                                color: !isCustom && timeRange === opt.val ? '#0f172a' : '#94a3b8',
                                borderColor: '#334155',
                                minWidth: '40px'
                            }}
                        >
                            {opt.label}
                        </Button>
                    ))}
                </Box>
            </Box>

            <Grid container spacing={1} sx={{ flexGrow: 1, minHeight: 0 }}>
                {tracks.map((track, idx) => (
                    <Grid item xs={12} md={4} key={idx} sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>

                        {/* THE VERTICAL CHART */}
                        <Paper sx={{ flexGrow: 1, bgcolor: 'black', border: '1px solid #334155', position: 'relative', overflow: 'hidden' }}>
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart
                                    data={data}
                                    layout="vertical"
                                    margin={{ top: 20, right: 10, left: 0, bottom: 20 }}
                                >
                                    <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={true} vertical={true} />

                                    {/* The Time Axis (Y-Axis in vertical layout) */}
                                    <YAxis
                                        dataKey="timestamp"
                                        type="number"
                                        scale="time"
                                        domain={isCustom && customRange.start && customRange.end ? [new Date(customRange.start).getTime(), new Date(customRange.end).getTime()] : ['dataMin', 'dataMax']}
                                        reversed={true} // Scroll down
                                        tickFormatter={(unixTime) => new Date(unixTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}
                                        stroke="#94a3b8"
                                        width={80}
                                        tick={{ fontSize: 12, fill: '#22c55e' }}
                                    />

                                    {/* Dual X-Axes for the two variables */}
                                    <XAxis type="number" xAxisId="left" orientation="top" stroke="#38bdf8" hide={true} domain={[track.left.min, track.left.max]} />
                                    <XAxis type="number" xAxisId="right" orientation="top" stroke="#fbbf24" hide={true} domain={[track.right.min, track.right.max]} />

                                    <Tooltip
                                        contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', color: 'white' }}
                                        labelFormatter={(label) => new Date(label).toLocaleTimeString()}
                                    />

                                    <Line type="monotone" dataKey={track.left.metric} xAxisId="left" stroke="#38bdf8" strokeWidth={2} dot={false} isAnimationActive={false} />
                                    <Line type="monotone" dataKey={track.right.metric} xAxisId="right" stroke="#fbbf24" strokeWidth={2} dot={false} isAnimationActive={false} />
                                </LineChart>
                            </ResponsiveContainer>
                        </Paper>

                        {/* BOTTOM PARAMETER READOUTS */}
                        <Paper sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 1, p: 1, bgcolor: '#d6d3d1', borderRadius: 2, border: '2px solid #a8a29e', boxShadow: 'inset 0 2px 4px rgba(255,255,255,0.5)' }}>
                            {/* Top Parameter (Left Axis) */}
                            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                <FormControl size="small" variant="standard" sx={{ mb: 0.5 }}>
                                    <Select
                                        value={track.left.metric}
                                        onChange={(e) => handleTrackMetricChange(idx, 'left', e.target.value)}
                                        disableUnderline
                                        sx={{
                                            color: 'black',
                                            fontWeight: '900',
                                            fontSize: '0.85rem',
                                            textTransform: 'capitalize',
                                            bgcolor: '#f8fafc',
                                            borderRadius: 1,
                                            border: '1px inset #a8a29e',
                                            px: 1,
                                            boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                                            '& .MuiSelect-select': { py: 0.5 }
                                        }}
                                    >
                                        {Object.entries(AVAILABLE_METRICS).map(([category, fields]) => [
                                            <ListSubheader key={`${category}-header`} sx={{ bgcolor: '#f1f5f9', fontWeight: 'bold', color: '#475569', lineHeight: '32px' }}>
                                                {category.toUpperCase()}
                                            </ListSubheader>,
                                            ...fields.map(field => (
                                                <MenuItem key={`${category}.${field}`} value={`${category}.${field}`} sx={{ pl: 3 }}>
                                                    <Box component="span" sx={{ color: '#64748b', fontSize: '0.7rem', fontWeight: 'bold', textTransform: 'uppercase', mr: 1 }}>{category.replace('_', ' ')}</Box>
                                                    {field.replace(/_/g, ' ')}
                                                </MenuItem>
                                            ))
                                        ])}
                                    </Select>
                                </FormControl>
                                <Box sx={{ width: '100%', bgcolor: 'black', py: 0.5, textAlign: 'center', border: '3px solid #78716c', borderRadius: '4px', boxShadow: 'inset 0 0 10px rgba(0,0,0,1)' }}>
                                    <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#22c55e', textShadow: '0 0 5px rgba(34, 197, 94, 0.5)', lineHeight: 1 }}>
                                        {getLatestValue(track.left.metric)}
                                    </Typography>
                                </Box>
                                <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', px: 0.5 }}>
                                    <input type="number" value={track.left.min} onChange={(e) => handleTrackScaleChange(idx, 'left', 'min', e.target.value)} style={{ background: 'transparent', border: 'none', color: 'black', fontSize: '0.7rem', fontWeight: 'bold', width: '45px', textAlign: 'left', outline: 'none' }} />
                                    <input type="number" value={track.left.max} onChange={(e) => handleTrackScaleChange(idx, 'left', 'max', e.target.value)} style={{ background: 'transparent', border: 'none', color: 'black', fontSize: '0.7rem', fontWeight: 'bold', width: '45px', textAlign: 'right', outline: 'none' }} />
                                </Box>
                                <Box sx={{ width: '100%', height: '1px', bgcolor: '#a8a29e', my: 0.5 }} />
                            </Box>

                            {/* Bottom Parameter (Right Axis) */}
                            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                                <FormControl size="small" variant="standard" sx={{ mb: 0.5 }}>
                                    <Select
                                        value={track.right.metric}
                                        onChange={(e) => handleTrackMetricChange(idx, 'right', e.target.value)}
                                        disableUnderline
                                        sx={{
                                            color: 'black',
                                            fontWeight: '900',
                                            fontSize: '0.85rem',
                                            textTransform: 'capitalize',
                                            bgcolor: '#f8fafc',
                                            borderRadius: 1,
                                            border: '1px inset #a8a29e',
                                            px: 1,
                                            boxShadow: '0 1px 2px rgba(0,0,0,0.1)',
                                            '& .MuiSelect-select': { py: 0.5 }
                                        }}
                                    >
                                        {Object.entries(AVAILABLE_METRICS).map(([category, fields]) => [
                                            <ListSubheader key={`${category}-header-right`} sx={{ bgcolor: '#f1f5f9', fontWeight: 'bold', color: '#475569', lineHeight: '32px' }}>
                                                {category.toUpperCase()}
                                            </ListSubheader>,
                                            ...fields.map(field => (
                                                <MenuItem key={`${category}.${field}`} value={`${category}.${field}`} sx={{ pl: 3 }}>
                                                    {field.replace(/_/g, ' ')}
                                                </MenuItem>
                                            ))
                                        ])}
                                    </Select>
                                </FormControl>
                                <Box sx={{ width: '100%', bgcolor: 'black', py: 0.5, textAlign: 'center', border: '3px solid #78716c', borderRadius: '4px', boxShadow: 'inset 0 0 10px rgba(0,0,0,1)' }}>
                                    <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#38bdf8', textShadow: '0 0 5px rgba(56, 189, 248, 0.5)', lineHeight: 1 }}>
                                        {getLatestValue(track.right.metric)}
                                    </Typography>
                                </Box>
                                <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', px: 0.5 }}>
                                    <input type="number" value={track.right.min} onChange={(e) => handleTrackScaleChange(idx, 'right', 'min', e.target.value)} style={{ background: 'transparent', border: 'none', color: 'black', fontSize: '0.7rem', fontWeight: 'bold', width: '45px', textAlign: 'left', outline: 'none' }} />
                                    <input type="number" value={track.right.max} onChange={(e) => handleTrackScaleChange(idx, 'right', 'max', e.target.value)} style={{ background: 'transparent', border: 'none', color: 'black', fontSize: '0.7rem', fontWeight: 'bold', width: '45px', textAlign: 'right', outline: 'none' }} />
                                </Box>
                            </Box>
                        </Paper>
                    </Grid>
                ))}
            </Grid>
        </Box>
    );
}
