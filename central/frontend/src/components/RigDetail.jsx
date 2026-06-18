import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
    Box, Grid, Paper, Typography, Stack, Button, Link as MLink, Alert,
    Tabs, Tab,
} from '@mui/material';
import { ArrowBack, ExpandMore, ExpandLess } from '@mui/icons-material';
import { api, phaseColor } from '../api';
import { socket } from '../socket';
import { StatusChip, HealthBar, PriorityChip, fmtAgo, fmtNum } from './common';
import { RigDataProvider, useRigData } from '../context/RigDataContext';
import EdrView from './rig/EdrView';
import ErrorBoundary from './ErrorBoundary';
import DashboardPanel from './rig/panels/DashboardPanel';
import EquipmentPanel from './rig/panels/EquipmentPanel';
import WellControlPanel from './rig/panels/WellControlPanel';
import TrendsPanel from './rig/panels/TrendsPanel';
import WorkoverPanel from './rig/panels/WorkoverPanel';
import RigAlarmsPanel from './rig/panels/RigAlarmsPanel';
import RigReportPanel from './rig/panels/RigReportPanel';
import RigMaintenancePanel from './rig/panels/RigMaintenancePanel';

// Per-rig remote-HMI tabs (proposal §6.1: rig drill-down mirrors the edge dashboard).
const HMI_TABS = [
    { key: 'dashboard', label: 'Dashboard', el: DashboardPanel },
    { key: 'equipment', label: 'Equipment', el: EquipmentPanel },
    { key: 'wellcontrol', label: 'Well Control', el: WellControlPanel },
    { key: 'trends', label: 'Trends / EDR', el: TrendsPanel },
    { key: 'workover', label: 'Workover', el: WorkoverPanel },
    { key: 'alarms', label: 'Alarms', el: RigAlarmsPanel },
    { key: 'reports', label: 'Daily Report', el: RigReportPanel },
    { key: 'maintenance', label: 'Maintenance', el: RigMaintenancePanel },
];

