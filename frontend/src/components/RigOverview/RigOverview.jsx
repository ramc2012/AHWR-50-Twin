import React, { useState, useEffect } from 'react';
import { Grid, Paper, Typography, Box, IconButton, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, MenuItem, Select, InputLabel, FormControl } from '@mui/material';
import { socket } from '../../socket';
import AnalogGauge from '../Common/AnalogGauge';
import RigVisualizer from './RigVisualizer';
import axios from '../../api';
import { useAuth } from '../../context/AuthContext';
import { Responsive, WidthProvider } from 'react-grid-layout';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

const ResponsiveGridLayout = WidthProvider(Responsive);
import {
    Settings,
    Edit2,
    Plus,
    Trash2,
    Check,
    X
} from 'lucide-react';

// Default Config with Layout Props
const DEFAULT_DASHBOARD_GAUGES = [
    { id: 'd1', label: 'WOH', dataKey: 'hook_load', min: 0, max: 100, unit: 'ton', color: '#3182ce', majorTicks: 10, minorTicks: 4, layout: { i: 'd1', x: 0, y: 0, w: 4, h: 4, minW: 3, minH: 3 } },
    { id: 'd2', label: 'SPP', dataKey: 'SPP-Bar', min: 0, max: 5000, unit: 'psi', color: '#fbbf24', majorTicks: 5, minorTicks: 4, layout: { i: 'd2', x: 4, y: 0, w: 4, h: 4, minW: 3, minH: 3 } },
    { id: 'd6', label: 'HTD RPM', dataKey: 'htd_rpm', min: 0, max: 200, unit: 'RPM', color: '#4ade80', layout: { i: 'd6', x: 8, y: 0, w: 4, h: 4, minW: 3, minH: 3 } },
];

const DEFAULT_BOTTOM_STATS = [
    {
        id: 'p1',
        title: 'DRILLING PARAMETERS',
        layout: { i: 'p1', x: 0, y: 4, w: 3, h: 4, minW: 2, minH: 3 },
        params: [
            { id: 'p1_1', label: 'FLOW IN', dataKey: 'flow_in', unit: 'Lt/min' },
            { id: 'p1_2', label: 'FLOW OUT', dataKey: 'flow_out', unit: '%' },
            { id: 'p1_3', label: 'ROP', dataKey: 'rop', unit: 'm/h' },
            { id: 'p1_4', label: 'SPP', dataKey: 'pump_pressure', unit: 'Bar' },
            { id: 'p1_5', label: 'SPM', dataKey: 'spm', unit: 'SPM' }
        ]
    },
    {
        id: 'p2',
        title: 'HTD STATUS',
        layout: { i: 'p2', x: 3, y: 4, w: 3, h: 4, minW: 2, minH: 3 },
        params: [
            { id: 'p2_1', label: 'IBOP', dataKey: 'ibop_status', unit: '' },
            { id: 'p2_2', label: 'ELEVATOR', dataKey: 'elevator_status', unit: '' },
            { id: 'p2_3', label: 'BREAK', dataKey: 'brake_status', unit: '' },
            { id: 'p2_4', label: 'SPEED', dataKey: 'vertical_speed', unit: 'm/s' },
            { id: 'p2_5', label: 'LINK TILT', dataKey: 'tilt_status', unit: '' }
        ]
    },
    {
        id: 'p3',
        title: 'EQUIPMENT STATUS',
        layout: { i: 'p3', x: 6, y: 4, w: 3, h: 4, minW: 2, minH: 3 },
        params: [
            { id: 'p3_1', label: 'HPU', dataKey: 'hpu_status', unit: '' },
            { id: 'p3_2', label: 'HTD', dataKey: 'htd_status', unit: '' },
            { id: 'p3_3', label: 'PCT', dataKey: 'pct_status', unit: '' },
            { id: 'p3_4', label: 'CAT ENGINE', dataKey: 'engine_status', unit: '' },
            { id: 'p3_5', label: 'CWK', dataKey: 'cwk_status', unit: '' }
        ]
    },
    {
        id: 'p5',
        title: 'CAT ENG',
        layout: { i: 'p5', x: 9, y: 4, w: 3, h: 2, minW: 2, minH: 2 },
        params: [
            { id: 'p5_1', label: 'RPM', dataKey: 'cat_rpm', unit: 'RPM' },
            { id: 'p5_2', label: 'OIL P.', dataKey: 'cat_oil_press', unit: 'bar' }
        ]
    }
];

