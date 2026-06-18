import React, { useState } from 'react';
import { Box, Grid, Paper, Typography, Stack, Chip, Tabs, Tab, Alert, Divider } from '@mui/material';
import { useRigData } from '../../../context/RigDataContext';
import { ValueTile, StatusRow, PanelHead, freshness } from '../hmi';
import EdrView from '../EdrView';

// Compact EDR strip config — equipment-relevant pens (HPU/HTD + Engine), mirrors the edge.
const EDR_STRIPS = [
    {
        title: 'HPU/HTD',
        pens: [
            { channelId: 'hpu.discharge_pressure', color: '#38bdf8', min: 0, max: 300, enabled: true },
            { channelId: 'htd.torque', color: '#fbbf24', min: 0, max: 20000, enabled: true },
        ],
    },
    {
        title: 'Engine',
        pens: [
            { channelId: 'cat_engine.load', color: '#4ade80', min: 0, max: 100, enabled: true },
            { channelId: 'cat_engine.rpm', color: '#f472b6', min: 0, max: 2000, enabled: true },
        ],
    },
];
const EDR_CHANNELS = ['hpu.discharge_pressure', 'htd.torque', 'cat_engine.load', 'cat_engine.rpm'];

// =====================================================================
// EquipmentPanel — CRMF per-rig remote HMI mirror (proposal §6.1).
// MUI sub-tabs, one per equipment group, each a read-only grid of
// ValueTile + StatusRow sourced from the edge-shape live payload.
// READ-ONLY: monitoring-only, no control actions anywhere.
// =====================================================================

// Sub-section header used between tile groups within a tab.
function SubHead({ title }) {
    return (
        <Typography variant="overline" color="text.secondary" sx={{ display: 'block', mt: 1, mb: 0.5, letterSpacing: 0.6 }}>
            {title}
        </Typography>
    );
}

// Responsive tile cell.
const Cell = ({ children }) => (
    <Grid item xs={6} sm={4} md={3}>{children}</Grid>
);

// ---- Per-equipment tab bodies (each guards a possibly-missing group) ----

function CatEngineTab({ g = {} }) {
    return (
        <Box>
            <Grid container spacing={1}>
                <Grid item xs={12} sm={6}>
                    <Paper sx={{ p: 1.5 }}>
                        <StatusRow label="Status" value={g.status} map="engine" />
                        <StatusRow label="Source Command" value={g.source_cmd} map="sourceCmd" />
                    </Paper>
                </Grid>
            </Grid>
            <SubHead title="Readings" />
            <Grid container spacing={1}>
                <Cell><ValueTile label="RPM" value={g.rpm} unit="rpm" d={0} /></Cell>
                <Cell><ValueTile label="Load" value={g.load} unit="%" d={0} min={0} max={100} warn={(n) => n > 95} /></Cell>
                <Cell><ValueTile label="Coolant Temp" value={g.coolant_temp} unit="°C" d={0} warn={(n) => n > 100} /></Cell>
                <Cell><ValueTile label="Oil Pressure" value={g.oil_pressure} unit="psi" d={0} warn={(n) => n < 20} /></Cell>
                <Cell><ValueTile label="Fuel Pressure" value={g.fuel_pressure} unit="bar" d={1} /></Cell>
                <Cell><ValueTile label="Fuel Rate" value={g.fuel_rate} unit="l/h" d={1} /></Cell>
                <Cell><ValueTile label="Fuel Temp" value={g.fuel_temp} unit="°C" d={0} /></Cell>
                <Cell><ValueTile label="Battery" value={g.battery_voltage} unit="V" d={1} warn={(n) => n < 22} /></Cell>
                <Cell><ValueTile label="Run Hours" value={g.run_hours} unit="h" d={0} /></Cell>
                <Cell><ValueTile label="Total Hours" value={g.total_hours} unit="h" d={0} /></Cell>
            </Grid>
        </Box>
    );
}

