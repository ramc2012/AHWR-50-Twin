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

export default function PctDashboard() {
    const [data, setData] = useState({});

    useEffect(() => {
        socket.on('rig_data', (newData) => {
            if (newData.pct) setData(newData.pct);
        });
        return () => socket.off('rig_data');
    }, []);

    const statusMapping = {
        0: { text: 'OFF', color: '#64748b' },
        1: { text: 'IDLE', color: '#38bdf8' },
        2: { text: 'ON', color: '#4ade80' }
    };

    const opModeMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'NORMAL', color: '#4ade80' },
        2: { text: 'MANUAL', color: '#fbbf24' }
    };

    const sequenceMapping = {
        0: { text: 'OFF', color: '#64748b' },
        1: { text: 'MAKE-UP', color: '#38bdf8' },
        2: { text: 'BREAK-OUT', color: '#fbbf24' },
        3: { text: 'RESET', color: '#94a3b8' },
        4: { text: 'FAULT', color: '#ef4444' }
    };

    const dollyDirectionMapping = {
        0: { text: 'NO CMD', color: '#64748b' },
        1: { text: 'MOVE UP', color: '#38bdf8' },
        2: { text: 'MOVE DOWN', color: '#4ade80' }
    };

    const dollyStatusMapping = {
        0: { text: 'NONE', color: '#64748b' },
        1: { text: 'OUT PARK', color: '#fbbf24' },
        2: { text: 'MOVE WORK', color: '#38bdf8' },
        3: { text: 'MOVE PARK', color: '#38bdf8' },
        4: { text: 'IN PARK', color: '#4ade80' },
        5: { text: 'FAULT', color: '#ef4444' },
        6: { text: 'IN WORK', color: '#4ade80' }
    };

    const spinnerRotationMapping = {
        0: { text: 'NO CMD', color: '#64748b' },
        1: { text: 'FULLY UP', color: '#4ade80' },
        2: { text: 'FULLY DOWN', color: '#4ade80' },
        3: { text: 'MAKE-UP', color: '#38bdf8' },
        4: { text: 'BREAK-OUT', color: '#fbbf24' },
        10: { text: 'NOT MOUNTED', color: '#64748b' }
    };

    const gripperMapping = {
        0: { text: 'NONE', color: '#64748b' },
        1: { text: 'OPENING', color: '#38bdf8' },
        2: { text: 'CLOSING', color: '#38bdf8' },
        3: { text: 'OPEN', color: '#4ade80' },
        4: { text: 'CLOSE', color: '#fbbf24' },
        5: { text: 'FAULT', color: '#ef4444' },
        10: { text: 'NOT MOUNTED', color: '#64748b' }
    };

    const clampRotationMapping = {
        0: { text: 'NONE', color: '#64748b' },
        1: { text: 'NOT ALLIGNED', color: '#ef4444' },
        2: { text: 'ALLIGNED', color: '#4ade80' },
        3: { text: 'MAKE-UP', color: '#38bdf8' },
        4: { text: 'BREAK-OUT', color: '#fbbf24' },
        5: { text: 'FAULT', color: '#ef4444' }
    };

    const clampStatusMapping = {
        0: { text: 'NONE', color: '#64748b' },
        1: { text: 'OPENING', color: '#38bdf8' },
        2: { text: 'CLOSING', color: '#38bdf8' },
        3: { text: 'IS OPEN', color: '#4ade80' },
        4: { text: 'IS CLOSE', color: '#fbbf24' },
        5: { text: 'FAULT', color: '#ef4444' }
    };

    const binaryMapping = (onText, offText) => ({
        0: { text: offText, color: '#64748b' },
        1: { text: onText, color: '#4ade80' }
    });

    const getStatusText = (value, mapping) => mapping[value]?.text || '---';
    const getStatusColor = (value, mapping) => mapping[value]?.color || '#64748b';

    const MechanicalItem = ({ label, value, mapping }) => {
        const text = getStatusText(value, mapping);
        const color = getStatusColor(value, mapping);
        return (
            <Box sx={{ p: 1.25, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="caption" sx={{ color: '#94a3b8' }}>{label}</Typography>
                <Box sx={{
                    bgcolor: `${color}15`,
                    color: color,
                    border: `1px solid ${color}`,
                    px: 1, py: 0.25, borderRadius: 1,
                    fontWeight: 'bold', fontSize: '0.75rem',
                    minWidth: '90px', textAlign: 'center'
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
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', display: 'flex', alignItems: 'center', gap: 2 }}>
                        <StatusIndicator label="Operation Mode" value={data.op_mode} mapping={opModeMapping} />
                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />
                        <StatusIndicator label="System Status" value={data.status} mapping={statusMapping} />
                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />
                        <StatusIndicator label="Sequence" value={data.sequence} mapping={sequenceMapping} />
                    </Paper>
                </Grid>

                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 3, bgcolor: '#1e293b', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <AnalogGauge
                            value={data.makeup_torque || 0}
                            max={5000}
                            label="MAKEUP TORQUE"
                            unit="daN*m"
                            color="#38bdf8"
                        />
                    </Paper>
                </Grid>

                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 3, bgcolor: '#1e293b', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <AnalogGauge
                            value={data.spinner_makeup_torque || 0}
                            max={2000}
                            label="SPINNER MU TORQUE"
                            unit="daN*m"
                            color="#4ade80"
                        />
                    </Paper>
                </Grid>

                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 3, bgcolor: '#1e293b', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <AnalogGauge
                            value={data.last_makeup_torque || 0}
                            max={5000}
                            label="LAST MU TORQUE"
                            unit="daN*m"
                            color="#fbbf24"
                        />
                    </Paper>
                </Grid>

                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', height: '100%' }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2 }}>DOLLY & SPINNER</Typography>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.2 }}>
                            <MechanicalItem label="DOLLY DIRECTION" value={data.dolly_direction} mapping={dollyDirectionMapping} />
                            <MechanicalItem label="DOLLY STATUS" value={data.dolly_status} mapping={dollyStatusMapping} />
                            <MechanicalItem label="SPINNER ROTATION" value={data.spinner_rotation_status} mapping={spinnerRotationMapping} />
                            <MechanicalItem label="SPINNER GRIPPER" value={data.spinner_gripper_status} mapping={gripperMapping} />
                            <MechanicalItem label="SPINNER FLOATING" value={data.spinner_floating} mapping={binaryMapping('ON', 'OFF')} />
                            <MechanicalItem label="CLAMP ROTATION" value={data.clamp_rotation_status} mapping={clampRotationMapping} />
                        </Box>
                    </Paper>
                </Grid>

                <Grid item xs={12} md={8}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', height: '100%' }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2 }}>CLAMP DETAILS</Typography>
                        <Grid container spacing={2}>
                            {/* Up Clamp */}
                            <Grid item xs={12} md={6}>
                                <Box sx={{ p: 2, bgcolor: '#0f172a', borderRadius: 2 }}>
                                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
                                        <Typography variant="subtitle2" sx={{ color: '#38bdf8' }}>UP CLAMP</Typography>
                                        <Box sx={{ color: getStatusColor(data.clamp_up_status, clampStatusMapping), fontWeight: 'bold', fontSize: '0.8rem' }}>
                                            {getStatusText(data.clamp_up_status, clampStatusMapping)}
                                        </Box>
                                    </Box>
                                    <Grid container spacing={1}>
                                        <Grid item xs={6}>
                                            <Typography variant="caption" sx={{ color: '#64748b', display: 'block' }}>PRESSURE (bar)</Typography>
                                            <Typography sx={{ color: 'white', fontWeight: 'bold' }}>{data.clamp_up_pressure || 0}</Typography>
                                            <Typography variant="caption" sx={{ color: getStatusColor(data.clamp_up_pressure_ok, binaryMapping('OK', 'LOW')), fontSize: '0.65rem' }}>
                                                {getStatusText(data.clamp_up_pressure_ok, binaryMapping('OK', 'LOW'))}
                                            </Typography>
                                        </Grid>
                                        <Grid item xs={6}>
                                            <Typography variant="caption" sx={{ color: '#64748b', display: 'block' }}>FORCE (daN)</Typography>
                                            <Typography sx={{ color: 'white', fontWeight: 'bold' }}>{data.clamp_up_force || 0}</Typography>
                                            <Typography variant="caption" sx={{ color: getStatusColor(data.clamp_up_force_ok, binaryMapping('OK', 'LOW')), fontSize: '0.65rem' }}>
                                                {getStatusText(data.clamp_up_force_ok, binaryMapping('OK', 'LOW'))}
                                            </Typography>
                                        </Grid>
                                    </Grid>
                                </Box>
                            </Grid>

                            {/* Low Clamp */}
                            <Grid item xs={12} md={6}>
                                <Box sx={{ p: 2, bgcolor: '#0f172a', borderRadius: 2 }}>
                                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
                                        <Typography variant="subtitle2" sx={{ color: '#a78bfa' }}>LOW CLAMP</Typography>
                                        <Box sx={{ color: getStatusColor(data.clamp_low_status, clampStatusMapping), fontWeight: 'bold', fontSize: '0.8rem' }}>
                                            {getStatusText(data.clamp_low_status, clampStatusMapping)}
                                        </Box>
                                    </Box>
                                    <Grid container spacing={1}>
                                        <Grid item xs={6}>
                                            <Typography variant="caption" sx={{ color: '#64748b', display: 'block' }}>PRESSURE (bar)</Typography>
                                            <Typography sx={{ color: 'white', fontWeight: 'bold' }}>{data.clamp_low_pressure || 0}</Typography>
                                            <Typography variant="caption" sx={{ color: getStatusColor(data.clamp_low_pressure_ok, binaryMapping('OK', 'LOW')), fontSize: '0.65rem' }}>
                                                {getStatusText(data.clamp_low_pressure_ok, binaryMapping('OK', 'LOW'))}
                                            </Typography>
                                        </Grid>
                                        <Grid item xs={6}>
                                            <Typography variant="caption" sx={{ color: '#64748b', display: 'block' }}>FORCE (daN)</Typography>
                                            <Typography sx={{ color: 'white', fontWeight: 'bold' }}>{data.clamp_low_force || 0}</Typography>
                                            <Typography variant="caption" sx={{ color: getStatusColor(data.clamp_low_force_ok, binaryMapping('OK', 'LOW')), fontSize: '0.65rem' }}>
                                                {getStatusText(data.clamp_low_force_ok, binaryMapping('OK', 'LOW'))}
                                            </Typography>
                                        </Grid>
                                    </Grid>
                                </Box>
                            </Grid>
                        </Grid>
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );
}
