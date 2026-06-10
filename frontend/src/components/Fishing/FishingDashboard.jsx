import React, { useState, useEffect } from 'react';
import { Box, Typography, Paper, Grid, TextField, Button, Alert, LinearProgress } from '@mui/material';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, AreaChart, Area } from 'recharts';
import { Anchor, Activity, AlertTriangle, Gauge, ArrowDown, ArrowUp, Settings, RotateCw, Droplets } from 'lucide-react';
import io from 'socket.io-client';
import AnalogGauge from '../Common/AnalogGauge';

const socket = io('/');

const FishingDashboard = () => {
    // 1. Critical Hoisting Parameters
    const [hoisting, setHoisting] = useState({
        hookLoad: 0,        // tons
        stringWeight: 210,  // tons (Tare / Free String Weight) - USER INPUT
        slackOffWeight: 0,  // tons
        blockPosition: 0    // %
    });

    // 2. Depth & Speed
    const [depth, setDepth] = useState({
        bitDepth: 5200,     // ft
        fishTopDepth: 5150, // ft - USER INPUT
        lineSpeed: 0        // ft/min
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

    // Derived: Overpull
    const overpull = Math.max(0, hoisting.hookLoad - hoisting.stringWeight);
    const tensileLimit = 500; // tons (Pipe Limit)
    const overpullPercentage = Math.min(100, (overpull / (tensileLimit - hoisting.stringWeight)) * 100);

    // Socket Listener
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

            // Update graph with live data
            setGraphData(prev => {
                const newData = [...prev];
                newData.push({
                    time: new Date().toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                    hookload: Number(data.drawworks?.hook_load) || 0,
                    depth: depth.bitDepth,
                    overpull: Math.max(0, (Number(data.drawworks?.hook_load) || 0) - hoisting.stringWeight),
                    torque: Number(data.engine?.torque) || 0
                });

                // Keep only last 20 points for live chart performance if we want it short, expanding as needed
                if (newData.length > 30) newData.shift();

                return newData;
            });
        };

        socket.on('rig_data', handleSocketData);
        return () => socket.off('rig_data', handleSocketData);
    }, [hoisting.stringWeight, depth.bitDepth]);

    // Safety Alarms Logic
    useEffect(() => {
        const newAlarms = [];
        if (overpull > 100) newAlarms.push({ id: 'overpull', msg: 'HIGH OVERPULL WARNING', severity: 'error' });
        if (pressure.pump > 4500) newAlarms.push({ id: 'pump', msg: 'PUMP OVERPRESSURE', severity: 'warning' });
        setAlarms(newAlarms);
    }, [overpull, pressure.pump]);


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
                        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>Fishing Operations</Typography>
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
                    <Typography variant="subtitle1" sx={{ color: '#fbbf24', mb: 2, fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Activity size={18} /> Operation Analytics
                    </Typography>

                    <Paper sx={{ p: 2, bgcolor: '#1e293b', mb: 2, height: 300 }}>
                        <Typography variant="caption" sx={{ color: '#94a3b8' }}>WOH vs DEPTH (Trend)</Typography>
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={graphData}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                                <XAxis dataKey="time" stroke="#94a3b8" />
                                <YAxis yAxisId="left" stroke="#38bdf8" label={{ value: 'HKLD (tons)', angle: -90, position: 'insideLeft', fill: '#38bdf8' }} />
                                <YAxis yAxisId="right" orientation="right" stroke="#fbbf24" label={{ value: 'Depth', angle: 90, position: 'insideRight', fill: '#fbbf24' }} />
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
                            <AreaChart data={graphData}>
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
                            <MetricBox label="Bit Depth" value={depth.bitDepth} unit="ft" color="#22c55e" />
                        </Grid>
                        <Grid item xs={6}>
                            <MetricBox label="Fish Top" value={depth.fishTopDepth} unit="ft" color="#fbbf24" />
                        </Grid>
                        <Grid item xs={12}>
                            <Box sx={{ p: 1.5, bgcolor: '#1e293b', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography variant="body2" sx={{ color: '#94a3b8' }}>Distance to Fish</Typography>
                                <Typography variant="h6" sx={{ color: 'white', fontWeight: 'bold' }}>
                                    {(depth.fishTopDepth - depth.bitDepth).toFixed(1)} ft
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