export default function RigDetail() {
    const { id } = useParams();
    const nav = useNavigate();
    const [rig, setRig] = useState(null);
    const [err, setErr] = useState('');
    const [metric, setMetric] = useState('drawworks.hook_load');  // KPI-strip highlight selection
    const [tab, setTab] = useState(0);   // 0 = Overview, 1+ = HMI mirror tabs
    const [kpiOpen, setKpiOpen] = useState(false);  // KPI strip on HMI tabs (default hidden)

    const load = useCallback(() => {
        api.rig(id).then(setRig).catch((e) => setErr(e?.response?.data?.error || 'failed to load rig'));
    }, [id]);

    useEffect(() => { load(); const t = setInterval(load, 5000); return () => clearInterval(t); }, [load]);

    // Reflect live deltas for this rig immediately.
    useEffect(() => {
        const onUpdate = (row) => { if (row.rigId === id) setRig((r) => (r ? { ...r, ...row } : r)); };
        socket.on('fleet_update', onUpdate);
        return () => socket.off('fleet_update', onUpdate);
    }, [id]);

    if (err) return <Alert severity="error">{err} — <MLink sx={{ cursor: 'pointer' }} onClick={() => nav('/')}>back to fleet</MLink></Alert>;
    if (!rig) return <Typography color="text.secondary">Loading {id}…</Typography>;

    // The Overview tab renders its own KPI row, so the shared collapsible strip is only
    // for the HMI tabs (toggled via the "KPIs" button); never auto-shown on Overview.
    const showKpis = tab > 0 && kpiOpen;
    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {/* Header chrome — non-growing, single compact line so the tab content fills
                the rest of the viewport (esp. the EDR). */}
            <Box sx={{ flex: '0 0 auto' }}>
                <Paper sx={{ px: 1.25, py: 0.75, mb: 1 }}>
                    <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
                        <Button startIcon={<ArrowBack />} onClick={() => nav('/')} size="small" variant="outlined">Fleet</Button>
                        <Box>
                            <Typography variant="subtitle1" fontWeight={800} lineHeight={1.1}>{rig.name}</Typography>
                            <Typography variant="caption" color="text.secondary">{rig.rigId} · {rig.field}</Typography>
                        </Box>
                        <StatusChip status={rig.status} size="small" />
                        {rig.alarm?.highest && <PriorityChip priority={rig.alarm.highest} />}
                        <Box sx={{ flexGrow: 1 }} />
                        <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'none', md: 'block' } }}>
                            {rig.activeActivity || '—'} · {rig.activeJob || 'no job'}
                        </Typography>
                        <Box sx={{ width: 90, display: { xs: 'none', sm: 'block' } }}><HealthBar value={rig.healthScore} /></Box>
                        <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'none', lg: 'block' } }}>
                            {rig.metricCount} tags · lag {rig.syncLagSec == null ? '—' : rig.syncLagSec + 's'} · {fmtAgo(rig.lastDataAt)}
                        </Typography>
                        {tab > 0 && (
                            <Button size="small" variant="text" onClick={() => setKpiOpen((o) => !o)}
                                startIcon={kpiOpen ? <ExpandLess /> : <ExpandMore />} sx={{ color: 'text.secondary' }}>
                                KPIs
                            </Button>
                        )}
                    </Stack>
                </Paper>

                {/* Key KPIs — always on Overview; collapsible (default hidden) on HMI tabs
                    so the panel (esp. the EDR) gets the full real estate. */}
                {showKpis && (
                    <Grid container spacing={1} mb={1}>
                        {rig.keyMetrics?.map((k) => (
                            <Grid item xs={4} sm={3} md={2} key={k.metric}>
                                <Paper sx={{ p: 1, cursor: 'pointer', borderColor: metric === k.metric ? 'primary.main' : undefined }} onClick={() => setMetric(k.metric)}>
                                    <Typography variant="caption" color="text.secondary" noWrap>{k.label}</Typography>
                                    <Typography variant="subtitle1" fontWeight={800} lineHeight={1.2}>{fmtNum(k.value)} <Typography component="span" variant="caption" color="text.secondary">{k.unit}</Typography></Typography>
                                </Paper>
                            </Grid>
                        ))}
                    </Grid>
                )}

                <Paper sx={{ mb: 1.25 }} variant="outlined">
                    <Tabs value={tab} onChange={(_e, v) => setTab(v)} variant="scrollable" scrollButtons="auto"
                        sx={{ minHeight: 40, '& .MuiTab-root': { minHeight: 40, py: 0, textTransform: 'none', fontWeight: 600 } }}>
                        <Tab label="Overview" />
                        {HMI_TABS.map((t) => <Tab key={t.key} label={t.label} />)}
                    </Tabs>
                </Paper>
            </Box>

            {/* Tab content fills the remaining viewport height; tall panels scroll
                within, while the EDR (height:100%) fills exactly. A single
                RigDataProvider feeds both the Overview (live equipment/efficiency)
                and the HMI mirror panels. */}
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <RigDataProvider rigId={id}>
                {tab === 0 ? (
                    <ErrorBoundary key="overview" label="Overview">
                        <OverviewTab rigId={id} rig={rig} />
                    </ErrorBoundary>
                ) : (
                    <ErrorBoundary key={HMI_TABS[tab - 1].key} label="This panel">
                        {React.createElement(HMI_TABS[tab - 1].el, { rigId: id, rig })}
                    </ErrorBoundary>
                )}
            </RigDataProvider>
            </Box>
        </Box>
    );
}

// ---------------------------------------------------------------------------
// Overview — operator dashboard mirror of the edge app.
// ---------------------------------------------------------------------------

const fmtDur = (sec) => {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
};
const fmtMins = (sec) => `${Math.round((Number(sec) || 0) / 60)}m`;

