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

export default function HtdDashboard() {
    const [data, setData] = useState({});

    useEffect(() => {
        socket.on('rig_data', (newData) => {
            if (newData.htd) setData(newData.htd);
        });
        return () => socket.off('rig_data');
    }, []);

    const statusMapping = {
        0: { text: 'OFF', color: '#64748b' },
        1: { text: 'IDLE', color: '#38bdf8' },
        2: { text: 'ON', color: '#4ade80' }
    };

    const workModeMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'DRILL', color: '#4ade80' },
        2: { text: 'SPIN', color: '#38bdf8' },
        3: { text: 'TORQUE', color: '#fbbf24' }
    };

    const rotationMapping = {
        0: { text: 'STOPPED', color: '#64748b' },
        1: { text: 'FWD', color: '#4ade80' },
        2: { text: 'BWD', color: '#fbbf24' },
        3: { text: 'NEUTRAL', color: '#94a3b8' }
    };

    const lubeMapping = {
        0: { text: 'OFF', color: '#64748b' },
        1: { text: 'CMD RUN', color: '#38bdf8' },
        2: { text: 'RUNNING', color: '#4ade80' },
        3: { text: 'FAULT', color: '#ef4444' }
    };

    const brakeMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'CLOSING', color: '#38bdf8' },
        2: { text: 'CLOSED', color: '#fbbf24' },
        3: { text: 'OPENING', color: '#38bdf8' },
        4: { text: 'OPEN', color: '#4ade80' },
        5: { text: 'FAULT', color: '#ef4444' }
    };

    const elevatorMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'OPENING', color: '#38bdf8' },
        2: { text: 'CLOSING', color: '#38bdf8' },
        3: { text: 'OPEN', color: '#4ade80' },
        4: { text: 'CLOSE', color: '#fbbf24' },
        5: { text: 'FAULT', color: '#ef4444' }
    };

    const linkRotationMapping = {
        0: { text: 'UNKNOWN', color: '#64748b' },
        1: { text: 'UNLOCKING', color: '#38bdf8' },
        2: { text: 'UNLOCKED', color: '#fbbf24' },
        3: { text: 'ROT FWD', color: '#4ade80' },
        4: { text: 'ROT BWD', color: '#fbbf24' },
        5: { text: 'LOCKING', color: '#38bdf8' },
        6: { text: 'LOCKED', color: '#4ade80' },
        7: { text: 'FAULT', color: '#ef4444' }
    };

    const gearMapping = {
        '-2': { text: 'UNKNOWN', color: '#64748b' },
        '-1': { text: 'FAULT', color: '#ef4444' },
        1: { text: 'GEAR 1', color: '#38bdf8' },
        2: { text: 'GEAR 2', color: '#38bdf8' },
        3: { text: 'GEAR 3', color: '#38bdf8' },
        4: { text: 'GEAR 4', color: '#38bdf8' },
        5: { text: 'G1 REGEN', color: '#4ade80' },
        6: { text: 'G2 REGEN', color: '#4ade80' },
        7: { text: 'G3 REGEN', color: '#4ade80' },
        8: { text: 'G4 REGEN', color: '#4ade80' }
    };

    const suspensionMapping = {
        0: { text: 'NONE', color: '#64748b' },
        1: { text: 'PUSH', color: '#4ade80' },
        2: { text: 'PULL', color: '#38bdf8' }
    };

    const tiltDb65Mapping = {
        1: { text: 'TILTING IN', color: '#38bdf8' },
        2: { text: 'TILT IN', color: '#4ade80' },
        3: { text: 'TILTING OUT', color: '#38bdf8' },
        4: { text: 'TILT OUT', color: '#fbbf24' },
        5: { text: 'HALF WAY', color: '#94a3b8' },
        6: { text: 'STAND STILL', color: '#64748b' }
    };

    const inclinationStatusMapping = {
        1: { text: 'IN PROG (IN)', color: '#38bdf8' },
        2: { text: 'INCLINATED IN', color: '#4ade80' },
        3: { text: 'IN PROG (OUT)', color: '#38bdf8' },
        4: { text: 'INCLINATED OUT', color: '#fbbf24' },
        5: { text: 'HALF WAY', color: '#94a3b8' },
        6: { text: 'STAND STILL', color: '#64748b' },
        7: { text: 'TILTED IN', color: '#4ade80' },
        8: { text: 'TILTED OUT', color: '#fbbf24' }
    };

    const getStatusText = (value, mapping) => mapping[value]?.text || '---';
    const getStatusColor = (value, mapping) => mapping[value]?.color || '#64748b';

    return (
        <Box>

            <Grid container spacing={3}>
                <Grid item xs={12}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                        <StatusIndicator label="System Status" value={data.status} mapping={statusMapping} />
                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />
                        <StatusIndicator label="Work Mode" value={data.work_mode} mapping={workModeMapping} />
                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />
                        <StatusIndicator label="Rotation" value={data.rotation_status} mapping={rotationMapping} />
                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />
                        <StatusIndicator label="Lube" value={data.lube_status} mapping={lubeMapping} />
                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />
                        <StatusIndicator label="Brake" value={data.brake_status} mapping={brakeMapping} />
                    </Paper>
                </Grid>

                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 3, bgcolor: '#1e293b', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <AnalogGauge
                            value={data.rpm || 0}
                            max={250}
                            label="TOP DRIVE RPM"
                            unit="RPM"
                            color="#38bdf8"
                        />
                        <Typography variant="caption" sx={{ color: '#64748b', mt: 1 }}>REQ: {data.rpm_request || 0} | CMD: {data.rpm_command || 0}</Typography>
                    </Paper>
                </Grid>

                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 3, bgcolor: '#1e293b', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <AnalogGauge
                            value={data.torque || 0}
                            max={5000}
                            label="HTD TORQUE"
                            unit="daN*m"
                            color="#fbbf24"
                        />
                        <Typography variant="caption" sx={{ color: '#64748b', mt: 1 }}>REQ: {data.torque_request || 0} | CMD: {data.torque_command || 0}</Typography>
                    </Paper>
                </Grid>

                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 3, bgcolor: '#1e293b', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <AnalogGauge
                            value={data.inclination || 0}
                            max={100}
                            label="INCLINATION"
                            unit="%"
                            color="#a78bfa"
                        />
                    </Paper>
                </Grid>

                {/* MECHANISMS & LINKS */}
                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', height: '100%' }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2 }}>MECHANISMS & LINKS</Typography>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                            {[
                                { label: 'ELEVATOR', value: data.elevator_status, mapping: elevatorMapping },
                                { label: 'IBOP', value: data.ibop_status, mapping: elevatorMapping },
                                { label: 'LINK ROTATION', value: data.link_rotation_status, mapping: linkRotationMapping }
                            ].map((item, idx) => {
                                const active = item.mapping[item.value] || { text: '---', color: '#64748b' };
                                return (
                                    <Box key={idx} sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                        <Typography variant="caption" sx={{ color: '#94a3b8' }}>{item.label}</Typography>
                                        <Box sx={{
                                            bgcolor: `${active.color}15`,
                                            color: active.color,
                                            border: `1px solid ${active.color}`,
                                            px: 1.5, py: 0.25, borderRadius: 1,
                                            fontWeight: 'bold', fontSize: '0.75rem',
                                            minWidth: '80px', textAlign: 'center'
                                        }}>
                                            {active.text}
                                        </Box>
                                    </Box>
                                );
                            })}
                        </Box>
                    </Paper>
                </Grid>

                {/* DRIVE SYSTEM */}
                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', height: '100%' }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2 }}>DRIVE SYSTEM</Typography>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                            <Box sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8' }}>GEAR SELECTION</Typography>
                                <Typography sx={{ color: getStatusColor(data.gear_status, gearMapping), fontWeight: 'bold', fontSize: '0.875rem' }}>
                                    {getStatusText(data.gear_status, gearMapping)}
                                </Typography>
                            </Box>
                            <Box sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8' }}>SUSPENSION</Typography>
                                <Typography sx={{ color: getStatusColor(data.suspension_status, suspensionMapping), fontWeight: 'bold', fontSize: '0.875rem' }}>
                                    {getStatusText(data.suspension_status, suspensionMapping)}
                                </Typography>
                            </Box>
                            <Box sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8' }}>V-SPEED</Typography>
                                <Typography sx={{ color: '#38bdf8', fontWeight: 'bold', fontSize: '0.875rem' }}>
                                    {data.vertical_speed || 0} m/s
                                </Typography>
                            </Box>
                        </Box>
                    </Paper>
                </Grid>

                {/* MISSION STATS */}
                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 2, bgcolor: '#1e293b', height: '100%' }}>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 2 }}>MISSION STATS</Typography>
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                            <Box sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8' }}>RUNTIME</Typography>
                                <Typography sx={{ color: '#4ade80', fontWeight: 'bold', fontSize: '0.875rem' }}>
                                    {data.working_hours || 0}H {data.working_minutes || 0}M
                                </Typography>
                            </Box>
                            <Box sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8' }}>TILT</Typography>
                                <Typography sx={{ color: getStatusColor(data.tilt_status_db65, tiltDb65Mapping), fontWeight: 'bold', fontSize: '0.75rem' }}>
                                    {getStatusText(data.tilt_status_db65, tiltDb65Mapping)}
                                </Typography>
                            </Box>
                            <Box sx={{ p: 1.5, bgcolor: '#0f172a', borderRadius: 1, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8' }}>INCLINATION</Typography>
                                <Typography sx={{ color: getStatusColor(data.inclination_status, inclinationStatusMapping), fontWeight: 'bold', fontSize: '0.75rem' }}>
                                    {getStatusText(data.inclination_status, inclinationStatusMapping)}
                                </Typography>
                            </Box>
                        </Box>
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );
}
