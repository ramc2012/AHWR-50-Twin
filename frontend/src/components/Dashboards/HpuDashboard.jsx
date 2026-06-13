import React, { useState, useEffect } from 'react';
import { Grid, Paper, Typography, Box, Divider } from '@mui/material';
import { socket } from '../../socket';
import AnalogGauge from '../Common/AnalogGauge';
import GaugeCard from '../Common/GaugeCard';

const StatusIndicator = ({ label, value, mapping }) => {
    const active = mapping[value] || { text: 'Unknown', color: '#64748b' };
    return (
        <Box sx={{ textAlign: 'center', px: 2 }}>
            <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', mb: 0.5 }}>{label.toUpperCase()}</Typography>
            <Box sx={{
                bgcolor: `${active.color}15`,
                color: active.color,
                border: `1px solid ${active.color}`,
                px: 2, py: 0.5, borderRadius: 1,
                fontWeight: 'bold', fontSize: '0.875rem'
            }}>
                {active.text}
            </Box>
        </Box>
    );
};

export default function HpuDashboard() {
    const [data, setData] = useState({});

    useEffect(() => {
        const handler = (newData) => {
            if (newData.hpu) setData(newData.hpu);
        };
        socket.on('rig_data', handler);
        return () => socket.off('rig_data', handler);
    }, []);

    const statusMapping = {
        0: { text: 'OFF', color: '#64748b' },
        1: { text: 'ON IDLE', color: '#38bdf8' },
        2: { text: 'ON', color: '#4ade80' }
    };

    const pilotMapping = {
        0: { text: 'OFF', color: '#64748b' },
        1: { text: 'ON', color: '#4ade80' },
        2: { text: 'FAULT', color: '#ef4444' }
    };

    const opModeMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'DRILLING', color: '#4ade80' },
        2: { text: 'RIG UP', color: '#38bdf8' }
    };

    const oilStatusMapping = {
        0: { text: 'OK', color: '#4ade80' },
        1: { text: 'LOW', color: '#fbbf24' },
        2: { text: 'HIGH', color: '#f97316' },
        3: { text: 'HH/CRIT', color: '#ef4444' },
        4: { text: 'HH/CRIT', color: '#ef4444' }
    };

    return (
        <Box>

            <Grid container spacing={3}>
                <Grid item xs={12}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                        <StatusIndicator label="System Status" value={data.status} mapping={statusMapping} />
                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />
                        <StatusIndicator label="Operating Mode" value={data.op_mode} mapping={opModeMapping} />
                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />
                        <StatusIndicator label="Pilot Status" value={data.pilot_status} mapping={pilotMapping} />
                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />
                        <StatusIndicator label="Temp Status" value={data.oil_temp_status} mapping={oilStatusMapping} />
                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />
                        <StatusIndicator label="Level Status" value={data.oil_level_status} mapping={oilStatusMapping} />
                    </Paper>
                </Grid>

                <Grid item xs={12} md={3}>
                    <GaugeCard>
                        <AnalogGauge
                            value={data.discharge_pressure || 0}
                            max={350}
                            label="DISCHARGE PRESS"
                            unit="bar"
                            size="fill"
                            color="#38bdf8"
                        />
                    </GaugeCard>
                </Grid>

                <Grid item xs={12} md={3}>
                    <GaugeCard>
                        <AnalogGauge
                            value={data.aux_pressure || 0}
                            max={250}
                            label="AUX PRESSURE"
                            unit="bar"
                            size="fill"
                            color="#a78bfa"
                        />
                    </GaugeCard>
                </Grid>

                <Grid item xs={12} md={3}>
                    <GaugeCard>
                        <AnalogGauge
                            value={data.oil_temp || 0}
                            max={100}
                            label="OIL TEMP"
                            unit="°C"
                            size="fill"
                            color="#f97316"
                        />
                    </GaugeCard>
                </Grid>

                <Grid item xs={12} md={3}>
                    <GaugeCard>
                        <AnalogGauge
                            value={data.oil_level || 0}
                            max={100}
                            label="OIL LEVEL"
                            unit="%"
                            size="fill"
                            color="#22d3ee"
                        />
                    </GaugeCard>
                </Grid>

                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', height: '100%', borderRadius: 2 }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2, letterSpacing: 1, fontWeight: 'bold' }}>PILOT & VALVES</Typography>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                            <Box sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography variant="body2" sx={{ color: '#94a3b8', fontWeight: '500' }}>PILOT LS PRESSURE</Typography>
                                <Typography sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{data.pilot_pressure || 0} bar</Typography>
                            </Box>
                            <Box sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography variant="body2" sx={{ color: '#94a3b8', fontWeight: '500' }}>GATE VALVE</Typography>
                                <Typography sx={{ color: data.gate_valve ? '#4ade80' : '#ef4444', fontWeight: 'bold' }}>{data.gate_valve ? 'OPEN' : 'CLOSED'}</Typography>
                            </Box>
                            <Box sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography variant="body2" sx={{ color: '#94a3b8', fontWeight: '500' }}>RUN HOURS</Typography>
                                <Typography sx={{ color: 'white', fontWeight: 'bold' }}>{data.run_hours || 0} HRS</Typography>
                            </Box>
                        </Box>
                    </Paper>
                </Grid>

                {/* OIL FILTERS */}
                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', height: '100%', borderRadius: 2 }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2, letterSpacing: 1, fontWeight: 'bold' }}>OIL FILTERS</Typography>
                        <Grid container spacing={1.5}>
                            {[1, 2, 3, 4, 5, 6, 7, 8].map(num => (
                                <Grid item xs={6} key={`filter-${num}`}>
                                    <Box sx={{ p: 1.25, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: '500' }}>FILTER {num}</Typography>
                                        <Typography sx={{
                                            color: data[`oil_filter_${num}`] !== 0 ? '#4ade80' : '#ef4444',
                                            fontWeight: 'bold', fontSize: '0.75rem'
                                        }}>
                                            {data[`oil_filter_${num}`] !== 0 ? 'OK' : 'CLOGGED'}
                                        </Typography>
                                    </Box>
                                </Grid>
                            ))}
                        </Grid>
                    </Paper>
                </Grid>

                {/* HYDRAULIC PUMPS */}
                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', height: '100%', borderRadius: 2 }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2, letterSpacing: 1, fontWeight: 'bold' }}>HYDRAULIC PUMPS</Typography>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>

                            <Box sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 1 }}>
                                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                                    <Typography variant="caption" sx={{ color: '#3182ce', fontWeight: 'bold' }}>PUMP PDW</Typography>
                                    <Typography variant="caption" sx={{ color: data.pdw_pump_status === 2 ? '#38bdf8' : data.pdw_pump_status === 1 ? '#4ade80' : '#f97316', fontWeight: 'bold' }}>
                                        {data.pdw_pump_status === 2 ? 'ENABLE' : data.pdw_pump_status === 1 ? 'READY' : 'NOT READY'}
                                    </Typography>
                                </Box>
                                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <Typography variant="caption" sx={{ color: '#64748b', fontWeight: '500' }}>FLOW: <span style={{ color: 'white' }}>{Number(data.pdw_pump_flow || 0).toFixed(1)} %</span></Typography>
                                    <Typography variant="caption" sx={{ color: '#64748b', fontWeight: '500' }}>PRESS: <span style={{ color: 'white' }}>{Number(data.pdw_pump_press || 0).toFixed(1)} bar</span></Typography>
                                </Box>
                            </Box>

                            <Box sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 1 }}>
                                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                                    <Typography variant="caption" sx={{ color: '#3182ce', fontWeight: 'bold' }}>HTD PUMP 1</Typography>
                                    <Typography variant="caption" sx={{ color: data.htd_pump1_status === 2 ? '#38bdf8' : data.htd_pump1_status === 1 ? '#4ade80' : '#f97316', fontWeight: 'bold' }}>
                                        {data.htd_pump1_status === 2 ? 'ENABLE' : data.htd_pump1_status === 1 ? 'READY' : 'NOT READY'}
                                    </Typography>
                                </Box>
                                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <Typography variant="caption" sx={{ color: '#64748b', fontWeight: '500' }}>FLOW: <span style={{ color: 'white' }}>{Number(data.htd_pump1_flow || 0).toFixed(1)} %</span></Typography>
                                    <Typography variant="caption" sx={{ color: '#64748b', fontWeight: '500' }}>PRESS: <span style={{ color: 'white' }}>{Number(data.htd_pump1_press || 0).toFixed(1)} bar</span></Typography>
                                </Box>
                            </Box>

                            <Box sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 1 }}>
                                <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                                    <Typography variant="caption" sx={{ color: '#3182ce', fontWeight: 'bold' }}>HTD PUMP 2</Typography>
                                    <Typography variant="caption" sx={{ color: data.htd_pump2_status === 2 ? '#38bdf8' : data.htd_pump2_status === 1 ? '#4ade80' : '#f97316', fontWeight: 'bold' }}>
                                        {data.htd_pump2_status === 2 ? 'ENABLE' : data.htd_pump2_status === 1 ? 'READY' : 'NOT READY'}
                                    </Typography>
                                </Box>
                                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                                    <Typography variant="caption" sx={{ color: '#64748b', fontWeight: '500' }}>FLOW: <span style={{ color: 'white' }}>{Number(data.htd_pump2_flow || 0).toFixed(1)} %</span></Typography>
                                    <Typography variant="caption" sx={{ color: '#64748b', fontWeight: '500' }}>PRESS: <span style={{ color: 'white' }}>{Number(data.htd_pump2_press || 0).toFixed(1)} bar</span></Typography>
                                </Box>
                            </Box>

                        </Box>
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );
}
