import React, { useState, useEffect } from 'react';
import { Grid, Paper, Typography, Box, Divider, useTheme } from '@mui/material';
import { socket } from '../../socket';
import EdrView from '../EDR/EdrView';

// ---- Local reusable presentational helpers (flatter/denser than analog dials) ----

// Compact numeric tile: big value + unit + small label, optional thin range bar
// that turns amber/red near the configured warn/critical thresholds.
const ValueTile = ({ label, value, unit, decimals = 0, color = 'primary.main', min = 0, max, warn, crit, sub }) => {
    const num = Number(value);
    const has = Number.isFinite(num);
    const display = has ? num.toFixed(decimals) : '--';

    let accent = color;
    let ratio = null;
    if (has && Number.isFinite(max) && max > min) {
        ratio = Math.min(Math.max((num - min) / (max - min), 0), 1);
        const wr = warn != null ? (warn - min) / (max - min) : null;
        const cr = crit != null ? (crit - min) / (max - min) : null;
        if (cr != null && ratio >= cr) accent = '#ef4444';
        else if (wr != null && ratio >= wr) accent = '#fbbf24';
    }

    return (
        <Paper sx={{ p: 1.5, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider', borderRadius: 2, height: '100%', display: 'flex', flexDirection: 'column' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', fontSize: '0.66rem' }} noWrap>{label}</Typography>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, mt: 0.25 }}>
                <Typography sx={{ color: accent, fontWeight: 800, fontSize: '1.7rem', lineHeight: 1.05 }}>{display}</Typography>
                {unit && <Typography sx={{ color: 'text.secondary', fontWeight: 600, fontSize: '0.78rem' }}>{unit}</Typography>}
            </Box>
            {ratio != null && (
                <Box sx={{ mt: 'auto', pt: 1 }}>
                    <Box sx={{ height: 5, borderRadius: 3, bgcolor: 'action.hover', overflow: 'hidden' }}>
                        <Box sx={{ width: `${ratio * 100}%`, height: '100%', bgcolor: accent, borderRadius: 3, transition: 'width .4s ease' }} />
                    </Box>
                </Box>
            )}
            {sub && <Typography variant="caption" sx={{ color: 'text.secondary', mt: ratio != null ? 0.5 : 'auto', pt: ratio != null ? 0 : 1, fontSize: '0.62rem' }} noWrap>{sub}</Typography>}
        </Paper>
    );
};

// Small enum/status chip: maps a numeric code -> { text, color }.
const StatusChip = ({ label, value, mapping }) => {
    const active = mapping[value] || { text: '---', color: '#64748b' };
    return (
        <Box sx={{ textAlign: 'center', px: 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5, fontSize: '0.62rem', fontWeight: 700 }}>{label.toUpperCase()}</Typography>
            <Box sx={{
                bgcolor: `${active.color}1f`,
                color: active.color,
                border: `1px solid ${active.color}`,
                px: 1.5, py: 0.5, borderRadius: 1,
                fontWeight: 'bold', fontSize: '0.8rem', whiteSpace: 'nowrap'
            }}>
                {active.text}
            </Box>
        </Box>
    );
};

// EDR side-strip configuration — CAT engine analog channels (cat_engine.*).
const EDR_CHANNELS = [
    'cat_engine.rpm', 'cat_engine.load', 'cat_engine.coolant_temp',
    'cat_engine.oil_pressure', 'cat_engine.fuel_rate', 'cat_engine.fuel_pressure',
    'cat_engine.battery_voltage'
];
const EDR_STRIPS = [
    {
        title: 'Engine',
        pens: [
            { channelId: 'cat_engine.rpm', color: '#38bdf8', min: 0, max: 2000, enabled: true },
            { channelId: 'cat_engine.coolant_temp', color: '#f97316', min: 0, max: 120, enabled: true },
            { channelId: 'cat_engine.oil_pressure', color: '#fbbf24', min: 0, max: 10, enabled: true }
        ]
    }
];