function HpuTab({ g = {} }) {
    return (
        <Box>
            <Grid container spacing={1}>
                <Grid item xs={12} sm={6}>
                    <Paper sx={{ p: 1.5 }}>
                        <StatusRow label="Status" value={g.status} map="onoff" />
                    </Paper>
                </Grid>
            </Grid>
            <SubHead title="Hydraulics" />
            <Grid container spacing={1}>
                <Cell><ValueTile label="Discharge Press" value={g.discharge_pressure} unit="bar" d={1} /></Cell>
                <Cell><ValueTile label="Aux Pressure" value={g.aux_pressure} unit="bar" d={1} /></Cell>
                <Cell><ValueTile label="Oil Temp" value={g.oil_temp} unit="°C" d={0} warn={(n) => n > 70} /></Cell>
                <Cell><ValueTile label="Oil Level" value={g.oil_level} unit="%" d={0} min={0} max={100} warn={(n) => n < 20} /></Cell>
                <Cell><ValueTile label="Pilot Pressure" value={g.pilot_pressure} unit="bar" d={1} /></Cell>
            </Grid>

            <SubHead title="Pumps" />
            <Grid container spacing={1}>
                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 1.5 }}>
                        <StatusRow label="PDW Pump" value={g.pdw_pump_status} map="pumpStatus" />
                        <Divider sx={{ my: 0.5, borderColor: 'rgba(255,255,255,0.08)' }} />
                        <Stack direction="row" spacing={1}>
                            <ValueTile label="PDW Flow" value={g.pdw_pump_flow} unit="%" d={0} min={0} max={100} sx={{ flex: 1, minWidth: 0 }} />
                            <ValueTile label="PDW Press" value={g.pdw_pump_press} unit="bar" d={1} sx={{ flex: 1, minWidth: 0 }} />
                        </Stack>
                    </Paper>
                </Grid>
                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 1.5 }}>
                        <StatusRow label="HTD Pump 1" value={g.htd_pump1_status} map="onoff" />
                        <Divider sx={{ my: 0.5, borderColor: 'rgba(255,255,255,0.08)' }} />
                        <Stack direction="row" spacing={1}>
                            <ValueTile label="P1 Flow" value={g.htd_pump1_flow} unit="%" d={0} sx={{ flex: 1, minWidth: 0 }} />
                            <ValueTile label="P1 Press" value={g.htd_pump1_press} unit="bar" d={1} sx={{ flex: 1, minWidth: 0 }} />
                        </Stack>
                    </Paper>
                </Grid>
                <Grid item xs={12} md={4}>
                    <Paper sx={{ p: 1.5 }}>
                        <StatusRow label="HTD Pump 2" value={g.htd_pump2_status} map="onoff" />
                        <Divider sx={{ my: 0.5, borderColor: 'rgba(255,255,255,0.08)' }} />
                        <Stack direction="row" spacing={1}>
                            <ValueTile label="P2 Flow" value={g.htd_pump2_flow} unit="%" d={0} sx={{ flex: 1, minWidth: 0 }} />
                            <ValueTile label="P2 Press" value={g.htd_pump2_press} unit="bar" d={1} sx={{ flex: 1, minWidth: 0 }} />
                        </Stack>
                    </Paper>
                </Grid>
            </Grid>

            <SubHead title="Oil Filters" />
            <Grid container spacing={1}>
                <Grid item xs={12} sm={6} md={4}>
                    <Paper sx={{ p: 1.5 }}>
                        <StatusRow label="Oil Filter 1" value={g.oil_filter_1} map="oilFilter" />
                        <StatusRow label="Oil Filter 2" value={g.oil_filter_2} map="oilFilter" />
                        <StatusRow label="Oil Filter 3" value={g.oil_filter_3} map="oilFilter" />
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );
}

