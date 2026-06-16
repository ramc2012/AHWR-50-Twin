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

const GridStatus = ({ label, value, mapping }) => {
    const active = mapping[value] || { text: 'Unknown', color: '#64748b' };
    return (
        <Paper sx={{ p: 2, bgcolor: '#0f172a', borderLeft: `4px solid ${active.color}` }}>
            <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block' }}>{label.toUpperCase()}</Typography>
            <Typography sx={{ color: active.color, fontWeight: 'bold' }}>{active.text}</Typography>
        </Paper>
    );
};

export default function CwkDashboard() {
    const [data, setData] = useState({});

    useEffect(() => {
        const handler = (newData) => {
            if (newData.cwk) setData(newData.cwk);
        };
        socket.on('rig_data', handler);
        return () => socket.off('rig_data', handler);
    }, []);

    const statusMapping = {
        0: { text: 'NOT IN PARK', color: '#fbbf24' },
        1: { text: 'PARK POSITION', color: '#4ade80' }
    };

    const sourceMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'DCC', color: '#38bdf8' },
        2: { text: 'RADIO', color: '#a78bfa' }
    };

    const binaryMapping = (onText, offText) => ({
        1: { text: onText, color: '#4ade80' },
        2: { text: offText, color: '#fbbf24' },
        3: { text: 'FAULT', color: '#ef4444' }
    });

    const mechanicalMapping = {
        1: { text: 'IDLE', color: '#64748b' },
        2: { text: 'PARKING', color: '#38bdf8' },
        3: { text: 'FORWARD', color: '#4ade80' },
        4: { text: 'BACKWARD', color: '#fbbf24' },
        5: { text: 'FAULT', color: '#ef4444' }
    };

    const carrierMapping = {
        1: { text: 'STOP', color: '#64748b' },
        2: { text: 'PARK POS', color: '#64748b' },
        3: { text: 'WORK POS', color: '#4ade80' },
        4: { text: 'LIFTING', color: '#38bdf8' },
        5: { text: 'LOWERING', color: '#fbbf24' },
        6: { text: 'FAULT', color: '#ef4444' }
    };

    const clampMapping = {
        0: { text: 'NONE', color: '#64748b' },
        1: { text: 'OPENING', color: '#38bdf8' },
        2: { text: 'CLOSING', color: '#38bdf8' },
        3: { text: 'IS OPEN', color: '#4ade80' },
        4: { text: 'IS CLOSE', color: '#fbbf24' },
        5: { text: 'FAULT', color: '#ef4444' }
    };

    const okMapping = {
        0: { text: 'NOT OK', color: '#ef4444' },
        1: { text: 'OK', color: '#4ade80' }
    };

    const getStatusText = (value, mapping) => mapping[value]?.text || '---';
    const getStatusColor = (value, mapping) => mapping[value]?.color || '#64748b';

    const MechanicalItem = ({ label, value, mapping }) => {
        const text = getStatusText(value, mapping);
        const color = getStatusColor(value, mapping);
        return (
            <Box sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="caption" sx={{ color: '#94a3b8' }}>{label}</Typography>
                <Box sx={{
                    bgcolor: `${color}15`,
                    color: color,
                    border: `1px solid ${color}`,
                    px: 1.5, py: 0.25, borderRadius: 1,
                    fontWeight: 'bold', fontSize: '0.75rem',
                    minWidth: '80px', textAlign: 'center'
                }}>
                    {text}
                </Box>
            </Box>
        );
    };

    return (
        <Box>

            <Grid container spacing={3}>
                <Grid item xs={12}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                        <StatusIndicator label="Global Status" value={data.status} mapping={statusMapping} />
                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />
                        <StatusIndicator label="Source Cmd" value={data.source_cmd} mapping={sourceMapping} />
                        <Box sx={{ ml: 'auto', textAlign: 'right', pr: 2 }}>
                            <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block' }}>CLAMP PRESSURE</Typography>
                            <Typography variant="h5" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{formatReading(data.clamp_pressure)} <span style={{ fontSize: '0.6em', color: '#64748b' }}>bar</span></Typography>
                        </Box>
                    </Paper>
                </Grid>

                <Grid item xs={12} md={4}>
                    <GaugeCard>
                        <AnalogGauge
                            value={data.clamp_pressure || 0}
                            max={250}
                            label="CLAMP PRESSURE"
                            unit="bar"
                            size="fill"
                            color="#38bdf8"
                            valueDecimals={2}
                        />
                    </GaugeCard>
                </Grid>

                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', height: '100%' }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2 }}>COMPONENTS</Typography>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                            <MechanicalItem label="INDEXER DX" value={data.indexer_dx} mapping={binaryMapping('UP', 'DOWN')} />
                            <MechanicalItem label="INDEXER SX" value={data.indexer_sx} mapping={binaryMapping('UP', 'DOWN')} />
                            <MechanicalItem label="KICKERS DX" value={data.kickers_dx} mapping={binaryMapping('EXTEND', 'RETRACT')} />
                            <MechanicalItem label="KICKERS SX" value={data.kickers_sx} mapping={binaryMapping('EXTEND', 'RETRACT')} />
                            <MechanicalItem label="SKATE" value={data.skate_status} mapping={mechanicalMapping} />
                            <MechanicalItem label="SLIDE" value={data.slide_status} mapping={mechanicalMapping} />
                        </Box>
                    </Paper>
                </Grid>

                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', height: '100%' }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2 }}>CLAMP & CARRIER</Typography>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                            <MechanicalItem label="CARRIER" value={data.carrier_status} mapping={carrierMapping} />
                            <MechanicalItem label="CLAMP STATUS" value={data.clamp_status} mapping={clampMapping} />
                            <Divider sx={{ bgcolor: '#334155', my: 1 }} />
                            <Box sx={{ p: 1.25, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Box>
                                    <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block' }}>CLAMP PRESSURE</Typography>
                                    <Typography sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{formatReading(data.clamp_pressure)} bar</Typography>
                                </Box>
                                <Box sx={{ textAlign: 'right' }}>
                                    <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block' }}>STATUS</Typography>
                                    <Typography sx={{ color: getStatusColor(data.clamp_pressure_ok, okMapping), fontWeight: 'bold', fontSize: '0.75rem' }}>
                                        {getStatusText(data.clamp_pressure_ok, okMapping)}
                                    </Typography>
                                </Box>
                            </Box>
                            <Box sx={{ p: 1.25, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Box>
                                    <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block' }}>CLAMP FORCE</Typography>
                                    <Typography sx={{ color: '#a78bfa', fontWeight: 'bold' }}>{formatReading(data.clamp_force)} daN</Typography>
                                </Box>
                                <Box sx={{ textAlign: 'right' }}>
                                    <Typography variant="caption" sx={{ color: '#94a3b8', display: 'block' }}>STATUS</Typography>
                                    <Typography sx={{ color: getStatusColor(data.clamp_force_ok, okMapping), fontWeight: 'bold', fontSize: '0.75rem' }}>
                                        {getStatusText(data.clamp_force_ok, okMapping)}
                                    </Typography>
                                </Box>
                            </Box>
                        </Box>
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );
}