// Map an equipment status code to a coarse chip ({label, color}) for the
// compact status grid. Codes follow the edge enums (0=off/idle, 2=on/run, etc.).
function equipChip(value) {
    if (value == null) return { label: '—', color: 'default' };
    const n = Number(value);
    if (Number.isNaN(n)) return { label: String(value), color: 'default' };
    if (n <= 0) return { label: 'OFF', color: 'default' };
    if (n === 1) return { label: 'IDLE', color: 'info' };
    if (n === 2) return { label: 'RUN', color: 'success' };
    return { label: 'FAULT', color: 'error' };  // 3+ -> fault/error states across the edge enums
}

function EquipChip({ label, value }) {
    const c = equipChip(value);
    return (
        <Stack direction="row" spacing={0.75} alignItems="center"
            sx={{ px: 1, py: 0.5, borderRadius: 1, border: '1px solid', borderColor: 'divider', bgcolor: 'background.default' }}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', flex: '0 0 auto',
                bgcolor: c.color === 'default' ? 'text.disabled' : `${c.color}.main` }} />
            <Typography variant="caption" fontWeight={700} noWrap>{label}</Typography>
            <Box sx={{ flexGrow: 1 }} />
            <Typography variant="caption" color="text.secondary" noWrap>{c.label}</Typography>
        </Stack>
    );
}

const EDR_STRIPS = [
    { title: 'Hoisting', pens: [
        { channelId: 'drawworks.hook_load', color: '#38bdf8', min: 0, max: 500, enabled: true },
        { channelId: 'drilling.rop', color: '#f472b6', min: 0, max: 80, enabled: true },
    ] },
    { title: 'Pump', pens: [
        { channelId: 'mudpump.spm', color: '#4ade80', min: 0, max: 200, enabled: true },
        { channelId: 'mudpump.pressure', color: '#fbbf24', min: 0, max: 500, enabled: true },
    ] },
];
const EDR_CHANNELS = ['drawworks.hook_load', 'drilling.rop', 'mudpump.spm', 'mudpump.pressure'];

