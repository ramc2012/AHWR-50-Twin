import React, { useState, useEffect } from 'react';
import { Grid, Paper, Typography, Box, IconButton, Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button, MenuItem, Select, InputLabel, FormControl, Divider, Slider, Switch, FormControlLabel, Checkbox } from '@mui/material';
import io from 'socket.io-client';
import AnalogGauge from '../Common/AnalogGauge';
import RigVisualizer from './RigVisualizer';
import {
    Activity,
    Settings,
    Edit2,
    Database,
    Upload,
    Download,
    RefreshCw,
    Plus,
    Trash2,
    Check,
    X,
    ArrowDownToLine,
    Move
} from 'lucide-react';

const socket = io('/');

// Default Config with Layout Props
const DEFAULT_DASHBOARD_GAUGES = [
    { id: 'd1', label: 'WOH', dataKey: 'hook_load', min: 0, max: 100, unit: 'ton', color: '#3182ce', gridWidth: 3, size: 160, majorTicks: 10, minorTicks: 4 },
    { id: 'd2', label: 'WOB', dataKey: 'wob', min: 0, max: 100, unit: 'kips', color: '#e53e3e', gridWidth: 3, size: 160, majorTicks: 10, minorTicks: 4 },
    { id: 'd6', label: 'HTD RPM', dataKey: 'htd_rpm', min: 0, max: 200, unit: 'RPM', color: '#4ade80', gridWidth: 3, size: 160 },
    { id: 'd7', label: 'HTD TORQUE', dataKey: 'htd_torque', min: 0, max: 1000, unit: 'Nm', color: '#fbbf24', gridWidth: 3, size: 160 },
];

const DEFAULT_BOTTOM_STATS = [
    {
        id: 'p1',
        title: 'DRILLING PARAMETERS',
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
        params: [
            { id: 'p3_1', label: 'HPU', dataKey: 'hpu_status', unit: '' },
            { id: 'p3_2', label: 'HTD', dataKey: 'htd_status', unit: '' },
            { id: 'p3_3', label: 'PCT', dataKey: 'pct_status', unit: '' },
            { id: 'p3_4', label: 'CAT ENGINE', dataKey: 'engine_status', unit: '' },
            { id: 'p3_5', label: 'CWK', dataKey: 'cwk_status', unit: '' }
        ]
    },
    {
        id: 'p4',
        title: 'PCT & CWK',
        params: [
            { id: 'p4_1', label: 'SEQUENCE', dataKey: 'pct_sequence', unit: '' },
            { id: 'p4_2', label: 'SPINNER', dataKey: 'spinner_floating', unit: '' },
            { id: 'p4_3', label: 'CLAMP FORCE', dataKey: 'cwk_clamp_pressure', unit: 'Bar' },
            { id: 'p4_4', label: 'CLAMP', dataKey: 'cwk_clamp_status', unit: '' },
            { id: 'p4_5', label: 'SPINNER TORQUE', dataKey: 'spinner_makeup_torque', unit: 'daN*m' }
        ]
    }
];

