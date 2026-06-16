import React, { useState, useEffect } from 'react';
import { Grid, Paper, Typography, Box, Divider } from '@mui/material';
import { socket } from '../../socket';
import AnalogGauge from '../Common/AnalogGauge';
import GaugeCard from '../Common/GaugeCard';

const formatReading = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toFixed(2) : '0.00';
};

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

export default function AcsDashboard() {
    const [data, setData] = useState({});

    useEffect(() => {
        const handler = (newData) => {
            if (newData.acs) setData(newData.acs);
        };
        socket.on('rig_data', handler);
        return () => socket.off('rig_data', handler);
    }, []);

    const statusMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'ON', color: '#4ade80' },
        2: { text: 'OFF', color: '#64748b' },
        3: { text: 'DISABLE', color: '#ef4444' }
    };

    const calibrationMapping = {
        '-1': { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'IN PROGRESS', color: '#38bdf8' },
        2: { text: 'NOT CALIBRATED', color: '#fbbf24' },
        3: { text: 'CALIBRATED', color: '#4ade80' },
        10: { text: 'MOVE UP', color: '#38bdf8' },
        11: { text: 'MOVE DOWN', color: '#38bdf8' }
    };

    return (
        <Box>


            <Grid container spacing={3}>
                <Grid item xs={12}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                        <StatusIndicator label="System Status" value={data.status} mapping={statusMapping} />
                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />
                        <StatusIndicator label="Calibration" value={data.calibration_status} mapping={calibrationMapping} />
                    </Paper>
                </Grid>

                <Grid item xs={12} md={6}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', height: '100%', display: 'flex', flexDirection: 'column' }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2 }}>BLOCK POSITION</Typography>
                        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', p: 3, bgcolor: '#0f172a', borderRadius: 2 }}>
                            <Typography sx={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '3rem' }}>
                                {formatReading(data.block_position)} <Typography component="span" variant="h5" sx={{ color: '#64748b' }}>mm</Typography>
                            </Typography>
                        </Box>
                    </Paper>
                </Grid>

                <Grid item xs={12} md={6}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b' }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2 }}>SAVER THRESHOLDS</Typography>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            <Box sx={{ p: 2, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography sx={{ color: '#94a3b8' }}>CROWNSAVER</Typography>
                                <Typography sx={{ color: '#ef4444', fontWeight: 'bold', fontSize: '1.2rem' }}>{data.crownsaver || 0} mm</Typography>
                            </Box>
                            <Box sx={{ p: 2, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography sx={{ color: '#94a3b8' }}>FLOORSAVER</Typography>
                                <Typography sx={{ color: '#fbbf24', fontWeight: 'bold', fontSize: '1.2rem' }}>{data.floorsaver || 0} mm</Typography>
                            </Box>
                            <Box sx={{ p: 2, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography sx={{ color: '#94a3b8' }}>BOTTOMSAVER</Typography>
                                <Typography sx={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '1.2rem' }}>{data.bottomsaver || 0} mm</Typography>
                            </Box>
                        </Box>
                    </Paper>
                </Grid>

                <Grid item xs={12} md={6}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b' }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2 }}>TAG POSITIONS</Typography>
                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <Box sx={{ flex: 1, p: 2, bgcolor: '#0f172a', borderRadius: 1, textAlign: 'center' }}>
                                <Typography variant="h4" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{data.upper_tag || 0}</Typography>
                                <Typography variant="caption" sx={{ color: '#64748b' }}>UPPER TAG (mm)</Typography>
                            </Box>
                            <Box sx={{ flex: 1, p: 2, bgcolor: '#0f172a', borderRadius: 1, textAlign: 'center' }}>
                                <Typography variant="h4" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{data.lower_tag || 0}</Typography>
                                <Typography variant="caption" sx={{ color: '#64748b' }}>LOWER TAG (mm)</Typography>
                            </Box>
                        </Box>
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );
}