function HtdTab({ g = {} }) {
    return (
        <Box>
            <Grid container spacing={1}>
                <Cell><ValueTile label="RPM" value={g.rpm} unit="rpm" d={0} /></Cell>
                <Cell><ValueTile label="Torque" value={g.torque} unit="Nm" d={0} /></Cell>
                <Cell><ValueTile label="Torque Cmd" value={g.torque_command} unit="Nm" d={0} /></Cell>
                <Cell><ValueTile label="Vertical Speed" value={g.vertical_speed} unit="m/s" d={2} /></Cell>
            </Grid>
            <SubHead title="Status" />
            <Grid container spacing={1}>
                <Grid item xs={12} sm={6}>
                    <Paper sx={{ p: 1.5 }}>
                        <StatusRow label="Status" value={g.status} map="onoff" />
                        <StatusRow label="Rotation" value={g.rotation_status} map="rotation" />
                        <StatusRow label="Gear" value={g.gear_status} map="onoff" />
                        <StatusRow label="IBOP" value={g.ibop_status} map="ibop" />
                    </Paper>
                </Grid>
                <Grid item xs={12} sm={6}>
                    <Paper sx={{ p: 1.5 }}>
                        <StatusRow label="Elevator" value={g.elevator_status} map="elevator" />
                        <StatusRow label="Brake" value={g.brake_status} map="brake" />
                        <StatusRow label="Tilt" value={g.tilt_status} map="tilt" />
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );
}

function PctTab({ g = {} }) {
    return (
        <Box>
            <Grid container spacing={1}>
                <Cell><ValueTile label="Makeup Torque" value={g.makeup_torque} unit="Nm" d={0} /></Cell>
                <Cell><ValueTile label="Last Makeup Tq" value={g.last_makeup_torque} unit="Nm" d={0} /></Cell>
                <Cell><ValueTile label="Spinner Makeup Tq" value={g.spinner_makeup_torque} unit="Nm" d={0} /></Cell>
                <Cell><ValueTile label="Rotation Makeup Press" value={g.rotation_makeup_pressure} unit="bar" d={1} /></Cell>
                <Cell><ValueTile label="Clamp-up Press" value={g.clamp_up_pressure} unit="bar" d={1} /></Cell>
            </Grid>
            <SubHead title="Status" />
            <Grid container spacing={1}>
                <Grid item xs={12} sm={6}>
                    <Paper sx={{ p: 1.5 }}>
                        <StatusRow label="Status" value={g.status} map="onoff" />
                        <StatusRow label="Sequence" value={g.sequence} map="pctSeq" />
                        <StatusRow label="Dolly" value={g.dolly_status} map="dolly" />
                    </Paper>
                </Grid>
                <Grid item xs={12} sm={6}>
                    <Paper sx={{ p: 1.5 }}>
                        <StatusRow label="Clamp Up" value={g.clamp_up_status} map="clamp" />
                        <StatusRow label="Clamp Low" value={g.clamp_low_status} map="clamp" />
                    </Paper>
                </Grid>
            </Grid>
        </Box>
    );
}

function AcsTab({ g = {} }) {
    return (
        <Box>
            <Grid container spacing={1}>
                <Grid item xs={12} sm={6}>
                    <Paper sx={{ p: 1.5 }}>
                        <StatusRow label="Status" value={g.status} map="acs" />
                    </Paper>
                </Grid>
            </Grid>
            <SubHead title="Anti-Collision Limits" />
            <Grid container spacing={1}>
                <Cell><ValueTile label="Crown Saver" value={g.crownsaver} unit="" d={0} /></Cell>
                <Cell><ValueTile label="Floor Saver" value={g.floorsaver} unit="" d={0} /></Cell>
                <Cell><ValueTile label="Bottom Saver" value={g.bottomsaver} unit="" d={0} /></Cell>
                <Cell><ValueTile label="Upper Tag" value={g.upper_tag} unit="" d={0} /></Cell>
                <Cell><ValueTile label="Lower Tag" value={g.lower_tag} unit="" d={0} /></Cell>
            </Grid>
        </Box>
    );
}