function OverviewTab({ rigId, rig }) {
    const { data: live } = useRigData();
    const [act, setAct] = useState(null);

    useEffect(() => {
        let alive = true;
        const load = () => api.activity(rigId, 24).then((d) => { if (alive) setAct(d); }).catch(() => {});
        load();
        const t = setInterval(load, 10000);
        return () => { alive = false; clearInterval(t); };
    }, [rigId]);

    const cur = act?.current;
    const byPhase = act?.byPhase || [];
    const totals = act?.totals;

    // Equipment present-checks (numeric/none -> coloured chip).
    const eng = live?.cat_engine || {};
    const hpu = live?.hpu || {};
    const htd = live?.htd || {};
    const pct = live?.pct || {};
    const acs = live?.acs || {};
    const cwk = live?.cwk || {};
    const mp = live?.mudpump || {};
    const mudOn = mp && (mp.spm != null || mp.pressure != null || mp.flow_in != null);

    // Efficiency figures — kept honest: only what we can derive.
    const rop = live?.drilling?.rop;
    const hpuDisch = hpu.discharge_pressure ?? hpu.pressure;

    return (
        <Grid container spacing={2}>
            {/* (a) IMPORTANT KPIs — compact tiles from rig.keyMetrics */}
            <Grid item xs={12}>
                <Grid container spacing={1}>
                    {(rig.keyMetrics || []).map((k, i) => (
                        <Grid item xs={6} sm={4} md={2} key={k.metric || i}>
                            <Paper sx={{ p: 1, borderLeft: '3px solid', borderColor: KPI_COLORS[i % KPI_COLORS.length] }}>
                                <Typography variant="caption" color="text.secondary" noWrap>{k.label}</Typography>
                                <Typography variant="subtitle1" fontWeight={800} lineHeight={1.2} noWrap>
                                    {fmtNum(k.value)} <Typography component="span" variant="caption" color="text.secondary">{k.unit}</Typography>
                                </Typography>
                            </Paper>
                        </Grid>
                    ))}
                    {!(rig.keyMetrics || []).length && <Grid item xs={12}><Typography variant="caption" color="text.secondary">No key metrics yet.</Typography></Grid>}
                </Grid>
            </Grid>

            {/* (b) ACTIVITY TIMELINE — headline proportional bar + legend + prod/NPT summary */}
            <Grid item xs={12} md={8}>
                <Paper sx={{ p: 2 }}>
                    <Stack direction="row" alignItems="baseline" spacing={1} mb={1} flexWrap="wrap" useFlexGap>
                        <Typography variant="h6" sx={{ flexGrow: 1 }}>Activity (last 24h)</Typography>
                        <Typography variant="caption" color="text.secondary">
                            Current well activity:&nbsp;
                            <Box component="span" sx={{ color: phaseColor(cur?.phase), fontWeight: 800 }}>
                                {cur?.phase || cur?.code || '—'}
                            </Box>
                            {cur?.job ? ` · ${cur.job}` : ''}{cur?.sinceSec != null ? ` · for ${fmtDur(cur.sinceSec)}` : ''}
                        </Typography>
                    </Stack>

                    {/* Proportional coloured bar — width-driven, adjusts to container width. */}
                    <Box sx={{ display: 'flex', width: '100%', height: 26, borderRadius: 1, overflow: 'hidden',
                        border: '1px solid', borderColor: 'divider', bgcolor: 'background.default' }}>
                        {byPhase.length ? byPhase.map((p, i) => (
                            <Box key={p.phase || i} title={`${p.phase} ${fmtMins(p.durationSec)}`}
                                sx={{ width: `${p.pct}%`, bgcolor: phaseColor(p.phase) }} />
                        )) : null}
                    </Box>

                    {/* Legend */}
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, mt: 1 }}>
                        {byPhase.map((p, i) => (
                            <Stack key={p.phase || i} direction="row" spacing={0.5} alignItems="center">
                                <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: phaseColor(p.phase) }} />
                                <Typography variant="caption" fontWeight={600}>{p.phase}</Typography>
                                <Typography variant="caption" color="text.secondary">{fmtDur(p.durationSec)}</Typography>
                            </Stack>
                        ))}
                        {!byPhase.length && <Typography variant="caption" color="text.secondary">No activity recorded in the window.</Typography>}
                    </Box>

                    {/* Productive vs NPT summary bar */}
                    {totals && (
                        <Box sx={{ mt: 1.5 }}>
                            <Box sx={{ display: 'flex', width: '100%', height: 8, borderRadius: 4, overflow: 'hidden', bgcolor: 'background.default' }}>
                                <Box title={`Productive ${totals.prodPct}%`} sx={{ width: `${totals.prodPct}%`, bgcolor: '#22c55e' }} />
                                <Box title={`NPT ${totals.nptPct}%`} sx={{ width: `${totals.nptPct}%`, bgcolor: '#ef4444' }} />
                                <Box title={`Other ${totals.otherPct}%`} sx={{ width: `${totals.otherPct}%`, bgcolor: '#64748b' }} />
                            </Box>
                            <Stack direction="row" spacing={2} mt={0.5}>
                                <Typography variant="caption" sx={{ color: '#22c55e', fontWeight: 700 }}>Productive {totals.prodPct}%</Typography>
                                <Typography variant="caption" sx={{ color: '#ef4444', fontWeight: 700 }}>NPT {totals.nptPct}%</Typography>
                                <Typography variant="caption" color="text.secondary">Other {totals.otherPct}%</Typography>
                            </Stack>
                        </Box>
                    )}
                </Paper>
            </Grid>

            {/* (e) CURRENT ALARMS */}
            <Grid item xs={12} md={4}>
                <Paper sx={{ p: 2, height: '100%' }}>
                    <Stack direction="row" alignItems="center" spacing={1} mb={1}>
                        <Typography variant="h6" sx={{ flexGrow: 1 }}>Current alarms</Typography>
                        {rig.alarm?.highest && <PriorityChip priority={rig.alarm.highest} />}
                        <Typography variant="caption" color="text.secondary">{rig.alarm?.active ?? 0} active</Typography>
                    </Stack>
                    {rig.recentAlarms?.length ? rig.recentAlarms.slice(0, 5).map((a, i) => (
                        <Stack key={i} direction="row" spacing={1} alignItems="center" py={0.4}>
                            <PriorityChip priority={a.payload?.highest} />
                            <Typography variant="caption" sx={{ flexGrow: 1 }}>{a.payload?.active ?? 0} active · {a.payload?.unack ?? 0} unack</Typography>
                            <Typography variant="caption" color="text.secondary">{fmtAgo(a.ts)}</Typography>
                        </Stack>
                    )) : <Typography variant="caption" color="text.secondary">No alarm events.</Typography>}
                </Paper>
            </Grid>

            {/* (c) EQUIPMENT STATUS — compact chip grid from live useRigData() */}
            <Grid item xs={12} md={8}>
                <Paper sx={{ p: 2 }}>
                    <Typography variant="subtitle2" color="text.secondary" gutterBottom>EQUIPMENT STATUS</Typography>
                    <Grid container spacing={1}>
                        {[
                            ['Cat Engine', eng.status], ['HPU', hpu.status], ['HTD', htd.status],
                            ['PCT', pct.status], ['ACS', acs.status], ['CWK', cwk.status],
                            ['Mud Pump', mudOn ? 2 : (mp.status ?? null)],
                        ].map(([label, val]) => (
                            <Grid item xs={6} sm={4} md={3} key={label}>
                                <EquipChip label={label} value={val} />
                            </Grid>
                        ))}
                    </Grid>
                </Paper>
            </Grid>

            {/* (d) EFFICIENCY */}
            <Grid item xs={12} md={4}>
                <Paper sx={{ p: 2, height: '100%' }}>
                    <Typography variant="subtitle2" color="text.secondary" gutterBottom>EFFICIENCY</Typography>
                    <Stack spacing={1}>
                        <EffRow label="Productive" value={totals ? `${totals.prodPct}%` : '—'} color="#22c55e" />
                        <EffRow label="NPT" value={totals ? `${totals.nptPct}%` : '—'} color="#ef4444" />
                        <EffRow label="Avg ROP" value={rop != null ? `${fmtNum(rop, 1)} m/hr` : '—'} />
                        <EffRow label="HPU discharge" value={hpuDisch != null ? `${fmtNum(hpuDisch, 0)} bar` : '—'} />
                    </Stack>
                </Paper>
            </Grid>

            {/* (f) COMPACT EDR strip */}
            <Grid item xs={12}>
                <Paper sx={{ p: 1.25 }}>
                    <Typography variant="subtitle2" color="text.secondary" gutterBottom>RECORDER (EDR)</Typography>
                    <Box sx={{ height: 260 }}>
                        <EdrView mode="compact" rigId={rigId} storageKey={`crmf-edr-ov-${rigId}`}
                            defaultStrips={EDR_STRIPS} channels={EDR_CHANNELS} />
                    </Box>
                </Paper>
            </Grid>

            {/* Deployment — small line, kept for convenience. */}
            <Grid item xs={12}>
                <Typography variant="caption" color="text.secondary">
                    Deployment: gate {rig.deployment?.gate || '—'} · {rig.deployment?.commissioning || '—'} · edge {rig.deployment?.edge_version || '—'} · adoption {rig.deployment?.adoption_pct ?? 0}% · site {rig.deployment?.site_ready ? 'ready' : 'pending'} · security {rig.deployment?.security_review ? 'passed' : 'pending'}
                </Typography>
            </Grid>
        </Grid>
    );
}

const KPI_COLORS = ['#38bdf8', '#4ade80', '#fbbf24', '#a78bfa', '#f472b6', '#22d3ee'];

function EffRow({ label, value, color }) {
    return (
        <Stack direction="row" justifyContent="space-between" alignItems="baseline">
            <Typography variant="body2" color="text.secondary">{label}</Typography>
            <Typography variant="body2" fontWeight={800} sx={color ? { color } : undefined}>{value}</Typography>
        </Stack>
    );
}