export default function RigOverview() {
    const { user } = useAuth();
    const canEditLayout = user?.role === 'admin';
    const canCalibrate = user?.role === 'admin' || user?.role === 'operator';

    // --- State ---
    const [rigData, setRigData] = useState({
        hook_load: 0, pump_pressure: 0, torque: 0,
        block_position: 0, flow_in: 0, flow_out: 0,
        wob: 0, bit_depth: 0, hole_depth: 0,
        trip_tank: 0, total_active_volume: 0,
        htd_rpm: 0, htd_torque: 0, ahtd_torque: 0,
        pct_torque: 0, pct_last_torque: 0,
        crownsaver_threshold: 40000, floorsaver_threshold: 2000,
        crownsaverOn: false, floorsaverOn: false,
        travelling_up: false, travelling_down: false,
        acs_status: 0
    });

    const prevBlockPosRef = React.useRef(0);

    const [gauges, setGauges] = useState(DEFAULT_DASHBOARD_GAUGES);
    const [bottomStats, setBottomStats] = useState(DEFAULT_BOTTOM_STATS);
    const [editMode, setEditMode] = useState(false);
    const [editingGauge, setEditingGauge] = useState(null);
    const [editingBottomStat, setEditingBottomStat] = useState(null);
    const [visualizerLayout, setVisualizerLayout] = useState({ i: 'rig-visualizer', x: 0, y: 0, w: 3, h: 8, minW: 2, minH: 4 });

    const getOpModeLabel = (code) => {
        switch (Number(code)) {
            case 1: return "DRILLING";
            case 2: return "TRIP IN";
            case 3: return "TRIP OUT";
            case 4: return "CASING";
            default: return "IDLE";
        }
    };

    const getAcsStatusLabel = (code) => {
        switch (Number(code)) {
            case 1: return "ON";
            case 2: return "OFF";
            case 3: return "DISABLE";
            default: return "UNKNOWN";
        }
    };

    const getStatusLabel = (key, value) => {
        const val = Number(value);
        if (key === 'hpu_status' || key === 'htd_status' || key === 'pct_status') {
            switch (val) {
                case 0: return { label: "OFF", color: "#ef4444" };
                case 1: return { label: "ON IDLE", color: "#fbbf24" };
                case 2: return { label: "ON", color: "#4ade80" };
                default: return { label: "UNKNOWN", color: "#94a3b8" };
            }
        }
        if (key === 'engine_status') {
            switch (val) {
                case -1: return { label: "UNKNOWN", color: "#94a3b8" };
                case 0: return { label: "READY", color: "#38bdf8" };
                case 1: return { label: "IN PROGRESS", color: "#fbbf24" };
                case 2: return { label: "DONE", color: "#4ade80" };
                case 3: return { label: "EMG NOT OK", color: "#ef4444" };
                case 4: return { label: "NOT READY", color: "#ef4444" };
                case 5: return { label: "FAULT", color: "#ef4444" };
                case 6: return { label: "RUN+FAULT", color: "#f97316" };
                case 7: return { label: "STOP FORCED", color: "#ef4444" };
                default: return { label: "UNKNOWN", color: "#94a3b8" };
            }
        }
        if (key === 'cwk_status') {
            return val === 1 ? { label: "PARKED", color: "#4ade80" } : { label: "NOT PARKED", color: "#fbbf24" };
        }
        if (key === 'ibop_status' || key === 'elevator_status') {
            switch (val) {
                case 1: return { label: "OPENING", color: "#fbbf24" };
                case 2: return { label: "CLOSING", color: "#fbbf24" };
                case 3: return { label: "OPEN", color: "#4ade80" };
                case 4: return { label: "CLOSE", color: "#ef4444" };
                case 5: return { label: "FAULT", color: "#ef4444" };
                default: return { label: "UNKNOWN", color: "#94a3b8" };
            }
        }
        if (key === 'brake_status') {
            switch (val) {
                case 1: return { label: "CLOSING", color: "#fbbf24" };
                case 2: return { label: "CLOSED", color: "#ef4444" };
                case 3: return { label: "OPENING", color: "#fbbf24" };
                case 4: return { label: "OPEN", color: "#4ade80" };
                case 5: return { label: "FAULT", color: "#ef4444" };
                default: return { label: "UNKNOWN", color: "#94a3b8" };
            }
        }
        if (key === 'tilt_status') {
            switch (val) {
                case 1: return { label: "FLOAT ON", color: "#38bdf8" };
                case 2: return { label: "VERTICAL", color: "#4ade80" };
                case 3: return { label: "FLOAT OFF", color: "#94a3b8" };
                case 4: return { label: "EXTEND", color: "#fbbf24" };
                case 5: return { label: "RETRACT", color: "#fbbf24" };
                case 6: return { label: "FAULT", color: "#ef4444" };
                default: return { label: "NONE/UNKNOWN", color: "#94a3b8" };
            }
        }
        if (key === 'pct_sequence') {
            switch (val) {
                case 1: return { label: "MAKE-UP", color: "#4ade80" };
                case 2: return { label: "BREAK-OUT", color: "#fbbf24" };
                case 3: return { label: "RESET", color: "#38bdf8" };
                case 4: return { label: "FAULT", color: "#ef4444" };
                default: return { label: "OFF", color: "#94a3b8" };
            }
        }
        if (key === 'spinner_floating') {
            switch (val) {
                case 1: return { label: "ON", color: "#4ade80" };
                case 10: return { label: "NO SPIN", color: "#94a3b8" };
                default: return { label: "OFF", color: "#ef4444" };
            }
        }
        if (key === 'cwk_clamp_status') {
            switch (val) {
                case 1: return { label: "OPENING", color: "#fbbf24" };
                case 2: return { label: "CLOSING", color: "#fbbf24" };
                case 3: return { label: "OPEN", color: "#4ade80" };
                case 4: return { label: "CLOSE", color: "#ef4444" };
                case 5: return { label: "FAULT", color: "#ef4444" };
                default: return { label: "NONE", color: "#94a3b8" };
            }
        }
        return null;
    };
    const [isDialogOpen, setIsDialogOpen] = useState(false);

    // Drag State for Visual Feedback


    // Drilling Controls State
    const [isDrillingControlsOpen, setIsDrillingControlsOpen] = useState(false);
    const [calibrationValues, setCalibrationValues] = useState({ bitDepth: '', holeDepth: '', mode: 'wob' });

    // Unit State
    // Unit State
    const [units, setUnits] = useState({ wob: 'tonnes', depth: 'm' });

    const [tempStatKey, setTempStatKey] = useState('');

    // Live-data freshness / connection state (so a dead feed looks different from an idle rig).
    const [feedState, setFeedState] = useState({ connected: socket.connected, stale: false, hasData: false });

    // --- Effects ---
    useEffect(() => {
        if (import.meta.env.DEV) console.log("Fetching dashboard layout and latest data...");
        // Load Global Layout from Backend
        axios.get(`/api/dashboard/layout?t=${Date.now()}`)
            .then(({ data: config }) => {
                if (config.gauges) setGauges(config.gauges);
                if (config.units) setUnits(config.units);
                if (config.bottomStats) setBottomStats(config.bottomStats);
                if (config.visualizerLayout) setVisualizerLayout(config.visualizerLayout);
            })
            .catch(err => console.error("Failed to load dashboard layout:", err));

        // Fetch Latest Data for immediate display
        axios.get('/api/rig/latest')
            .then(({ data: newData }) => {
                if (newData && Object.keys(newData).length > 0) {
                    processRigData(newData);
                }
            })
            .catch(err => console.error("Failed to fetch latest rig data:", err));
    }, []);

    const processRigData = (newData) => {
        const flattened = {
            hook_load: newData.drawworks?.hook_load || 0,
            block_position: newData.drawworks?.block_position || 0,
            pump_pressure: newData.mudpump?.pressure || 0,
            torque: newData.drilling?.torque || 0,

            flow_in: newData.mudpump?.flow_in || 0,
            flow_out: newData.mudpump?.flow_out || 0,
            spm: newData.mudpump?.spm || 0,

            // Physics & Drilling Data
            wob: newData.drilling?.wob !== undefined ? newData.drilling.wob : 0,
            bit_depth: newData.drilling?.bit_depth || 0,
            hole_depth: newData.drilling?.hole_depth || 0,
            rop: newData.drilling?.rop || 0,
            operation_mode: newData.drilling?.operation_mode || 0,

            // HTD Data
            htd_rpm: newData.htd?.rpm || 0,
            htd_torque: newData.htd?.torque_command || 0,
            ahtd_torque: newData.htd?.torque || 0,
            htd_status: newData.htd?.status || 0,
            ibop_status: newData.htd?.ibop_status || 0,
            elevator_status: newData.htd?.elevator_status || 0,
            brake_status: newData.htd?.brake_status || 0,
            vertical_speed: newData.htd?.vertical_speed || 0,
            tilt_status: newData.htd?.tilt_status || 0,

            // PCT Data
            pct_torque: newData.pct?.makeup_torque || 0,
            pct_last_torque: newData.pct?.last_makeup_torque || 0,
            pct_status: newData.pct?.status || 0,
            pct_sequence: newData.pct?.sequence || 0,
            spinner_floating: newData.pct?.spinner_floating || 0,
            spinner_makeup_torque: newData.pct?.spinner_makeup_torque || 0,

            // HPU Data
            hpu_status: newData.hpu?.status || 0,

            // CAT Engine
            engine_status: newData.cat_engine?.status || 0,
            cat_rpm: newData.cat_engine?.rpm || 0,
            cat_oil_press: newData.cat_engine?.oil_pressure || 0,

            // CWK Data
            cwk_status: newData.cwk?.status || 0,
            cwk_clamp_status: newData.cwk?.clamp_status || 0,
            cwk_clamp_pressure: newData.cwk?.clamp_pressure || 0,

            // Fluid System
            trip_tank: newData.fluid?.trip_tank || 0,
            total_active_volume: newData.fluid?.total_tank_volume || 0,

            // Safety Thresholds from ACS
            crownsaver_threshold: newData.acs?.crownsaver || 40000,
            floorsaver_threshold: newData.acs?.floorsaver || 2000,
            acs_status: newData.acs?.status || 0,

            // Digital Inputs - Calculated locally below
        };

        // Local status calculation
        const currentBlockPos = flattened.block_position;
        const prevBlockPos = prevBlockPosRef.current;
        const delta = currentBlockPos - prevBlockPos;

        flattened.travelling_up = delta > 0.05;
        flattened.travelling_down = delta < -0.05;
        flattened.crownsaverOn = (currentBlockPos * 1000) >= flattened.crownsaver_threshold;
        flattened.floorsaverOn = (currentBlockPos * 1000) <= flattened.floorsaver_threshold;

        prevBlockPosRef.current = currentBlockPos;

        setRigData(prev => ({ ...prev, ...flattened }));
    };



    // --- Effects ---
    // (Consolidated above)

    useEffect(() => {
        // Real-time Layout Updates
        const handleLayoutUpdate = (config) => {
            if (import.meta.env.DEV) console.log("Received real-time layout update:", config);
            if (config.gauges) setGauges(config.gauges);
            if (config.units) setUnits(config.units);
            if (config.bottomStats) setBottomStats(config.bottomStats);
            if (config.visualizerLayout) setVisualizerLayout(config.visualizerLayout);
        };
        socket.on('dashboard_layout_update', handleLayoutUpdate);

        const handleRigData = (newData) => {
            // Track feed freshness from server metadata (when present).
            const meta = newData && newData._meta;
            setFeedState(prev => ({
                connected: socket.connected,
                stale: meta ? !!meta.stale : prev.stale,
                hasData: true
            }));

            // If we receive an empty object or null, force release to zero
            if (!newData || Object.keys(newData).length === 0) {
                setRigData(prev => ({
                    ...prev,
                    hook_load: 0, pump_pressure: 0, torque: 0,
                    block_position: 0, flow_in: 0, flow_out: 0,
                    wob: 0, trip_tank: 0, total_active_volume: 0, spm: 0,
                    htd_rpm: 0, htd_torque: 0, ahtd_torque: 0,
                    pct_torque: 0, pct_last_torque: 0,
                    pct_sequence: 0, spinner_floating: 0,
                    spinner_makeup_torque: 0,
                    cwk_clamp_status: 0, cwk_clamp_pressure: 0,
                }));
                return;
            }
            processRigData(newData);
        };
        socket.on('rig_data', handleRigData);

        const handleConnect = () => setFeedState(prev => ({ ...prev, connected: true }));
        const handleDisconnect = () => setFeedState(prev => ({ ...prev, connected: false }));
        socket.on('connect', handleConnect);
        socket.on('disconnect', handleDisconnect);

        return () => {
            socket.off('dashboard_layout_update', handleLayoutUpdate);
            socket.off('rig_data', handleRigData);
            socket.off('connect', handleConnect);
            socket.off('disconnect', handleDisconnect);
        };
    }, []);

    // --- Helpers ---
    const saveLayout = (newGauges, newBottomStats, newVisualizerLayout) => {
        const payload = {
            gauges: newGauges || gauges,
            bottomStats: newBottomStats || bottomStats,
            visualizerLayout: newVisualizerLayout || visualizerLayout,
            units
        };
        axios.post('/api/dashboard/layout', payload)
            .catch(e => console.error("Failed to save layout", e));
    };

    const saveGauges = (newGauges) => {
        setGauges(newGauges);
        saveLayout(newGauges, null, null);
    };

    const saveBottomStats = (newBottomStats) => {
        setBottomStats(newBottomStats);
        saveLayout(null, newBottomStats, null);
    };

    const saveVisualizerLayout = (newVisLayout) => {
        setVisualizerLayout(newVisLayout);
        saveLayout(null, null, newVisLayout);
    };

    const saveUnits = (newUnits) => {
        setUnits(newUnits);
        if (canEditLayout) {
            axios.post('/api/dashboard/layout', { gauges, bottomStats, units: newUnits })
                .catch(e => console.error("Failed to save layout", e));
        }
    };

    const formatWOB = (val) => {
        if (units.wob === 'lbs') return (val * 1000).toFixed(1);
        if (units.wob === 'tonnes') return (val * 0.453592).toFixed(1);
        return val; // kips
    };

    const formatDepth = (val) => {
        if (units.depth === 'ft') return (val / 0.3048).toFixed(1);
        return val.toFixed(1); // meters
    };

    // --- Handlers ---
    const handleAddGauge = () => {
        if (gauges.length >= 5) return;
        const newId = `d-${Date.now()}`;
        const newGauge = {
            id: newId,
            label: 'NEW GAUGE',
            dataKey: 'hook_load',
            min: 0, max: 100,
            unit: 'unit',
            color: '#3182ce',
            gridWidth: 3,
            size: 160
        };
        saveGauges([...gauges, newGauge]);
    };

    const handleRemoveGauge = (id) => {
        if (window.confirm("Delete this gauge?")) {
            saveGauges(gauges.filter(g => g.id !== id));
        }
    };

    const handleEditSave = () => {
        const newGauges = gauges.map(g => g.id === editingGauge.id ? editingGauge : g);
        saveGauges(newGauges);
        setIsDialogOpen(false);
    };

    const handleBottomStatEditSave = () => {
        const newStats = bottomStats.map(s => s.id === editingBottomStat.id ? editingBottomStat : s);
        saveBottomStats(newStats);
        setEditingBottomStat(null);
    };

    const handleReset = () => {
        if (window.confirm("Reset dashboard to default CENTERED layout?")) {
            saveGauges(DEFAULT_DASHBOARD_GAUGES);
        }
    };

    // --- Drilling API Calls ---
    const handleZeroWOB = async () => {
        if (!canCalibrate) return;
        try {
            await axios.post('/api/drilling/zero-wob', { currentHookLoad: rigData.hook_load });
            // Optional alert or toast
        } catch (e) {
            console.error(e);
            alert("Failed to Zero WOB");
        }
    };

    const handleSetDepth = async () => {
        if (!canCalibrate) return;
        try {
            // Convert to FT for backend if needed
            let bitDepth = calibrationValues.bitDepth ? Number(calibrationValues.bitDepth) : undefined;
            let holeDepth = calibrationValues.holeDepth ? Number(calibrationValues.holeDepth) : undefined;

            // If user input feet, convert to meters for backend storage (S7 tags are in meters)
            if (units.depth === 'ft') {
                if (bitDepth !== undefined) bitDepth = bitDepth * 0.3048;
                if (holeDepth !== undefined) holeDepth = holeDepth * 0.3048;
            }

            await axios.post('/api/drilling/set-depth', { bitDepth, holeDepth });
            setIsDrillingControlsOpen(false);
        } catch (e) {
            console.error(e);
            alert("Failed to Set Depth");
        }
    };



    // --- Digital Inputs are now directly parsed from Rig Data ---

    const feedAlert = !feedState.connected
        ? { text: 'NO LIVE DATA - TELEMETRY DISCONNECTED', color: '#ef4444' }
        : (feedState.stale
            ? { text: 'STALE DATA - FEED NOT UPDATING (values may not be live)', color: '#fbbf24' }
            : (!feedState.hasData
                ? { text: 'WAITING FOR LIVE DATA...', color: '#fbbf24' }
                : null));

    const statusCellSx = {
        minWidth: 0,
        minHeight: { xs: 78, sm: 74 },
        p: { xs: 1, sm: 1.25 },
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: 0.75,
        border: '1px solid #334155',
        borderRadius: 1,
        bgcolor: 'rgba(15, 23, 42, 0.25)'
    };

    const statusValueSx = {
        fontWeight: 'bold',
        mt: 0.5,
        lineHeight: 1.1,
        fontSize: { xs: '1rem', sm: '1.35rem', md: '1.5rem' },
        overflowWrap: 'anywhere'
    };

    const renderStatPanel = (panel, index) => (
        <Paper
            sx={{
                p: 2.5,
                height: '100%',
                bgcolor: 'rgba(15, 23, 42, 0.6)',
                backdropFilter: 'blur(12px)',
                border: editMode ? '1px dashed #475569' : '1px solid rgba(56, 189, 248, 0.2)',
                borderRadius: 3,
                boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                position: 'relative',
                overflow: 'hidden',
                transition: 'all 0.2s',
                ...(editMode && {
                    '&:hover': {
                        bgcolor: '#1e293b',
                        boxShadow: '0 0 0 2px #334155'
                    },
                    '&::before': {
                        content: '""',
                        position: 'absolute',
                        top: 0, left: 0, right: 0, height: '4px',
                        bgcolor: '#fbbf24',
                        opacity: 0.6
                    }
                })
            }}
        >
                <Typography
                    variant="subtitle2"
                    sx={{
                        color: '#38bdf8',
                        fontWeight: '800',
                        mb: 2.5,
                        letterSpacing: 1.5,
                        textAlign: 'center',
                        textShadow: '0 0 10px rgba(56, 189, 248, 0.3)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 1
                    }}
                >
                    {panel.title}
                    {editMode && (
                        <IconButton
                            size="small"
                            onClick={() => setEditingBottomStat(panel)}
                            sx={{ color: '#fbbf24', p: 0.5 }}
                        >
                            <Edit2 size={14} />
                        </IconButton>
                    )}
                </Typography>

                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                    {panel.params.map((s, sIdx) => {
                        const status = getStatusLabel(s.dataKey, rigData[s.dataKey]);
                        return (
                            <Box
                                key={s.id || sIdx}
                                sx={{
                                    p: 2,
                                    bgcolor: 'rgba(30, 41, 59, 0.5)',
                                    borderRadius: 2,
                                    border: '1px solid rgba(148, 163, 184, 0.1)',
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.2)'
                                }}
                            >
                                <Typography variant="body1" sx={{ color: '#cbd5e1', fontWeight: '600', letterSpacing: 0.5 }}>{s.label}</Typography>
                                {status ? (
                                    <Typography sx={{ color: status.color, fontWeight: '800', fontSize: '1.1rem', textShadow: `0 0 8px ${status.color}40` }}>
                                        {status.label}
                                    </Typography>
                                ) : (
                                    <Typography sx={{ color: '#38bdf8', fontWeight: '800', fontSize: '1.25rem', textShadow: '0 0 10px rgba(56,189,248,0.3)' }}>
                                        {Number(rigData[s.dataKey] || 0).toFixed(1)}
                                        <span style={{ color: '#94a3b8', fontSize: '0.85rem', fontWeight: '600', marginLeft: '6px' }}>
                                            {s.unit}
                                        </span>
                                    </Typography>
                                )}
                            </Box>
                        );
                    })}
                </Box>
            </Paper>
    );

    return (
        <Box sx={{ position: 'relative', maxWidth: '100%', overflowX: 'hidden' }}>


            {/* Absolute positioned controls to reclaim vertical space */}
            {canEditLayout && (
            <Box sx={{ position: { xs: 'static', sm: 'absolute' }, top: -16, right: 0, zIndex: 10, display: 'flex', justifyContent: 'flex-end', gap: 1, mb: { xs: 1, sm: 0 } }}>
                {editMode && gauges.length < 5 && (
                    <Button
                        variant="contained"
                        startIcon={<Plus size={18} />}
                        onClick={handleAddGauge}
                        sx={{ bgcolor: '#3b82f6', '&:hover': { bgcolor: '#2563eb' } }}
                    >
                        Add Gauge
                    </Button>
                )}
                <Box sx={{ display: 'flex', bgcolor: '#1e293b', borderRadius: 1 }}>
                    <IconButton
                        size="small"
                        onClick={() => {
                            if (editMode) {
                                saveLayout(gauges, bottomStats, visualizerLayout);
                            }
                            setEditMode(!editMode);
                        }}
                        sx={{ color: editMode ? '#fbbf24' : '#94a3b8' }}
                        title={editMode ? "Save Layout" : "Edit Layout"}
                    >
                        {editMode ? <Check size={18} /> : <Edit2 size={18} />}
                    </IconButton>
                    {editMode && (
                        <IconButton size="small" onClick={handleReset} sx={{ color: '#ef4444' }} title="Reset Defaults">
                            <X size={18} />
                        </IconButton>
                    )}
                </Box>
            </Box>
            )}

            <Box sx={{ flexGrow: 1, position: 'relative' }}>
                <ResponsiveGridLayout
                    className="layout"
                    layouts={(() => {
                        const layoutItems = [
                            visualizerLayout,
                            ...gauges.map(g => g.layout || { i: g.id, x: 0, y: 0, w: 4, h: 4 }),
                            ...bottomStats.map(s => s.layout || { i: s.id, x: 0, y: 4, w: 3, h: 4 })
                        ];
                        return {
                            lg: layoutItems,
                            md: layoutItems,
                            sm: layoutItems,
                            xs: layoutItems,
                            xxs: layoutItems
                        };
                    })()}
                    breakpoints={{ lg: 1200, md: 996, sm: 768, xs: 480, xxs: 0 }}
                    cols={{ lg: 12, md: 10, sm: 6, xs: 4, xxs: 2 }}
                    rowHeight={50}
                    margin={[16, 16]}
                    isDraggable={editMode}
                    isResizable={editMode}
                    compactType="vertical"
                    useCSSTransforms={true}
                    onLayoutChange={(currentLayout) => {
                        if (!editMode) return;
                        
                        const visL = currentLayout.find(item => item.i === 'rig-visualizer');
                        if (visL) setVisualizerLayout({ i: 'rig-visualizer', x: visL.x, y: visL.y, w: visL.w, h: visL.h, minW: 2, minH: 4 });

                        const newGauges = gauges.map(g => {
                            const l = currentLayout.find(item => item.i === g.id);
                            return l ? { ...g, layout: { i: g.id, x: l.x, y: l.y, w: l.w, h: l.h, minW: 3, minH: 3 } } : g;
                        });

                        const newStats = bottomStats.map(s => {
                            const l = currentLayout.find(item => item.i === s.id);
                            return l ? { ...s, layout: { i: s.id, x: l.x, y: l.y, w: l.w, h: l.h, minW: 2, minH: 3 } } : s;
                        });

                        setGauges(newGauges);
                        setBottomStats(newStats);
                    }}
                >
                    <div key="rig-visualizer" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
                        <div style={{ flexGrow: 1, position: 'relative', width: '100%', height: '100%' }}>
                            <RigVisualizer
                                blockPosition={rigData.block_position}
                                slipsIn={rigData.slips_in}
                            />
                        </div>
                    </div>
                    {gauges.map((g) => (
                        <div key={g.id} style={{ height: '100%' }}>
                            <Paper
                                sx={{
                                    p: 2.5,
                                    bgcolor: 'rgba(15, 23, 42, 0.6)',
                                    backdropFilter: 'blur(12px)',
                                    border: editMode ? '1px dashed #475569' : '1px solid rgba(56, 189, 248, 0.2)',
                                    borderRadius: 3,
                                    boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
                                    color: 'white',
                                    display: 'flex',
                                    flexDirection: 'column',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    position: 'relative',
                                    height: '100%',
                                    width: '100%',
                                    transition: 'all 0.2s',
                                    '&:hover': {
                                        bgcolor: editMode ? '#1e293b' : 'rgba(15, 23, 42, 0.8)',
                                        boxShadow: editMode ? '0 0 0 2px #334155' : '0 8px 32px rgba(0,0,0,0.4)'
                                    }
                                }}
                            >
                                <AnalogGauge
                                    value={(g.unit === 'psi' && g.dataKey === 'SPP-Bar') ? (Number(rigData[g.dataKey]) * 14.50377) || 0 : Number(rigData[g.dataKey]) || 0}
                                    max={Number(g.max)}
                                    min={Number(g.min)}
                                    label={g.label}
                                    unit={g.unit}
                                    size="fill"
                                    minSize={150}
                                    maxSize={800}
                                    color={g.color}
                                    majorTicks={g.majorTicks || 5}
                                    minorTicks={g.minorTicks || 4}
                                    subValue={g.dataKey === 'hook_load' ? formatWOB(rigData.wob) : (g.dataKey === 'htd_rpm' ? Number(rigData.ahtd_torque || 0).toFixed(1) : (g.dataKey === 'pct_torque' ? Number(rigData.pct_last_torque || 0).toFixed(1) : undefined))}
                                    subLabel={g.dataKey === 'hook_load' ? `WOB (${units.wob === 'tonnes' ? 'ton' : units.wob})` : (g.dataKey === 'htd_rpm' ? 'TORQUE (daN·m)' : (g.dataKey === 'pct_torque' ? 'LAST TORQUE (daN·m)' : undefined))}
                                    subValueInside
                                />

                                {editMode && (
                                    <Box sx={{
                                        position: 'absolute', top: 0, right: 0, p: 1,
                                        display: 'flex', gap: 1, zIndex: 10
                                    }}>
                                        <IconButton
                                            size="small"
                                            onClick={(e) => { e.stopPropagation(); setEditingGauge({ ...g }); setIsDialogOpen(true); }}
                                            sx={{ bgcolor: '#fbbf24', color: 'black', '&:hover': { bgcolor: '#f59e0b' } }}
                                            title="Edit Settings"
                                        >
                                            <Settings size={14} />
                                        </IconButton>
                                        <IconButton
                                            size="small"
                                            onClick={(e) => { e.stopPropagation(); handleRemoveGauge(g.id); }}
                                            sx={{ color: 'white', bgcolor: '#ef4444', '&:hover': { bgcolor: '#dc2626' } }}
                                            title="Remove"
                                        >
                                            <Trash2 size={14} />
                                        </IconButton>
                                    </Box>
                                )}

                                {editMode && (
                                    <Box sx={{ position: 'absolute', bottom: 5, left: '50%', transform: 'translateX(-50%)', color: '#64748b', pointerEvents: 'none' }}>
                                        <Typography variant="caption" sx={{ fontSize: 10 }}>DRAG TO MOVE</Typography>
                                    </Box>
                                )}
                            </Paper>
                        </div>
                    ))}
                    {bottomStats.map((panel, idx) => (
                        <div key={panel.id} style={{ height: '100%' }}>
                            {renderStatPanel(panel, idx)}
                        </div>
                    ))}
                </ResponsiveGridLayout>
            </Box>

            {/* Edit Dialog - Gauge Configuration */}
            <Dialog
                open={isDialogOpen}
                onClose={() => setIsDialogOpen(false)}
                PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white', minWidth: 400 } }}
            >
                <DialogTitle>Edit Gauge</DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2, mt: 1 }}>
                        <TextField
                            label="Data Source" select
                            value={editingGauge?.dataKey || ''}
                            onChange={(e) => setEditingGauge({ ...editingGauge, dataKey: e.target.value })}
                            fullWidth size="small"
                            sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' }, '& .MuiSelect-select': { color: 'white' } }}
                        >
                            <MenuItem value="hook_load">Hook Load (WOH)</MenuItem>
                            <MenuItem value="wob">Weight on Bit (WOB)</MenuItem>
                            <MenuItem value="htd_rpm">HTD RPM</MenuItem>
                            <MenuItem value="SPP-Bar">SPP (Standpipe Pressure)</MenuItem>
                            <MenuItem value="pct_torque">PCT Torque</MenuItem>
                        </TextField>

                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <TextField
                                label="Label"
                                value={editingGauge?.label || ''}
                                onChange={(e) => setEditingGauge({ ...editingGauge, label: e.target.value })}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                            <TextField
                                label="Unit"
                                value={editingGauge?.unit || ''}
                                onChange={(e) => setEditingGauge({ ...editingGauge, unit: e.target.value })}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                        </Box>

                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <TextField
                                label="Min" type="number"
                                value={editingGauge?.min}
                                onChange={(e) => setEditingGauge({ ...editingGauge, min: e.target.value })}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                            <TextField
                                label="Max" type="number"
                                value={editingGauge?.max}
                                onChange={(e) => setEditingGauge({ ...editingGauge, max: e.target.value })}
                                fullWidth size="small"
                                sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                            />
                        </Box>

                        <Box sx={{ display: 'flex', gap: 2 }}>
                            <FormControl fullWidth size="small">
                                <InputLabel sx={{ color: '#94a3b8' }}>Grid Width</InputLabel>
                                <Select
                                    value={editingGauge?.gridWidth || 3}
                                    label="Grid Width"
                                    onChange={(e) => setEditingGauge({ ...editingGauge, gridWidth: Number(e.target.value) })}
                                    sx={{ color: 'white', '.MuiOutlinedInput-notchedOutline': { borderColor: '#94a3b8' } }}
                                >
                                    <MenuItem value={3}>Small (1/4)</MenuItem>
                                    <MenuItem value={4}>Medium (1/3)</MenuItem>
                                    <MenuItem value={6}>Half (1/2)</MenuItem>
                                    <MenuItem value={8}>Large (2/3)</MenuItem>
                                    <MenuItem value={12}>Full Width</MenuItem>
                                </Select>
                            </FormControl>
                            <FormControl fullWidth size="small">
                                <InputLabel sx={{ color: '#94a3b8' }}>Gauge Size</InputLabel>
                                <Select
                                    value={editingGauge?.size || 160}
                                    label="Gauge Size"
                                    onChange={(e) => setEditingGauge({ ...editingGauge, size: Number(e.target.value) })}
                                    sx={{ color: 'white', '.MuiOutlinedInput-notchedOutline': { borderColor: '#94a3b8' } }}
                                >
                                    <MenuItem value={140}>Tiny (140px)</MenuItem>
                                    <MenuItem value={160}>Small (160px)</MenuItem>
                                    <MenuItem value={220}>Medium (220px)</MenuItem>
                                    <MenuItem value={300}>Large (300px)</MenuItem>
                                    <MenuItem value={380}>Huge (380px)</MenuItem>
                                </Select>
                            </FormControl>
                        </Box>
                    </Box>
                </DialogContent>
            </Dialog>

            {/* Bottom Stat Edit Dialog */}
            <Dialog
                open={Boolean(editingBottomStat)}
                onClose={() => setEditingBottomStat(null)}
                PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white', minWidth: 500 } }}
            >
                <DialogTitle sx={{ borderBottom: '1px solid #334155', mb: 2 }}>Edit Bottom Stat Panel</DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, mt: 1 }}>
                        <TextField
                            label="Panel Title"
                            value={editingBottomStat?.title || ''}
                            onChange={(e) => setEditingBottomStat({ ...editingBottomStat, title: e.target.value })}
                            fullWidth size="small"
                            sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#fbbf24' } }}
                        />

                        {editingBottomStat?.params.map((p, idx) => (
                            <Box key={idx} sx={{ p: 2, border: '1px solid #334155', borderRadius: 2, position: 'relative' }}>
                                <Typography variant="caption" sx={{ position: 'absolute', top: -10, left: 10, bgcolor: '#1e293b', px: 1, color: '#94a3b8' }}>
                                    Slot {idx + 1}
                                </Typography>
                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                    <TextField
                                        label="Data Source" select
                                        value={p.dataKey || ''}
                                        onChange={(e) => {
                                            const newParams = [...editingBottomStat.params];
                                            newParams[idx] = { ...p, dataKey: e.target.value };
                                            setEditingBottomStat({ ...editingBottomStat, params: newParams });
                                        }}
                                        fullWidth size="small"
                                        sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' }, '& .MuiSelect-select': { color: 'white' } }}
                                    >
                                        <MenuItem value="flow_in">Flow In</MenuItem>
                                        <MenuItem value="flow_out">Flow Out</MenuItem>
                                        <MenuItem value="rop">ROP</MenuItem>
                                        <MenuItem value="bit_depth">Bit Depth</MenuItem>
                                        <MenuItem value="hole_depth">Total Depth</MenuItem>
                                        <MenuItem value="trip_tank">Trip Tank</MenuItem>
                                        <MenuItem value="total_active_volume">Total Volume</MenuItem>
                                        <MenuItem value="pump_pressure">SPP</MenuItem>
                                        <MenuItem value="torque">Torque</MenuItem>
                                        <MenuItem value="htd_rpm">HTD RPM</MenuItem>
                                        <MenuItem value="SPP-Bar">SPP (Standpipe Pressure)</MenuItem>
                                        <MenuItem value="pct_torque">PCT Torque</MenuItem>
                                        <MenuItem value="hook_load">Hook Load</MenuItem>
                                        <MenuItem value="wob">WOB</MenuItem>
                                    </TextField>
                                    <Box sx={{ display: 'flex', gap: 2 }}>
                                        <TextField
                                            label="Label"
                                            value={p.label || ''}
                                            onChange={(e) => {
                                                const newParams = [...editingBottomStat.params];
                                                newParams[idx] = { ...p, label: e.target.value };
                                                setEditingBottomStat({ ...editingBottomStat, params: newParams });
                                            }}
                                            fullWidth size="small"
                                            sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                                        />
                                        <TextField
                                            label="Unit"
                                            value={p.unit || ''}
                                            onChange={(e) => {
                                                const newParams = [...editingBottomStat.params];
                                                newParams[idx] = { ...p, unit: e.target.value };
                                                setEditingBottomStat({ ...editingBottomStat, params: newParams });
                                            }}
                                            fullWidth size="small"
                                            sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                                        />
                                    </Box>
                                </Box>
                            </Box>
                        ))}
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setEditingBottomStat(null)} sx={{ color: '#94a3b8' }}>Cancel</Button>
                    <Button onClick={handleBottomStatEditSave} variant="contained" sx={{ bgcolor: '#fbbf24', color: 'black' }}>Save</Button>
                </DialogActions>
            </Dialog>

            {/* Drilling Controls Dialog (Values & Units) */}
            <Dialog
                open={isDrillingControlsOpen}
                onClose={() => setIsDrillingControlsOpen(false)}
                PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white', minWidth: 350 } }}
            >
                <DialogTitle>
                    {calibrationValues.mode === 'wob' ? 'Calibrate WOB' : 'Set Depths'}
                </DialogTitle>
                <DialogContent>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3, mt: 2 }}>
                        {(!calibrationValues.mode || calibrationValues.mode === 'wob') && (
                            <Box>
                                <Typography variant="subtitle2" sx={{ color: '#94a3b8', mb: 1 }}>Settings</Typography>
                                <FormControl fullWidth size="small" sx={{ mb: 2 }}>
                                    <InputLabel sx={{ color: '#94a3b8' }}>Display Unit</InputLabel>
                                    <Select
                                        value={units.wob}
                                        label="Display Unit"
                                        onChange={(e) => saveUnits({ ...units, wob: e.target.value })}
                                        sx={{ color: 'white', '.MuiOutlinedInput-notchedOutline': { borderColor: '#94a3b8' } }}
                                    >
                                        <MenuItem value="kips">Kips (1000 lbs)</MenuItem>
                                        <MenuItem value="lbs">Pounds (lbs)</MenuItem>
                                        <MenuItem value="tonnes">Tonnes (Metric)</MenuItem>
                                    </Select>
                                </FormControl>
                                <Button
                                    fullWidth variant="contained"
                                    color="warning"
                                    onClick={handleZeroWOB}
                                >
                                    Zero WOB (Tare Hook Load)
                                </Button>
                            </Box>
                        )}

                        {(!calibrationValues.mode || calibrationValues.mode === 'depth') && (
                            <Box>
                                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                                    <Typography variant="subtitle2" sx={{ color: '#94a3b8' }}>Depth Tracking</Typography>
                                    <Button
                                        size="small" variant="text"
                                        onClick={() => saveUnits({ ...units, depth: units.depth === 'ft' ? 'm' : 'ft' })}
                                    >
                                        Unit: {units.depth.toUpperCase()}
                                    </Button>
                                </Box>
                                <Box sx={{ display: 'flex', gap: 2, mb: 1 }}>
                                    <TextField
                                        label={`Bit Depth (${units.depth})`} size="small" type="number"
                                        value={calibrationValues.bitDepth}
                                        onChange={(e) => setCalibrationValues({ ...calibrationValues, bitDepth: e.target.value })}
                                        sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                                    />
                                    <TextField
                                        label={`TOTAL DEPTH (${units.depth})`} size="small" type="number"
                                        value={calibrationValues.holeDepth}
                                        onChange={(e) => setCalibrationValues({ ...calibrationValues, holeDepth: e.target.value })}
                                        sx={{ '& .MuiOutlinedInput-root': { color: 'white' }, '& .MuiInputLabel-root': { color: '#94a3b8' } }}
                                    />
                                </Box>
                                <Button fullWidth variant="contained" onClick={handleSetDepth}>Update Depths</Button>
                            </Box>
                        )}
                    </Box>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setIsDrillingControlsOpen(false)} sx={{ color: '#94a3b8' }}>Close</Button>
                </DialogActions>
            </Dialog>

        </Box>
    );
}
