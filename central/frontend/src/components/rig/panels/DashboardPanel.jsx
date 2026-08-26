import React from 'react';
import { Box, Grid, Paper, Typography, Stack, Skeleton, Alert, Divider } from '@mui/material';
import { useRigData } from '../../../context/RigDataContext';
import {
    ValueTile, EnumChip, MiniGauge, PanelHead, freshness,
    FreshProvider, gaugeProps, tileProps, tankGainLossWarn,
} from '../hmi';
import { TintChip } from '../../common';

// =====================================================================
// DashboardPanel — main operator dashboard for the CRMF per-rig remote
// HMI mirror (proposal §6.1: rig drill-down mirrors the edge RigOverview
// headline view). READ-ONLY: monitoring/visualisation only, no controls.
// =====================================================================

// Small live/stale/offline chip derived from the edge _meta block.
function FreshnessChip({ meta }) {
    const f = freshness(meta);
    return <TintChip label={f.text} color={f.color} sx={{ letterSpacing: 0.3 }} />;
}

// One status cell in the compact equipment band.
function BandChip({ label, value, map }) {
    return (
        <Stack spacing={0.4} alignItems="flex-start">
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</Typography>
            <EnumChip value={value} map={map} />
        </Stack>
    );
}

export default function DashboardPanel({ rigId, rig }) {
    const { data, loading, error } = useRigData();

    // ---- loading skeleton (data may be null on first render) ----
    if (loading && !data) {
        return (
            <Box>
                <Skeleton variant="rounded" height={56} sx={{ mb: 2 }} />
                <Grid container spacing={2}>
                    {Array.from({ length: 6 }).map((_, i) => (
                        <Grid item xs={6} sm={4} md={2} key={`g${i}`}><Skeleton variant="rounded" height={110} /></Grid>
                    ))}
                </Grid>
                <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>Loading live telemetry…</Typography>
            </Box>
        );
    }

    const dw = data?.drawworks || {};
    const dr = data?.drilling || {};
    const mp = data?.mudpump || {};
    const fl = data?.fluid || {};
    const wh = data?.wellhead || {};
    const wc = data?.well_control || {};
    const hpu = data?.hpu || {};
    const htd = data?.htd || {};
    const pct = data?.pct || {};
    const eng = data?.cat_engine || {};
    const acs = data?.acs || {};
    const cwk = data?.cwk || {};
    const sfy = data?.safety || {};
    const act = data?._activity || {};
    const meta = data?._meta || null;

    const rigName = meta?.name || rig?.name || rigId || 'Rig';
    const fr = freshness(meta);

    return (
        <Box>
            <FreshProvider value={fr}>
            {error && (
                <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>{error}</Alert>
            )}

            {/* ---- Top strip: rig / activity / op-mode / freshness ---- */}
            <Paper sx={{ p: 1.5, mb: 2 }}>
                <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ xs: 'flex-start', md: 'center' }} justifyContent="space-between" spacing={1}>
                    <Box>
                        <Typography variant="h6" fontWeight={800} sx={{ lineHeight: 1.2 }}>{rigName}</Typography>
                        <Typography variant="body2" color="text.secondary">
                            {act.label || '—'}{act.job ? ` · ${act.job}` : ''}
                        </Typography>
                    </Box>
                    <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap">
                        <Stack spacing={0.3} alignItems="flex-end">
                            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>Op mode</Typography>
                            <EnumChip value={dr.operation_mode} map="opMode" />
                        </Stack>
                        <FreshnessChip meta={meta} />
                    </Stack>
                </Stack>
            </Paper>

            {/* ---- Headline gauges ---- */}
            <PanelHead title="Drilling parameters" />
            <Grid container spacing={2} sx={{ mb: 2 }}>
                <Grid item xs={6} sm={4} md={2}><MiniGauge label="Hookload" value={dw.hook_load} {...gaugeProps('drawworks.hook_load')} /></Grid>
                <Grid item xs={6} sm={4} md={2}><MiniGauge label="WOB" value={dr.wob} {...gaugeProps('drilling.wob')} /></Grid>
                <Grid item xs={6} sm={4} md={2}><MiniGauge label="String RPM" value={dr.rpm} {...gaugeProps('drilling.rpm')} /></Grid>
                <Grid item xs={6} sm={4} md={2}><MiniGauge label="Torque" value={dr.torque} {...gaugeProps('drilling.torque')} /></Grid>
                <Grid item xs={6} sm={4} md={2}><MiniGauge label="Standpipe" value={mp.pressure} {...gaugeProps('mudpump.pressure')} /></Grid>
                <Grid item xs={6} sm={4} md={2}><MiniGauge label="ROP" value={dr.rop} {...gaugeProps('drilling.rop')} /></Grid>
            </Grid>

            {/* ---- Key value tiles ---- */}
            <PanelHead title="Hole &amp; circulation" />
            <Grid container spacing={2} sx={{ mb: 2 }}>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="Block position" value={dw.block_position} {...tileProps('drawworks.block_position')} /></Grid>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="Hole depth" value={dr.hole_depth} {...tileProps('drilling.hole_depth')} /></Grid>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="Bit depth" value={dr.bit_depth} {...tileProps('drilling.bit_depth')} /></Grid>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="Flow in" value={mp.flow_in} {...tileProps('mudpump.flow_in')} /></Grid>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="SPM" value={mp.spm} {...tileProps('mudpump.spm')} /></Grid>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="Tank gain/loss" value={fl.tank_gain_loss} {...tileProps('fluid.tank_gain_loss')} warn={tankGainLossWarn} /></Grid>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="Tubing pressure" value={wh.tubing_pressure} {...tileProps('wellhead.tubing_pressure')} /></Grid>
                <Grid item xs={6} sm={4} md={3}><ValueTile label="Accumulator" value={wc.accumulator_pressure} unit="psi" d={0} /></Grid>
            </Grid>

            {/* ---- Compact equipment / safety status band ---- */}
            <Paper sx={{ p: 1.5 }}>
                <PanelHead title="Equipment &amp; safety" />
                <Grid container spacing={2} rowSpacing={1.5}>
                    <Grid item xs={6} sm={4} md={2}><BandChip label="HPU" value={hpu.status} map="onoff" /></Grid>
                    <Grid item xs={6} sm={4} md={2}><BandChip label="HTD" value={htd.status} map="onoff" /></Grid>
                    <Grid item xs={6} sm={4} md={2}><BandChip label="PCT seq" value={pct.sequence} map="pctSeq" /></Grid>
                    <Grid item xs={6} sm={4} md={2}><BandChip label="Engine" value={eng.status} map="engine" /></Grid>
                    <Grid item xs={6} sm={4} md={2}><BandChip label="ACS" value={acs.status} map="acs" /></Grid>
                    <Grid item xs={6} sm={4} md={2}><BandChip label="CWK" value={cwk.status} map="cwkParked" /></Grid>
                </Grid>
                <Divider sx={{ my: 1.5 }} />
                <Stack direction="row" spacing={2} flexWrap="wrap" rowGap={1}>
                    <BandChip label="ESD" value={sfy.esd_active ? 1 : 0} map="esd" />
                    <BandChip label="Lockout" value={sfy.lockout_active ? 1 : 0} map="lockout" />
                </Stack>
            </Paper>
            </FreshProvider>
        </Box>
    );
}