const SectionTitle = ({ children }) => (
    <Typography sx={{ color: 'text.secondary', fontSize: '0.7rem', fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', mb: 1 }}>{children}</Typography>
);

export default function CatEngineDashboard() {
    const theme = useTheme();
    const surface = theme.palette.background.paper;
    const border = theme.palette.divider;
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
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'stretch', gap: 2 }}>
            {/* Main content */}
            <Box sx={{ flex: '1 1 560px', minWidth: 0 }}>
                <Grid container spacing={2}>
                    {/* Status & lifetime header */}
                    <Grid item xs={12}>
                        <Paper sx={{ p: 1.75, bgcolor: surface, border: `1px solid ${border}`, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                            <StatusChip label="Engine Status" value={data.status} mapping={statusMapping} />
                            <Divider orientation="vertical" flexItem sx={{ borderColor: border }} />
                            <StatusChip label="Source Cmd" value={data.source_cmd} mapping={sourceMapping} />
                            <Box sx={{ ml: 'auto', textAlign: 'right', pr: 1, display: 'flex', gap: 3 }}>
                                <Box>
                                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: '0.62rem', fontWeight: 700 }}>RUN HOURS</Typography>
                                    <Typography variant="h6" sx={{ color: 'text.primary', fontWeight: 'bold' }}>{Number(data.run_hours || 0).toFixed(1)} <span style={{ fontSize: '0.55em', color: '#64748b' }}>HRS</span></Typography>
                                </Box>
                                <Box>
                                    <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', fontSize: '0.62rem', fontWeight: 700 }}>TOTAL ENGINE HOURS</Typography>
                                    <Typography variant="h6" sx={{ color: 'primary.main', fontWeight: 'bold' }}>{Number(data.total_hours || 0).toFixed(1)} <span style={{ fontSize: '0.55em', color: '#64748b' }}>HRS</span></Typography>
                                </Box>
                            </Box>
                        </Paper>
                    </Grid>

                    {/* PERFORMANCE */}
                    <Grid item xs={12}>
                        <SectionTitle>Performance</SectionTitle>
                        <Grid container spacing={1.5}>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Engine Speed" value={data.rpm} unit="RPM" color="#38bdf8" min={0} max={2100} warn={1900} crit={2000} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Engine Load" value={data.load} unit="%" color="#4ade80" min={0} max={100} warn={70} crit={85} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Accel Pedal" value={data.pedal_position} unit="%" color="#a855f7" min={0} max={100} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Fuel Rate" value={data.fuel_rate} unit="L/h" decimals={1} color="#22d3ee" min={0} max={200} warn={160} />
                            </Grid>
                        </Grid>
                    </Grid>

                    {/* LUBRICATION & COOLING */}
                    <Grid item xs={12}>
                        <SectionTitle>Lubrication & Cooling</SectionTitle>
                        <Grid container spacing={1.5}>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Oil Pressure" value={data.oil_pressure} unit="bar" decimals={1} color="#fbbf24" min={0} max={10} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Coolant Temp" value={data.coolant_temp} unit="°C" color="#f97316" min={0} max={120} warn={95} crit={105} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Coolant Level" value={data.coolant_level} unit="%" color="#22d3ee" min={0} max={100} />
                            </Grid>
                        </Grid>
                    </Grid>

                    {/* FUEL & ELECTRICAL */}
                    <Grid item xs={12}>
                        <SectionTitle>Fuel & Electrical</SectionTitle>
                        <Grid container spacing={1.5}>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Fuel Pressure" value={data.fuel_pressure} unit="bar" decimals={1} color="#38bdf8" min={0} max={10} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Fuel Temp" value={data.fuel_temp} unit="°C" color="#f97316" min={0} max={100} warn={80} />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Total Fuel Used" value={data.total_fuel} unit="L" color="#a78bfa" sub="Lifetime consumption" />
                            </Grid>
                            <Grid item xs={6} sm={4} md={3}>
                                <ValueTile label="Battery Voltage" value={data.battery_voltage} unit="V" decimals={1} color="#4ade80" sub="DC bus potential" />
                            </Grid>
                        </Grid>
                    </Grid>
                </Grid>
            </Box>

            {/* Persistent EDR side strip */}
            <Box
                sx={{
                    flex: { xs: '1 1 100%', lg: '0 0 400px' },
                    width: { xs: '100%', lg: 400 },
                    minHeight: { xs: 420, lg: 560 },
                    height: { lg: 'calc(100vh - 220px)' },
                    display: 'flex',
                    flexDirection: 'column'
                }}
            >
                <Paper sx={{ flex: 1, minHeight: 0, p: 1.25, bgcolor: surface, border: `1px solid ${border}`, borderRadius: 2, display: 'flex', flexDirection: 'column' }}>
                    <Typography sx={{ color: 'text.secondary', fontSize: '0.72rem', fontWeight: 800, letterSpacing: 0.6, textTransform: 'uppercase', mb: 0.75 }}>
                        Engine Trends
                    </Typography>
                    <Box sx={{ flex: 1, minHeight: 0 }}>
                        <EdrView mode="compact" storageKey="edr-engine-1" defaultStrips={EDR_STRIPS} channels={EDR_CHANNELS} />
                    </Box>
                </Paper>
            </Box>
        </Box>
    );
}
