import React, { useState, useEffect } from 'react';
import { Grid, Paper, Typography, Box } from '@mui/material';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Activity, Gauge, Droplets, Waves } from 'lucide-react';
import { socket } from '../../socket';
import axios from '../../api';

function MetricCard({ title, value, unit, icon: Icon, color = '#38bdf8' }) {
    return (
        <Paper sx={{ p: 2, bgcolor: '#1e293b', color: 'white', display: 'flex', alignItems: 'center', gap: 2 }}>
            <Box sx={{ p: 1.5, borderRadius: '50%', bgcolor: `${color}20`, color: color }}>
                <Icon size={24} />
            </Box>
            <Box>
                <Typography variant="subtitle2" sx={{ color: '#94a3b8' }}>{title}</Typography>
                <Typography variant="h5" sx={{ fontWeight: 'bold' }}>
                    {value} <span style={{ fontSize: '0.9rem', color: '#64748b' }}>{unit}</span>
                </Typography>
            </Box>
        </Paper>
    );
}

export default function MudPumpDashboard() {
    const [pumpData, setPumpData] = useState({
        spm: 0,
        pressure: 0,
        total_spm: 0,
        flow_in: 0,
        flow_out: 0
    });
    const [fluidData, setFluidData] = useState({
        total_tank_volume: 0,
        tank_gain_loss: 0,
        trip_tank: 0,
        trip_tank_percentage: 0,
        tank_1: 0,
        tank_2: 0,
        tank_3: 0,
        tank_4: 0
    });
    const [flowTrend, setFlowTrend] = useState([]);

    useEffect(() => {
        // Fetch latest data on mount
        axios.get('/api/rig/latest')
            .then(({ data }) => {
                if (data.mudpump) processMudPumpData(data.mudpump);
                if (data.fluid) setFluidData(prev => ({ ...prev, ...data.fluid }));
            })
            .catch(err => console.error("Failed to fetch latest mudpump data:", err));

        const handler = (data) => {
            if (data.mudpump) {
                processMudPumpData(data.mudpump);
            }
            if (data.fluid) {
                setFluidData(prev => ({ ...prev, ...data.fluid }));
            }
        };
        socket.on('rig_data', handler);

        return () => {
            socket.off('rig_data', handler);
        };
    }, []);

    const processMudPumpData = (mudpumpData) => {
        setPumpData(mudpumpData);

        // Update Flow Trend
        setFlowTrend(prev => {
            const newPoint = {
                name: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
                flow_in: mudpumpData.flow_in,
                flow_out: mudpumpData.flow_out
            };
            const updated = [...prev, newPoint];
            if (updated.length > 30) updated.shift();
            return updated;
        });
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {/* --- SECTION 1: PUMP SYSTEMS --- */}
            <Box>
                <Typography variant="h6" sx={{ mb: 2, fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Activity size={20} /> Pump Systems
                </Typography>
                <Grid container spacing={2}>
                    <Grid item xs={12} sm={6} md={2.4}>
                        <MetricCard
                            title="PUMP SPM"
                            value={pumpData.spm}
                            unit="SPM"
                            icon={Activity}
                            color="#ec4899"
                        />
                    </Grid>
                    <Grid item xs={12} sm={6} md={2.4}>
                        <MetricCard
                            title="PRESSURE"
                            value={pumpData.pressure}
                            unit="bar"
                            icon={Gauge}
                            color="#ef4444"
                        />
                    </Grid>
                    <Grid item xs={12} sm={6} md={2.4}>
                        <MetricCard
                            title="INLET FLOW"
                            value={pumpData.flow_in}
                            unit="Lt/min"
                            icon={Droplets}
                            color="#3b82f6"
                        />
                    </Grid>
                    <Grid item xs={12} sm={6} md={2.4}>
                        <MetricCard
                            title="RETURN FLOW"
                            value={pumpData.flow_out}
                            unit="%"
                            icon={Waves}
                            color="#22c55e"
                        />
                    </Grid>
                    <Grid item xs={12} sm={6} md={2.4}>
                        <MetricCard
                            title="TOTAL STROKES"
                            value={pumpData.total_spm}
                            unit="Count"
                            icon={Activity}
                            color="#f59e0b"
                        />
                    </Grid>
                </Grid>
            </Box>

            {/* --- SECTION 2: TANK & FLUID SYSTEMS --- */}
            <Box>
                <Typography variant="h6" sx={{ mb: 2, fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
                    <Droplets size={20} /> Tank & Fluid Systems
                </Typography>
                <Grid container spacing={2}>
                    {/* Main Fluid Metrics */}
                    <Grid item xs={12} sm={6} md={3}>
                        <MetricCard
                            title="ACTIVE VOLUME"
                            value={fluidData.total_tank_volume}
                            unit="m³"
                            icon={Droplets}
                            color="#0ea5e9"
                        />
                    </Grid>
                    <Grid item xs={12} sm={6} md={3}>
                        <MetricCard
                            title="VOLUME GAIN/LOSS"
                            value={Number(fluidData.tank_gain_loss || 0).toFixed(2)}
                            unit="m³"
                            icon={Activity}
                            color={fluidData.tank_gain_loss >= 0 ? "#22c55e" : "#ef4444"}
                        />
                    </Grid>
                    <Grid item xs={12} sm={6} md={3}>
                        <MetricCard
                            title="TRIP TANK VOLUME"
                            value={fluidData.trip_tank}
                            unit="m³"
                            icon={Waves}
                            color="#6366f1"
                        />
                    </Grid>
                    <Grid item xs={12} sm={6} md={3}>
                        <MetricCard
                            title="TRIP GAIN/LOSS"
                            value={fluidData.trip_tank_percentage}
                            unit="%"
                            icon={Activity}
                            color={fluidData.trip_tank_percentage >= 0 ? "#22c55e" : "#ef4444"}
                        />
                    </Grid>

                    {/* Individual Tank Status */}
                    <Grid item xs={12}>
                        <Box sx={{ p: 2, bgcolor: '#0f172a', borderRadius: 2, border: '1px solid #334155', mt: 1 }}>
                            <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2, textTransform: 'uppercase', letterSpacing: 1 }}>
                                Mud Tank Individual Volumes
                            </Typography>
                            <Grid container spacing={2}>
                                {[1, 2, 3, 4].map(num => (
                                    <Grid item xs={6} sm={3} key={num}>
                                        <Box sx={{ p: 1.5, bgcolor: '#1e293b', borderRadius: 1, textAlign: 'center', border: '1px solid #334155' }}>
                                            <Typography variant="caption" sx={{ color: '#64748b', display: 'block' }}>TANK {num}</Typography>
                                            <Typography variant="h6" sx={{ color: 'white', fontWeight: 'bold' }}>
                                                {fluidData[`tank_${num}`]} <span style={{ fontSize: '0.7rem', color: '#64748b' }}>m³</span>
                                            </Typography>
                                        </Box>
                                    </Grid>
                                ))}
                            </Grid>
                        </Box>
                    </Grid>
                </Grid>
            </Box>

            {/* --- SECTION 3: CHARTS --- */}
            <Box>
                <Paper sx={{ p: 3, bgcolor: '#1e293b', color: 'white', minHeight: 400, border: '1px solid #334155' }}>
                    <Typography variant="h6" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Activity size={20} /> Flow In vs Return Flow Trend
                    </Typography>
                    <ResponsiveContainer width="100%" height={300}>
                        <LineChart data={flowTrend}>
                            <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                            <XAxis dataKey="name" stroke="#94a3b8" fontSize={12} />
                            <YAxis stroke="#94a3b8" fontSize={12} />
                            <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #334155' }} />
                            <Legend />
                            <Line type="monotone" dataKey="flow_in" stroke="#3b82f6" name="Inlet Flow (Lt/min)" strokeWidth={2} dot={false} />
                            <Line type="monotone" dataKey="flow_out" stroke="#22c55e" name="Return Flow (%)" strokeWidth={2} dot={false} />
                        </LineChart>
                    </ResponsiveContainer>
                </Paper>
            </Box>
        </Box>
    );
}
