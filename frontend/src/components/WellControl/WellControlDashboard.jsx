import React, { useState, useEffect } from 'react';
import { Box, Typography, Grid, Paper, Divider, useTheme } from '@mui/material';
import { LineChart } from 'lucide-react';
import { socket } from '../../socket';
import BOPStack from './BOPStack';
import KillSheet from './KillSheet';
import axios from '../../api';
import EdrView from '../EDR/EdrView';

const DASH = '—'; // em dash for "no data"

// Semantic status colors (kept across all themes intentionally).
const STATUS = { ok: '#4ade80', warn: '#fbbf24', fail: '#ef4444' };

// ---- Local presentational helpers (flat/dense tiles instead of analog dials) ----

// Compact value tile: big value + unit + label + thin range bar that turns
// amber/red near a configured limit. Supports a `lowCrit`/`lowWarn` accent for
// values that are dangerous when LOW (e.g. accumulator pressure). When `noData`
// is set the tile honestly renders an em-dash + NO DATA and no range bar — a dead
// BOP feed must never look like a healthy reading.
const ValueTile = ({
    label, value, unit, decimals = 0, color = '#38bdf8',
    min = 0, max, warn, crit, lowWarn, lowCrit, sub, noData = false
}) => {
    const num = Number(value);
    const has = !noData && Number.isFinite(num);
    const display = has ? num.toFixed(decimals) : DASH;

    let accent = color;
    let ratio = null;
    if (has && Number.isFinite(max) && max > min) {
        ratio = Math.min(Math.max((num - min) / (max - min), 0), 1);
        // High-side thresholds.
        if (crit != null && num >= crit) accent = STATUS.fail;
        else if (warn != null && num >= warn) accent = STATUS.warn;
        // Low-side thresholds take precedence when tripped (e.g. accumulator low).
        if (lowCrit != null && num <= lowCrit) accent = STATUS.fail;
        else if (lowWarn != null && num <= lowWarn) accent = STATUS.warn;
    }

    return (
        <Paper sx={{ p: 1.5, bgcolor: 'background.paper', border: '1px solid', borderColor: noData ? 'divider' : (accent === color ? 'divider' : accent), borderRadius: 2, height: '100%', display: 'flex', flexDirection: 'column', opacity: noData ? 0.6 : 1 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', fontSize: '0.66rem' }} noWrap>{label}</Typography>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, mt: 0.25 }}>
                <Typography sx={{ color: has ? accent : 'text.secondary', fontWeight: 800, fontSize: '1.7rem', lineHeight: 1.05 }}>{display}</Typography>
                <Typography sx={{ color: 'text.secondary', fontWeight: 600, fontSize: '0.78rem' }}>{noData ? 'NO DATA' : unit}</Typography>
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

const StatusChip = ({ label, value, mapping }) => {
    const active = mapping[value] || { text: '---', color: '#64748b' };
    return (
        <Box sx={{ textAlign: 'center' }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 0.5, fontSize: '0.62rem', fontWeight: 700 }}>{label.toUpperCase()}</Typography>
            <Box sx={{
                bgcolor: `${active.color}1f`,
                color: active.color,
                border: `1px solid ${active.color}`,
                px: 1.25, py: 0.5, borderRadius: 1,
                fontWeight: 'bold', fontSize: '0.78rem', whiteSpace: 'nowrap'
            }}>
                {active.text}
            </Box>
        </Box>
    );
};

const SectionTitle = ({ children }) => (
    <Typography sx={{ color: 'text.secondary', fontSize: '0.7rem', fontWeight: 800, letterSpacing: 0.8, textTransform: 'uppercase', mb: 1 }}>{children}</Typography>
);

// EDR side-strip definition. The drilling catalog (shared/edrMetrics.json) has no
// dedicated wellhead tubing/casing pressure channels, so we map the requested
// tubing/casing pens to the closest catalogued pressure proxies (HPU discharge /
// aux) alongside pump pressure. Keeping channelIds valid avoids EdrView's
// unknown-id fallback to drilling.hook_load.
const EDR_CHANNELS = ['wellhead.tubing_pressure', 'wellhead.casing_pressure', 'wellhead.wellhead_pressure', 'mudpump.pressure', 'fluid.tank_gain_loss', 'fluid.total_tank_volume'];
const EDR_STRIPS = [
    { title: 'Wellhead Pressures', pens: [
        { channelId: 'wellhead.tubing_pressure', color: '#38bdf8', min: 0, max: 350, enabled: true },
        { channelId: 'wellhead.casing_pressure', color: '#fbbf24', min: 0, max: 350, enabled: true },
        { channelId: 'mudpump.pressure', color: '#4ade80', min: 0, max: 500, enabled: true }
    ] }
];

const WellControlDashboard = () => {
    const theme = useTheme();
    // State for Well Control Data (psi).
    const [wcData, setWcData] = useState({
        annular_pressure: 0,
        manifold_pressure: 0,
        accumulator_pressure: 0,
        annular_open: false,
        annular_close: false,
        pipe_ram_open: false,
        pipe_ram_close: false,
        blind_ram_open: false,
        blind_ram_close: false,
        shear_ram_open: false
    });

    // Wellhead surface pressures (bar). These come from `wellhead.*`, a separate
    // measurement from the BOP `well_control.*` source, so they remain live even
    // when the BOP feed is unavailable.
    const [wellhead, setWellhead] = useState({ tubing_pressure: 0, casing_pressure: 0, wellhead_pressure: 0, hasData: false });

    // Honest telemetry state. Until proven live + fresh, treat as NOT available.
    const [feed, setFeed] = useState({
        connected: socket.connected,
        available: false, // well_control.available === true
        stale: false,     // data._meta.stale
        hasData: false
    });

    useEffect(() => {
        // Fetch latest data on mount
        axios.get('/api/rig/latest')
            .then(({ data }) => {
                applyData(data);
            })
            .catch(err => console.error("Failed to fetch latest well control data:", err));

        const handler = (newData) => applyData(newData);
        socket.on('rig_data', handler);

        const handleConnect = () => setFeed(prev => ({ ...prev, connected: true }));
        const handleDisconnect = () => setFeed(prev => ({ ...prev, connected: false }));
        socket.on('connect', handleConnect);
        socket.on('disconnect', handleDisconnect);

        return () => {
            socket.off('rig_data', handler);
            socket.off('connect', handleConnect);
            socket.off('disconnect', handleDisconnect);
        };
    }, []);

    const applyData = (newData) => {
        if (!newData) return;
        const wc = newData.well_control;
        const meta = newData._meta;
        const available = !!(wc && wc.available !== false);
        setFeed(prev => ({
            connected: socket.connected,
            available,
            stale: meta ? !!meta.stale : prev.stale,
            hasData: true
        }));
        if (available && wc) {
            processWellControlData(wc);
        }
        // Wellhead surface pressures are an independent source — always apply.
        if (newData.wellhead) {
            setWellhead(prev => ({
                tubing_pressure: Number(newData.wellhead.tubing_pressure) || 0,
                casing_pressure: Number(newData.wellhead.casing_pressure) || 0,
                wellhead_pressure: Number(newData.wellhead.wellhead_pressure) || 0,
                hasData: true
            }));
        }
    };

    const processWellControlData = (wellControlData) => {
        setWcData({
            annular_pressure: Number(wellControlData.annular_pressure) || 0,
            manifold_pressure: Number(wellControlData.manifold_pressure) || 0,
            accumulator_pressure: Number(wellControlData.accumulator_pressure) || 0,
            annular: { open: Number(wellControlData.annular_open) > 0, close: Number(wellControlData.annular_close) > 0 },
            pipe: { open: Number(wellControlData.pipe_ram_open) > 0, close: Number(wellControlData.pipe_ram_close) > 0 },
            blind: { open: Number(wellControlData.blind_ram_open) > 0, close: Number(wellControlData.blind_ram_close) > 0 },
            shear: Number(wellControlData.shear_ram_open) > 0
        });
    };

    // Data is only trustworthy/live when connected, available, and not stale.
    const isLive = feed.connected && feed.available && !feed.stale;
    // Wellhead surface feed: live whenever the socket is up, fresh, and we've seen data.
    const wellheadLive = feed.connected && !feed.stale && wellhead.hasData;
    const banner = !feed.connected
        ? { text: 'WELL CONTROL TELEMETRY UNAVAILABLE - SOCKET DISCONNECTED', color: STATUS.fail }
        : (!feed.available
            ? { text: 'WELL CONTROL TELEMETRY UNAVAILABLE - NO BOP DATA SOURCE', color: STATUS.fail }
            : (feed.stale
                ? { text: 'NO LIVE DATA - WELL CONTROL FEED IS STALE', color: STATUS.warn }
                : (!feed.hasData
                    ? { text: 'WAITING FOR WELL CONTROL TELEMETRY...', color: STATUS.warn }
                    : null)));

    // BOP ram open/close digital inputs -> status chips.
    const ramMap = (ram) => {
        if (!isLive || !ram) return 0;       // no live data
        if (ram.close) return 2;             // closed
        if (ram.open) return 1;              // open
        return 3;                            // indeterminate (neither limit)
    };
    const ramMapping = {
        0: { text: 'NO DATA', color: '#64748b' },
        1: { text: 'OPEN', color: STATUS.warn },
        2: { text: 'CLOSED', color: STATUS.ok },
        3: { text: 'MID / ???', color: STATUS.fail }
    };
    const shearMapping = {
        0: { text: 'NO DATA', color: '#64748b' },
        1: { text: 'FIRED', color: STATUS.fail },
        2: { text: 'ARMED', color: STATUS.ok }
    };
    const shearVal = !isLive ? 0 : (wcData.shear ? 1 : 2);

    return (
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', flexWrap: { xs: 'wrap', lg: 'nowrap' }, maxWidth: '100%' }}>
            {/* Main content column */}
            <Box sx={{ flex: '1 1 560px', minWidth: 0 }}>
                <Typography variant="h5" sx={{ mb: 1.5, fontWeight: 'bold', color: theme.palette.text.primary }}>Well Control & BOP</Typography>

                {/* Honest telemetry banner: a dead/unavailable feed must NOT look like a safe closed BOP. */}
                {banner && (
                    <Box sx={{
                        mb: 2, px: 2, py: 1.25, borderRadius: 1.5,
                        bgcolor: `${banner.color}1a`,
                        border: `1px solid ${banner.color}`,
                        display: 'flex', alignItems: 'center', gap: 1.5
                    }}>
                        <Box sx={{ width: 12, height: 12, borderRadius: '50%', bgcolor: banner.color, boxShadow: `0 0 10px ${banner.color}` }} />
                        <Typography variant="subtitle1" sx={{ color: banner.color, fontWeight: 'bold', letterSpacing: 0.5 }}>
                            {banner.text}
                        </Typography>
                    </Box>
                )}

                {/* Wellhead surface pressures (bar) — the live well-control surface readings. */}
                <Box sx={{ mb: 2 }}>
                    <SectionTitle>Wellhead Pressures</SectionTitle>
                    <Grid container spacing={1.5}>
                        <Grid item xs={6} sm={4}>
                            <ValueTile label="Tubing Press" value={wellhead.tubing_pressure} unit="bar" decimals={1} color="#38bdf8" min={0} max={250} warn={170} crit={200} noData={!wellheadLive} />
                        </Grid>
                        <Grid item xs={6} sm={4}>
                            <ValueTile label="Casing Press" value={wellhead.casing_pressure} unit="bar" decimals={1} color="#fbbf24" min={0} max={200} warn={130} crit={150} noData={!wellheadLive} />
                        </Grid>
                        <Grid item xs={6} sm={4}>
                            <ValueTile label="Wellhead Press" value={wellhead.wellhead_pressure} unit="bar" decimals={1} color="#a78bfa" min={0} max={250} warn={170} crit={200} noData={!wellheadLive} />
                        </Grid>
                    </Grid>
                </Box>

                <Grid container spacing={2}>
                    {/* Left Side: BOP Stack Visualization (Consumer of Digital Inputs) — kept mimic. */}
                    <Grid item xs={12} md={5}>
                        <BOPStack rams={wcData} live={isLive} accumulatorPressure={wcData.accumulator_pressure} />
                    </Grid>

                    {/* Right Side: BOP/Accumulator tiles + Ram status + Kill Sheet */}
                    <Grid item xs={12} md={7}>
                        {/* BOP / Accumulator pressure tiles (psi). Honest NO-DATA when BOP feed is not live. */}
                        <Box sx={{ mb: 2 }}>
                            <SectionTitle>BOP / Accumulator</SectionTitle>
                            <Grid container spacing={1.5}>
                                <Grid item xs={6} sm={4}>
                                    <ValueTile label="Annular" value={wcData.annular_pressure} unit="psi" color="#38bdf8" min={0} max={5000} warn={3500} crit={4000} noData={!isLive} />
                                </Grid>
                                <Grid item xs={6} sm={4}>
                                    <ValueTile label="Manifold" value={wcData.manifold_pressure} unit="psi" color="#818cf8" min={0} max={10000} warn={7000} crit={8500} noData={!isLive} />
                                </Grid>
                                <Grid item xs={6} sm={4}>
                                    {/* Accumulator is dangerous when LOW — turns amber/red below precharge minimum. */}
                                    <ValueTile label="Accumulator" value={wcData.accumulator_pressure} unit="psi" color="#f472b6" min={0} max={5000} lowWarn={2900} lowCrit={2500} noData={!isLive} sub="Low-press alarm < 2900 psi" />
                                </Grid>
                            </Grid>
                        </Box>

                        {/* Ram status chips — driven by BOP digital inputs, honest NO-DATA when not live. */}
                        <Box sx={{ mb: 2 }}>
                            <SectionTitle>Ram Status</SectionTitle>
                            <Paper sx={{ p: 1.75, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, borderRadius: 2, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                                <StatusChip label="Annular" value={ramMap(wcData.annular)} mapping={ramMapping} />
                                <Divider orientation="vertical" flexItem sx={{ borderColor: theme.palette.divider }} />
                                <StatusChip label="Pipe Ram" value={ramMap(wcData.pipe)} mapping={ramMapping} />
                                <Divider orientation="vertical" flexItem sx={{ borderColor: theme.palette.divider }} />
                                <StatusChip label="Blind Ram" value={ramMap(wcData.blind)} mapping={ramMapping} />
                                <Divider orientation="vertical" flexItem sx={{ borderColor: theme.palette.divider }} />
                                <StatusChip label="Shear Ram" value={shearVal} mapping={shearMapping} />
                            </Paper>
                        </Box>

                        {/* Kill Sheet Calculator — API RP 59, kept as-is (not a dial). */}
                        <Box sx={{ mb: 2 }}>
                            <KillSheet />
                        </Box>

                        {/* Status Footer - reflects REAL telemetry state */}
                        <Box sx={{ p: 2, bgcolor: theme.palette.background.paper, borderRadius: 1.5, border: `1px dashed ${theme.palette.divider}` }}>
                            <Typography variant="subtitle1" sx={{ color: theme.palette.text.secondary, mb: 0.5, fontWeight: 'bold' }}>Live Data Status</Typography>
                            <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                                Data Source: <strong style={{ color: theme.palette.text.primary }}>{feed.available ? 'PLC / MODBUS' : 'NONE (no BOP source)'}</strong><br />
                                Socket: <span style={{ color: feed.connected ? STATUS.ok : STATUS.fail }}>
                                    ● {feed.connected ? 'Connected' : 'Disconnected'}
                                </span><br />
                                Status: {isLive
                                    ? <span style={{ color: STATUS.ok }}>● Live</span>
                                    : <span style={{ color: feed.stale ? STATUS.warn : STATUS.fail }}>
                                        ● {feed.stale ? 'Stale (not live)' : 'No live data'}
                                      </span>}
                            </Typography>
                        </Box>
                    </Grid>
                </Grid>
            </Box>

            {/* Persistent EDR side strip */}
            <Paper
                sx={{
                    flex: { xs: '1 1 100%', lg: '0 0 400px' },
                    width: { xs: '100%', lg: 400 },
                    bgcolor: theme.palette.background.paper,
                    border: `1px solid ${theme.palette.divider}`,
                    borderRadius: 1,
                    p: 1.25,
                    height: { lg: 'calc(100vh - 220px)' },
                    minHeight: { xs: 420, lg: 0 },
                    display: 'flex',
                    flexDirection: 'column'
                }}
            >
                <Typography sx={{ display: 'flex', alignItems: 'center', gap: 0.75, color: theme.palette.text.secondary, fontSize: '0.72rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.6, mb: 1 }}>
                    <LineChart size={14} /> EDR — Wellhead Pressures
                </Typography>
                <Box sx={{ flex: 1, minHeight: 0 }}>
                    <EdrView mode="compact" storageKey="edr-wellcontrol-2" defaultStrips={EDR_STRIPS} channels={EDR_CHANNELS} />
                </Box>
            </Paper>
        </Box>
    );
};

export default WellControlDashboard;