export default function RigOverview() {
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
    const [dragOverIndex, setDragOverIndex] = useState(null);
    const [statDragOverIndex, setStatDragOverIndex] = useState(null);

    // Drilling Controls State
    const [isDrillingControlsOpen, setIsDrillingControlsOpen] = useState(false);
    const [calibrationValues, setCalibrationValues] = useState({ bitDepth: '', holeDepth: '', mode: 'wob' });

    // Unit State
    // Unit State
    const [units, setUnits] = useState({ wob: 'tonnes', depth: 'm' });

    const [tempStatKey, setTempStatKey] = useState('');

    // --- Effects ---
    useEffect(() => {
        console.log("Fetching dashboard layout and latest data...");
        // Load Global Layout from Backend
        fetch(`/api/dashboard/layout?t=${Date.now()}`)
            .then(res => res.json())
            .then(config => {
                if (config.gauges) setGauges(config.gauges);
                if (config.units) setUnits(config.units);
                if (config.bottomStats) setBottomStats(config.bottomStats);
            })
            .catch(err => console.error("Failed to load dashboard layout:", err));

        // Fetch Latest Data for immediate display
        fetch('/api/rig/latest')
            .then(res => res.json())
            .then(newData => {
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
        socket.on('dashboard_layout_update', (config) => {
            console.log("Received real-time layout update:", config);
            if (config.gauges) setGauges(config.gauges);
            if (config.units) setUnits(config.units);
            if (config.bottomStats) setBottomStats(config.bottomStats);
        });

        socket.on('rig_data', (newData) => {
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
                    // Preserve stateful depths if needed, or zero them if requested? 
                    // User said "data should be zero", imply sensors. Depth is state.
                    // Let's keep depth from backend (which physics engine maintains) or 0 if backend killed.
                    // But if backend sends {}, we zero sensors.
                }));
                return;
            }
            processRigData(newData);
        });
        return () => socket.off('rig_data');
    }, []);

    // --- Helpers ---
    const saveLayout = (newGauges, newBottomStats) => {
        const payload = {
            gauges: newGauges || gauges,
            bottomStats: newBottomStats || bottomStats,
            units
        };
        fetch('/api/dashboard/layout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).catch(e => console.error("Failed to save layout", e));
    };

    const saveGauges = (newGauges) => {
        setGauges(newGauges);
        saveLayout(newGauges, null);
    };

    const saveBottomStats = (newBottomStats) => {
        setBottomStats(newBottomStats);
        saveLayout(null, newBottomStats);
    };

    const saveUnits = (newUnits) => {
        setUnits(newUnits);
        fetch('/api/dashboard/layout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ gauges, bottomStats, units: newUnits })
        }).catch(e => console.error("Failed to save layout", e));
    };

    const formatWOB = (val) => {
        if (units.wob === 'lbs') return (val * 1000).toFixed(0);
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
        try {
            await fetch('/api/drilling/zero-wob', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentHookLoad: rigData.hook_load })
            });
            // Optional alert or toast
        } catch (e) {
            console.error(e);
            alert("Failed to Zero WOB");
        }
    };

    const handleSetDepth = async () => {
        try {
            // Convert to FT for backend if needed
            let bitDepth = calibrationValues.bitDepth ? Number(calibrationValues.bitDepth) : undefined;
            let holeDepth = calibrationValues.holeDepth ? Number(calibrationValues.holeDepth) : undefined;

            // If user input feet, convert to meters for backend storage (S7 tags are in meters)
            if (units.depth === 'ft') {
                if (bitDepth !== undefined) bitDepth = bitDepth * 0.3048;
                if (holeDepth !== undefined) holeDepth = holeDepth * 0.3048;
            }

            await fetch('/api/drilling/set-depth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ bitDepth, holeDepth })
            });
            setIsDrillingControlsOpen(false);
        } catch (e) {
            console.error(e);
            alert("Failed to Set Depth");
        }
    };

    // --- DnD Helpers ---
    const handleDragStart = (e, id) => {
        e.dataTransfer.setData("text/plain", id);
        e.dataTransfer.effectAllowed = "move";
    };

    const handleDragOver = (e, index) => {
        e.preventDefault();
        setDragOverIndex(index);
    };

    const handleDrop = (e, targetIndex) => {
        e.preventDefault();
        setDragOverIndex(null);
        const draggedId = e.dataTransfer.getData("text/plain");
        if (!draggedId) return;

        const draggedIndex = gauges.findIndex(g => g.id === draggedId);
        if (draggedIndex === -1 || draggedIndex === targetIndex) return;

        const newGauges = [...gauges];
        const [movedItem] = newGauges.splice(draggedIndex, 1);
        newGauges.splice(targetIndex, 0, movedItem);

        saveGauges(newGauges);
    };

    const handleStatDragStart = (e, id) => {
        e.dataTransfer.setData("stat-id", id);
        e.dataTransfer.effectAllowed = "move";
    };

    const handleStatDragOver = (e, index) => {
        e.preventDefault();
        setStatDragOverIndex(index);
    };

    const handleStatDrop = (e, targetIndex) => {
        e.preventDefault();
        setStatDragOverIndex(null);
        const draggedId = e.dataTransfer.getData("stat-id");
        if (!draggedId) return;

        const draggedIndex = bottomStats.findIndex(s => s.id === draggedId);
        if (draggedIndex === -1 || draggedIndex === targetIndex) return;

        const newStats = [...bottomStats];
        const [movedItem] = newStats.splice(draggedIndex, 1);
        newStats.splice(targetIndex, 0, movedItem);

        saveBottomStats(newStats);
    };

    // --- Digital Inputs are now directly parsed from Rig Data ---

    return (
        <Box sx={{ position: 'relative' }}>
            {/* Absolute positioned controls to reclaim vertical space */}
            <Box sx={{ position: 'absolute', top: -16, right: 0, zIndex: 10, display: 'flex', gap: 1 }}>
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
                        onClick={() => setEditMode(!editMode)}
                        sx={{ color: editMode ? '#fbbf24' : '#94a3b8' }}
                        title={editMode ? "Done Editing" : "Edit Layout"}
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

            <Grid container spacing={3} sx={{ alignItems: 'stretch' }}>
                {/* Left Side: Rig Visualizer */}
                <Grid item xs={12} md={3} sx={{ display: 'flex', flexDirection: 'column' }}>
                    <RigVisualizer
                        crownsaverOn={rigData.crownsaverOn}
                        floorsaverOn={rigData.floorsaverOn}
                        travellingUp={rigData.travelling_up}
                        travellingDown={rigData.travelling_down}
                        height={500}
                    />
                </Grid>

                {/* Right Side: Drilling Status Panel & Gauges */}
                <Grid item xs={12} md={9} sx={{ display: 'flex', flexDirection: 'column' }}>
                    {/* --- Drilling Status Panel (Dedicated Stat Panel) --- */}
                    <Paper sx={{ p: 1.5, mb: 3, bgcolor: '#1e293b', color: 'white', display: 'flex', justifyContent: 'space-around', alignItems: 'center', border: '1px solid #334155', height: '86px' }}>
                        {/* Rig Activity Indicator */}
                        <Box sx={{ textAlign: 'center', minWidth: 150, display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, color: '#94a3b8' }}>
                                <Typography variant="caption" sx={{ letterSpacing: 1, fontWeight: 'bold' }}>OP.MODE</Typography>
                            </Box>
                            <Box sx={{ mt: 'auto' }}>
                                <Typography variant="h5" sx={{ fontWeight: 'bold', color: rigData.operation_mode === 1 ? '#4ade80' : '#38bdf8', mt: 0.5 }}>
                                    {getOpModeLabel(rigData.operation_mode)}
                                </Typography>
                            </Box>
                        </Box>

                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />

                        {/* ACS Status Indicator */}
                        <Box sx={{ textAlign: 'center', minWidth: 150, display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, color: '#94a3b8' }}>
                                <Typography variant="caption" sx={{ letterSpacing: 1, fontWeight: 'bold' }}>ACS</Typography>
                            </Box>
                            <Box sx={{ mt: 'auto' }}>
                                <Typography variant="h5" sx={{ fontWeight: 'bold', color: rigData.acs_status === 1 ? '#4ade80' : (rigData.acs_status === 2 ? '#ef4444' : '#94a3b8'), mt: 0.5 }}>
                                    {getAcsStatusLabel(rigData.acs_status)}
                                </Typography>
                            </Box>
                        </Box>

                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />

                        {/* Hole Depth Stat */}
                        <Box sx={{ textAlign: 'center', minWidth: 150, display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, color: '#94a3b8' }}>
                                <Typography variant="caption" sx={{ letterSpacing: 1, fontWeight: 'bold' }}>TOTAL BIT DEPTH</Typography>
                                <IconButton
                                    size="small" sx={{ color: '#64748b', p: 0.5, '&:hover': { color: '#4ade80' } }}
                                    onClick={() => {
                                        setCalibrationValues({ ...calibrationValues, holeDepth: formatDepth(rigData.hole_depth), mode: 'depth' });
                                        setIsDrillingControlsOpen(true);
                                    }}
                                >
                                    <Edit2 size={12} />
                                </IconButton>
                            </Box>
                            <Box sx={{ mt: 'auto' }}>
                                <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#4ade80', mt: 0.5 }}>
                                    {formatDepth(rigData.hole_depth)}
                                    <Button
                                        variant="text" size="small"
                                        sx={{ minWidth: 'auto', p: 0, ml: 0.5, color: '#64748b', fontSize: '11px', lineHeight: 1, minHeight: 0 }}
                                        onClick={() => {
                                            const next = units.depth === 'ft' ? 'm' : 'ft';
                                            saveUnits({ ...units, depth: next });
                                        }}
                                    >
                                        {units.depth}
                                    </Button>
                                </Typography>
                            </Box>
                        </Box>

                        <Divider orientation="vertical" flexItem sx={{ bgcolor: '#334155' }} />

                        {/* Bit Position Stat */}
                        <Box sx={{ textAlign: 'center', minWidth: 150, display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between' }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 1, color: '#94a3b8' }}>
                                <Typography variant="caption" sx={{ letterSpacing: 1, fontWeight: 'bold' }}>BIT DEPTH</Typography>
                                <IconButton
                                    size="small" sx={{ color: '#64748b', p: 0.5, '&:hover': { color: '#38bdf8' } }}
                                    onClick={() => {
                                        setCalibrationValues({ ...calibrationValues, bitDepth: formatDepth(rigData.bit_depth), mode: 'depth' });
                                        setIsDrillingControlsOpen(true);
                                    }}
                                >
                                    <Edit2 size={12} />
                                </IconButton>
                            </Box>
                            <Box sx={{ mt: 'auto' }}>
                                <Typography variant="h5" sx={{ fontWeight: 'bold', color: '#38bdf8', mt: 0.5 }}>
                                    {formatDepth(rigData.bit_depth)}
                                    <Typography component="span" variant="caption" sx={{ ml: 0.5, color: '#64748b' }}>{units.depth}</Typography>
                                </Typography>
                            </Box>
                        </Box>
                    </Paper>

                    {/* Gauges Grid */}
                    <Grid container spacing={2} sx={{ mb: 4, alignItems: 'center' }}>
                        {gauges.map((g, index) => (
                            <Grid
                                item
                                xs={12} sm={6} md={g.gridWidth || 3}
                                key={g.id}
                            >
                                {/* Wrapper DIV for Drag Events */}
                                <div
                                    draggable={editMode}
                                    onDragStart={(e) => editMode && handleDragStart(e, g.id)}
                                    onDragOver={(e) => editMode && handleDragOver(e, index)}
                                    onDrop={(e) => editMode && handleDrop(e, index)}
                                    style={{
                                        cursor: editMode ? 'grab' : 'default',
                                        opacity: editMode && dragOverIndex === index ? 0.5 : 1,
                                        transform: editMode && dragOverIndex === index ? 'scale(0.98)' : 'scale(1)',
                                        transition: 'all 0.2s',
                                        border: editMode && dragOverIndex === index ? '2px dashed #fbbf24' : '2px solid transparent',
                                        borderRadius: 8,
                                        height: '100%'
                                    }}
                                >
                                    <Paper
                                        sx={{
                                            p: 1,
                                            bgcolor: editMode ? 'rgba(30, 41, 59, 0.5)' : 'transparent',
                                            backgroundImage: 'none',
                                            boxShadow: 'none',
                                            color: 'white',
                                            display: 'flex',
                                            flexDirection: 'column',
                                            alignItems: 'center',
                                            justifyContent: 'center',
                                            position: 'relative',
                                            border: editMode ? '1px dashed #475569' : 'none',
                                            height: '100%',
                                            transition: 'all 0.2s',
                                            '&:hover': {
                                                bgcolor: editMode ? '#1e293b' : 'transparent',
                                                boxShadow: editMode ? '0 0 0 2px #334155' : 'none'
                                            }
                                        }}
                                    >
                                        <AnalogGauge
                                            value={Number(rigData[g.dataKey]) || 0}
                                            max={Number(g.max)}
                                            min={Number(g.min)}
                                            label={g.label}
                                            unit={g.unit}
                                            size={g.size || 160}
                                            color={g.color}
                                            majorTicks={g.majorTicks || 5}
                                            minorTicks={g.minorTicks || 4}
                                            // Conditional Props for Hook Load, HTD RPM & PCT TORQUE
                                            subValue={g.dataKey === 'hook_load' ? formatWOB(rigData.wob) : (g.dataKey === 'htd_rpm' ? Number(rigData.ahtd_torque || 0).toFixed(1) : (g.dataKey === 'pct_torque' ? Number(rigData.pct_last_torque || 0).toFixed(1) : undefined))}
                                            subLabel={g.dataKey === 'hook_load' ? `WOB (${units.wob === 'tonnes' ? 'ton' : units.wob})` : (g.dataKey === 'htd_rpm' ? 'TORQUE (daN·m)' : (g.dataKey === 'pct_torque' ? 'LAST TORQUE (daN·m)' : undefined))}
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
                            </Grid>
                        ))}
                    </Grid>
                </Grid>

                {/* Bottom Row: All 4 Multi-Parameter Panels */}
                <Grid item xs={12}>
                    <Grid container spacing={3}>
                        {bottomStats.map((panel, index) => (
                            <Grid item xs={12} md={3} key={panel.id || index}>
                                <div
                                    draggable={editMode}
                                    onDragStart={(e) => editMode && handleStatDragStart(e, panel.id)}
                                    onDragOver={(e) => editMode && handleStatDragOver(e, index)}
                                    onDrop={(e) => editMode && handleStatDrop(e, index)}
                                    style={{
                                        cursor: editMode ? 'grab' : 'default',
                                        opacity: editMode && statDragOverIndex === index ? 0.5 : 1,
                                        transform: editMode && statDragOverIndex === index ? 'scale(0.98)' : 'scale(1)',
                                        transition: 'all 0.2s',
                                        border: editMode && statDragOverIndex === index ? '2px dashed #fbbf24' : '2px solid transparent',
                                        borderRadius: 12,
                                        height: '100%'
                                    }}
                                >
                                    <Paper
                                        sx={{
                                            p: 2.5,
                                            height: '100%',
                                            bgcolor: 'rgba(15, 23, 42, 0.4)',
                                            backdropFilter: 'blur(8px)',
                                            border: '1px solid rgba(56, 189, 248, 0.1)',
                                            borderRadius: 3,
                                            boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
                                            position: 'relative',
                                            overflow: 'hidden',
                                            ...(editMode && {
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
                                                            p: 1.5,
                                                            bgcolor: '#0f172a',
                                                            borderRadius: 1,
                                                            display: 'flex',
                                                            justifyContent: 'space-between',
                                                            alignItems: 'center'
                                                        }}
                                                    >
                                                        <Typography variant="body2" sx={{ color: '#94a3b8', fontWeight: '500' }}>{s.label}</Typography>
                                                        {status ? (
                                                            <Typography sx={{ color: status.color, fontWeight: 'bold' }}>
                                                                {status.label}
                                                            </Typography>
                                                        ) : (
                                                            <Typography sx={{ color: '#38bdf8', fontWeight: 'bold' }}>
                                                                {Number(rigData[s.dataKey] || 0).toFixed(s.dataKey === 'flow_in' || s.dataKey.includes('torque') ? 0 : 1)}
                                                                <span style={{ color: '#64748b', fontSize: '0.75rem', fontWeight: 'normal', marginLeft: '4px' }}>
                                                                    {s.unit}
                                                                </span>
                                                            </Typography>
                                                        )}
                                                    </Box>
                                                );
                                            })}
                                        </Box>
                                    </Paper>
                                </div>
                            </Grid>
                        ))}
                    </Grid>
                </Grid>
            </Grid>

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
                            <MenuItem value="htd_torque">HTD Torque</MenuItem>
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
                                        <MenuItem value="htd_torque">HTD Torque</MenuItem>
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
