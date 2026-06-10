import React, { useState, useEffect } from 'react';
import { Grid, Paper, Typography, Box, Divider } from '@mui/material';
import io from 'socket.io-client';
import AnalogGauge from '../Common/AnalogGauge';

const socket = io('/');

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

export default function CatEngineDashboard() {
    const [data, setData] = useState({});

    useEffect(() => {
        socket.on('rig_data', (newData) => {
            if (newData.cat_engine) setData(newData.cat_engine);
        });
        return () => socket.off('rig_data');
    }, []);

    const statusMapping = {
        '-1': { text: 'UNKNOWN', color: '#64748b' },
        0: { text: 'READY', color: '#38bdf8' },
        1: { text: 'IN PROGRESS', color: '#38bdf8' },
        2: { text: 'DONE', color: '#4ade80' },
        3: { text: 'EMERGENCY', color: '#ef4444' },
        4: { text: 'NOT READY', color: '#fbbf24' },
        5: { text: 'FAULT', color: '#ef4444' },
        6: { text: 'RUN + FAULT', color: '#f97316' },
        7: { text: 'STOP FORCED', color: '#ef4444' }
    };

    const sourceMapping = {
        0: { text: 'NONE', color: '#64748b' },
        1: { text: 'LOCAL', color: '#38bdf8' },
        2: { text: 'REMOTE', color: '#4ade80' },
        3: { text: 'MANUAL', color: '#fbbf24' },
        4: { text: 'AUTO', color: '#4ade80' },
        5: { text: 'DCC', color: '#38bdf8' }
    };

    return (
        <Box>


            <Grid container spacing={3}>
                <Grid item xs={12}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                        <StatusIndicator label="Engine Status" value={data.status} mapping={statusMapping} />
                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />
                        <StatusIndicator label="Source Cmd" value={data.source_cmd} mapping={sourceMapping} />
                        <Box sx={{ ml: 'auto', textAlign: 'right', pr: 2 }}>
                            <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block' }}>TOTAL ENGINE HOURS</Typography>
                            <Typography variant="h5" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{data.total_hours || 0} <span style={{ fontSize: '0.6em', color: '#64748b' }}>HRS</span></Typography>
                        </Box>
                    </Paper>
                </Grid>

                <Grid item xs={12} sm={6} md={3}>
                    <Paper sx={{ p: 3, bgcolor: '#1e293b', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'center' }}>
                        <AnalogGauge
                            value={data.rpm || 0}
                            max={2100}
                            label="ENGINE SPEED"
                            unit="RPM"
                            color="#38bdf8"
                        />
                        <Typography variant="caption" sx={{ color: '#64748b', mt: 1 }}>RUN: {data.run_hours || 0} HRS</Typography>
                    </Paper>
                </Grid>

                <Grid item xs={12} sm={6} md={3}>
                    <Paper sx={{ p: 3, bgcolor: '#1e293b', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'center' }}>
                        <AnalogGauge
                            value={data.load || 0}
                            max={100}
                            label="ENGINE LOAD"
                            unit="%"
                            color={data.load > 85 ? '#ef4444' : '#4ade80'}
                        />
                        <Typography variant="caption" sx={{ color: '#64748b', mt: 1 }}>FUEL RATE: {data.fuel_rate || 0} L/H</Typography>
                    </Paper>
                </Grid>

                <Grid item xs={12} sm={6} md={3}>
                    <Paper sx={{ p: 3, bgcolor: '#1e293b', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'center' }}>
                        <AnalogGauge
                            value={data.oil_pressure || 0}
                            max={10}
                            label="OIL PRESSURE"
                            unit="bar"
                            color="#fbbf24"
                        />
                    </Paper>
                </Grid>

                <Grid item xs={12} sm={6} md={3}>
                    <Paper sx={{ p: 3, bgcolor: '#1e293b', display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'center' }}>
                        <AnalogGauge
                            value={data.pedal_position || 0}
                            max={100}
                            label="ACCEL PEDAL"
                            unit="%"
                            color="#a855f7"
                        />
                    </Paper>
                </Grid>

                <Grid item xs={12} md={3}>
                    <Box sx={{ p: 2, bgcolor: '#1e293b', borderRadius: 2, border: '1px solid #334155' }}>
                        <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', mb: 1 }}>COOLANT TEMP</Typography>
                        <Typography variant="h4" sx={{ color: '#f97316', fontWeight: 'bold' }}>{data.coolant_temp || 0} °C</Typography>
                        <Divider sx={{ my: 1, bgcolor: '#334155' }} />
                        <Typography variant="caption" sx={{ color: '#64748b' }}>LEVEL: {data.coolant_level || 0} %</Typography>
                    </Box>
                </Grid>

                <Grid item xs={12} md={3}>
                    <Box sx={{ p: 2, bgcolor: '#1e293b', borderRadius: 2, border: '1px solid #334155' }}>
                        <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', mb: 1 }}>FUEL SYSTEM</Typography>
                        <Typography variant="h4" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{data.fuel_pressure || 0} bar</Typography>
                        <Divider sx={{ my: 1, bgcolor: '#334155' }} />
                        <Typography variant="caption" sx={{ color: '#64748b' }}>TEMP: {data.fuel_temp || 0} °C</Typography>
                    </Box>
                </Grid>

                <Grid item xs={12} md={3}>
                    <Box sx={{ p: 2, bgcolor: '#1e293b', borderRadius: 2, border: '1px solid #334155' }}>
                        <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', mb: 1 }}>ELECTRICAL</Typography>
                        <Typography variant="h4" sx={{ color: '#4ade80', fontWeight: 'bold' }}>{data.battery_voltage || 0} V</Typography>
                        <Divider sx={{ my: 1, bgcolor: '#334155' }} />
                        <Typography variant="caption" sx={{ color: '#64748b' }}>DC BUS POTENTIAL</Typography>
                    </Box>
                </Grid>

                <Grid item xs={12} md={3}>
                    <Box sx={{ p: 2, bgcolor: '#1e293b', borderRadius: 2, border: '1px solid #334155' }}>
                        <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', mb: 1 }}>TOTAL FUEL USED</Typography>
                        <Typography variant="h4" sx={{ color: '#a78bfa', fontWeight: 'bold' }}>{data.total_fuel || 0}</Typography>
                        <Divider sx={{ my: 1, bgcolor: '#334155' }} />
                        <Typography variant="caption" sx={{ color: '#64748b' }}>LITERS (LIFETIME)</Typography>
                    </Box>
                </Grid>
            </Grid>
        </Box>
    );
}