function CwkTab({ g = {} }) {
    return (
        <Box>
            <Grid container spacing={1}>
                <Grid item xs={12} sm={6}>
                    <Paper sx={{ p: 1.5 }}>
                        <StatusRow label="Status" value={g.status} map="cwkParked" />
                        <StatusRow label="Clamp" value={g.clamp_status} map="clamp" />
                    </Paper>
                </Grid>
            </Grid>
            <SubHead title="Clamp" />
            <Grid container spacing={1}>
                <Cell><ValueTile label="Clamp Pressure" value={g.clamp_pressure} unit="bar" d={1} /></Cell>
                <Cell><ValueTile label="Clamp Force" value={g.clamp_force} unit="kN" d={0} /></Cell>
            </Grid>
        </Box>
    );
}

function MudPumpTab({ mp = {}, fl = {} }) {
    return (
        <Box>
            <SubHead title="Mud Pump" />
            <Grid container spacing={1}>
                <Cell><ValueTile label="Pressure" value={mp.pressure} unit="bar" d={1} /></Cell>
                <Cell><ValueTile label="SPM" value={mp.spm} unit="spm" d={0} /></Cell>
                <Cell><ValueTile label="Flow In" value={mp.flow_in} unit="lpm" d={0} /></Cell>
            </Grid>
            <SubHead title="Fluid / Tanks" />
            <Grid container spacing={1}>
                <Cell><ValueTile label="Total Tank Vol" value={fl.total_tank_volume} unit="m³" d={1} /></Cell>
                <Cell><ValueTile label="Trip Tank" value={fl.trip_tank} unit="m³" d={2} /></Cell>
                <Cell><ValueTile label="Tank Gain/Loss" value={fl.tank_gain_loss} unit="m³" d={2} warn={(n) => Math.abs(n) > 1} /></Cell>
            </Grid>
        </Box>
    );
}

// ---- Tab registry ----
const TABS = [
    { key: 'cat', label: 'Cat Engine', render: (d) => <CatEngineTab g={d.cat_engine} /> },
    { key: 'hpu', label: 'HPU', render: (d) => <HpuTab g={d.hpu} /> },
    { key: 'htd', label: 'HTD', render: (d) => <HtdTab g={d.htd} /> },
    { key: 'pct', label: 'PCT', render: (d) => <PctTab g={d.pct} /> },
    { key: 'acs', label: 'ACS', render: (d) => <AcsTab g={d.acs} /> },
    { key: 'cwk', label: 'CWK', render: (d) => <CwkTab g={d.cwk} /> },
    { key: 'mud', label: 'Mud Pump', render: (d) => <MudPumpTab mp={d.mudpump} fl={d.fluid} /> },
];

export default function EquipmentPanel({ rigId, rig }) {
    const { data, loading, error } = useRigData();
    const [sub, setSub] = useState(0);

    const fr = freshness(data?._meta);
    const safe = data || {};

    return (
        <Box>
            <PanelHead
                title="Equipment"
                right={
                    <Chip
                        size="small"
                        label={fr.text}
                        sx={{ bgcolor: fr.color + '22', color: fr.color, border: `1px solid ${fr.color}55`, fontWeight: 700 }}
                    />
                }
            />

            {error && <Alert severity="warning" sx={{ mb: 1 }}>{String(error)}</Alert>}
            {loading && !data && <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>Loading…</Typography>}

            {/* Compact EDR strip — mirrors the edge equipment page (HPU/HTD + Engine). */}
            <Box sx={{ width: '100%', height: 220, mb: 2 }}>
                <EdrView
                    mode="compact"
                    rigId={rigId}
                    storageKey={`crmf-edr-equip-${rigId}`}
                    defaultStrips={EDR_STRIPS}
                    channels={EDR_CHANNELS}
                />
            </Box>

            <Paper sx={{ p: { xs: 1, sm: 2 } }}>
                <Tabs
                    value={sub}
                    onChange={(_e, v) => setSub(v)}
                    variant="scrollable"
                    scrollButtons="auto"
                    sx={{ mb: 1, minHeight: 40, '& .MuiTab-root': { minHeight: 40, textTransform: 'none', fontWeight: 600 } }}
                >
                    {TABS.map((t) => <Tab key={t.key} label={t.label} />)}
                </Tabs>

                <Box sx={{ pt: 1 }}>
                    {TABS[sub]?.render(safe)}
                </Box>
            </Paper>
        </Box>
    );
}
