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

export default function CatEngineDashboard() {
    const [data, setData] = useState({});

    useEffect(() => {
        const handler = (newData) => {
            if (newData.cat_engine) setData(newData.cat_engine);
        };
        socket.on('rig_data', handler);
        return () => socket.off('rig_data', handler);
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
                            <Typography variant="h5" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{Number(data.total_hours || 0).toFixed(1)} <span style={{ fontSize: '0.6em', color: '#64748b' }}>HRS</span></Typography>
                        </Box>
                    </Paper>
                </Grid>

                <Grid item xs={12} sm={6} md={3}>
                    <GaugeCard footer={<Typography variant="caption" sx={{ color: '#64748b', mt: 1 }}>RUN: {data.run_hours || 0} HRS</Typography>}>
                        <AnalogGauge
                            value={data.rpm || 0}
                            max={2100}
                            label="ENGINE SPEED"
                            unit="RPM"
                            size="fill"
                            color="#38bdf8"
                        />
                    </GaugeCard>
                </Grid>

                <Grid item xs={12} sm={6} md={3}>
                    <GaugeCard footer={<Typography variant="caption" sx={{ color: '#64748b', mt: 1 }}>FUEL RATE: {data.fuel_rate || 0} L/H</Typography>}>
                        <AnalogGauge
                            value={data.load || 0}
                            max={100}
                            label="ENGINE LOAD"
                            unit="%"
                            size="fill"
                            color={data.load > 85 ? '#ef4444' : '#4ade80'}
                        />
                    </GaugeCard>
                </Grid>

                <Grid item xs={12} sm={6} md={3}>
                    <GaugeCard>
                        <AnalogGauge
                            value={data.oil_pressure || 0}
                            max={10}
                            label="OIL PRESSURE"
                            unit="bar"
                            size="fill"
                            color="#fbbf24"
                        />
                    </GaugeCard>
                </Grid>

                <Grid item xs={12} sm={6} md={3}>
                    <GaugeCard>
                        <AnalogGauge
                            value={data.pedal_position || 0}
                            max={100}
                            label="ACCEL PEDAL"
                            unit="%"
                            size="fill"
                            color="#a855f7"
                        />
                    </GaugeCard>
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
                        <Typography variant="h4" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{Number(data.fuel_pressure || 0).toFixed(1)} bar</Typography>
                        <Divider sx={{ my: 1, bgcolor: '#334155' }} />
                        <Typography variant="caption" sx={{ color: '#64748b' }}>TEMP: {data.fuel_temp || 0} °C</Typography>
                    </Box>
                </Grid>

                <Grid item xs={12} md={3}>
                    <Box sx={{ p: 2, bgcolor: '#1e293b', borderRadius: 2, border: '1px solid #334155' }}>
                        <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', mb: 1 }}>ELECTRICAL</Typography>
                        <Typography variant="h4" sx={{ color: '#4ade80', fontWeight: 'bold' }}>{Number(data.battery_voltage || 0).toFixed(1)} V</Typography>
                        <Divider sx={{ my: 1, bgcolor: '#334155' }} />
                        <Typography variant="caption" sx={{ color: '#64748b' }}>DC BUS POTENTIAL</Typography>
                    </Box>
                </Grid>

                <Grid item xs={12} md={3}>
                    <Box sx={{ p: 2, bgcolor: '#1e293b', borderRadius: 2, border: '1px solid #334155' }}>
                        <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block', mb: 1 }}>TOTAL FUEL USED</Typography>
                        <Typography variant="h4" sx={{ color: '#a78bfa', fontWeight: 'bold' }}>{Number(data.total_fuel || 0).toFixed(0)}</Typography>
                        <Divider sx={{ my: 1, bgcolor: '#334155' }} />
                        <Typography variant="caption" sx={{ color: '#64748b' }}>LITERS (LIFETIME)</Typography>
                    </Box>
                </Grid>
            </Grid>
        </Box>
    );
}
