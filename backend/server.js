'use strict';
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const http = require('http');
const { Server } = require("socket.io");
const { InfluxDB } = require('@influxdata/influxdb-client');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const auth = require('./lib/auth');
const validate = require('./lib/validate');
const ldap = require('./lib/ldap');
const alarms = require('./lib/alarms');
const workover = require('./lib/workover');
const maintenance = require('./lib/maintenance');
const edrCatalog = require('../shared/edrMetrics.json');

const PORT = Number(process.env.PORT || 5000);
const DATA_DIR = process.env.DATA_DIR || __dirname;
const INFLUX_URL = process.env.INFLUX_URL || 'http://influxdb:8086';
const INFLUX_TOKEN = process.env.INFLUX_TOKEN;
const INFLUX_ORG = process.env.INFLUX_ORG || 'romii_org';
const INFLUX_BUCKET = process.env.INFLUX_BUCKET || 'romii_bucket';
const DATA_SOURCE = process.env.DATA_SOURCE || 'plc';
const MAX_WELL_DEPTH = Number(process.env.MAX_WELL_DEPTH_M || 15000); // sanity clamp (m)
const FRESH_MS = Number(process.env.DATA_FRESH_MS || 5000);          // data older than this = stale

if (!INFLUX_TOKEN) {
    console.error('FATAL: INFLUX_TOKEN env var is required (no hardcoded fallback). Refusing to start.');
    process.exit(1);
}

// Allowed browser origins. Same-origin (served behind nginx) needs no entry;
// set CORS_ORIGIN (comma-separated) only for cross-origin dev access.
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
const allowedOrigin = CORS_ORIGINS.length ? CORS_ORIGINS : false;

const app = express();
app.set('trust proxy', 1); // behind nginx
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: allowedOrigin, methods: ['GET', 'POST'], credentials: true } });

app.use(helmet());
app.use(cors({ origin: allowedOrigin, methods: ['GET', 'POST'], credentials: true }));
app.use(express.json({ limit: '1mb' }));

// Unauthenticated health checks (used by the Docker healthcheck / probes).
app.get('/', (req, res) => res.send('ROM-II Backend is running'));
app.get('/healthz', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// Require a valid JWT on the Socket.io handshake before any telemetry streams.
io.use(auth.socketAuth);
io.on('connection', (socket) => {
    socket.emit('rig_data', latestRigData);            // prime newly-connected clients
    socket.emit('dashboard_layout_update', getDashboardConfig());
    socket.emit('alarms', alarms.snapshot());          // prime the alarm banner/list
});

// InfluxDB Query Client
const queryApi = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN }).getQueryApi(INFLUX_ORG);

// --- Atomic JSON persistence (temp file + rename; off the hot loop) -------
const writeJsonAtomic = async (file, obj) => {
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
    await fsp.rename(tmp, file);
};
const readJsonSync = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file)); } catch { return fallback; }
};

// --- Drilling Physics Engine ---
const DRILLING_STATE_FILE = path.join(DATA_DIR, 'drilling_state.json');
let drillingState = {
    stringWeight: 0,     // tonnes-force (tare/string weight captured at zero-WOB)
    totalDepth: 304.8,   // m (seed = 1000 ft)
    bitDepth: 0,         // m
    lastBlockPosition: 0 // ft (block position is in feet)
};

// Reject NaN/negative/absurd depths; bound to a configured maximum well depth.
function clampDepth(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(n, MAX_WELL_DEPTH);
}

// Load state from disk if present, then clamp any out-of-range persisted values.
{
    const saved = readJsonSync(DRILLING_STATE_FILE, null);
    if (saved) drillingState = { ...drillingState, ...saved };
    drillingState.bitDepth = clampDepth(drillingState.bitDepth);
    drillingState.totalDepth = clampDepth(drillingState.totalDepth);
}

// Persistence is decoupled from the 1 Hz poll loop: mark dirty, flush async.
let drillingDirty = false;
const markDrillingDirty = () => { drillingDirty = true; };
const flushDrillingState = async () => {
    if (!drillingDirty) return;
    drillingDirty = false;
    try { await writeJsonAtomic(DRILLING_STATE_FILE, drillingState); }
    catch (e) { console.error('Failed to persist drilling state:', e.message); drillingDirty = true; }
};

// --- PLC / S7 Configuration API ---
// GET: any authenticated user may view the current device config.
app.get('/api/config/plc', auth.requireAuth, (req, res) => {
    res.json(getModbusConfig());
});

// POST: admin-only. Validates the payload (stops TOML/config injection),
// regenerates the managed section of telegraf.conf, and lets Telegraf
// hot-reload it via `--watch-config`. No Docker socket / restart involved.
app.post('/api/config/plc', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try {
        const config = validate.validatePlcConfig(req.body);
        await saveModbusConfig(config);

        const content = fs.readFileSync(CONFIG_PATH, 'utf8');
        const startMarker = '# PLC_CONFIG_START';
        const endMarker = '# PLC_CONFIG_END';
        const startIndex = content.indexOf(startMarker);
        const endIndex = content.indexOf(endMarker);
        if (startIndex === -1 || endIndex === -1) {
            throw new Error('Telegraf configuration file is missing PLC_CONFIG markers.');
        }
        const newSection = generateTelegrafConfig(config);
        const before = content.substring(0, startIndex + startMarker.length);
        const after = content.substring(endIndex);
        fs.writeFileSync(CONFIG_PATH, `${before}\n${newSection}\n${after}`);

        res.json({ success: true, message: 'Configuration saved. Telegraf will hot-reload automatically.' });
    } catch (err) {
        const status = err.status || 500;
        if (status >= 500) console.error('Error saving PLC config:', err);
        res.status(status).json({ success: false, error: err.message });
    }
});

// Physics loop (runs on each data update). All weights are in tonnes-force
// (consistent with the PLC "Weight on Hook -Ton" tag); depths are in metres.
const updatePhysics = (rigData) => {
    const currentHookLoad = Number(rigData.drawworks?.hook_load) || 0;
    const currentBlockPos = Number(rigData.drawworks?.block_position) || 0;

    // Prefer PLC-supplied depth as source of truth. 0 is a VALID reading
    // (bit at surface), so test for finiteness, not truthiness.
    const plcBitDepth = rigData.drilling?.bit_depth;
    const plcHoleDepth = rigData.drilling?.hole_depth;
    const hasPlcBit = Number.isFinite(plcBitDepth);
    const hasPlcHole = Number.isFinite(plcHoleDepth);

    if (hasPlcBit) drillingState.bitDepth = clampDepth(plcBitDepth);
    if (hasPlcHole) drillingState.totalDepth = clampDepth(plcHoleDepth);

    // WOB = string/tare weight currently NOT carried by the hook (tonnes-force).
    const wob = Math.max(0, drillingState.stringWeight - currentHookLoad);

    // Local dead-reckoning fallback ONLY when the PLC isn't supplying bit depth.
    if (!hasPlcBit) {
        const deltaBlock = drillingState.lastBlockPosition - currentBlockPos; // +ve = moving down (ft)
        const deltaBlockMeters = deltaBlock * 0.3048;
        const newBitDepth = clampDepth(drillingState.bitDepth + deltaBlockMeters);

        const WOB_THRESHOLD = 1.0; // tonnes-force; on-bottom (drilling) threshold
        if (wob > WOB_THRESHOLD) {
            drillingState.bitDepth = newBitDepth;
            if (drillingState.bitDepth > drillingState.totalDepth) {
                drillingState.totalDepth = clampDepth(drillingState.bitDepth);
            }
        } else {
            drillingState.bitDepth = Math.min(newBitDepth, drillingState.totalDepth);
        }
    }

    drillingState.lastBlockPosition = currentBlockPos;
    markDrillingDirty();

    return {
        wob: Number(wob.toFixed(1)),
        bit_depth: Number(drillingState.bitDepth.toFixed(2)),
        hole_depth: Number(drillingState.totalDepth.toFixed(2))
    };
};

// --- APIs for Calibration (operator or admin) ---
app.post('/api/drilling/zero-wob', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        const stringWeight = validate.num(req.body.currentHookLoad, 'currentHookLoad', { min: 0, max: 5000 });
        drillingState.stringWeight = stringWeight;
        markDrillingDirty();
        maintenance.logCalibration({ type: 'Weight Indicator (Zero-WOB)', asset: 'drawworks', value: `${stringWeight} t tare`, by: req.user.username });
        res.json({ success: true, stringWeight });
    } catch (e) {
        res.status(e.status || 400).json({ error: e.message });
    }
});

app.post('/api/drilling/set-depth', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        const { bitDepth, holeDepth } = req.body;
        if (bitDepth !== undefined) drillingState.bitDepth = clampDepth(validate.num(bitDepth, 'bitDepth', { min: 0, max: MAX_WELL_DEPTH }));
        if (holeDepth !== undefined) drillingState.totalDepth = clampDepth(validate.num(holeDepth, 'holeDepth', { min: 0, max: MAX_WELL_DEPTH }));
        markDrillingDirty();
        maintenance.logCalibration({ type: 'Depth / Block Encoder (Set-Depth)', asset: 'drawworks', value: `bit ${drillingState.bitDepth?.toFixed?.(1) ?? '—'} m`, by: req.user.username });
        res.json({ success: true, state: drillingState });
    } catch (e) {
        res.status(e.status || 400).json({ error: e.message });
    }
});

app.get('/api/drilling/state', auth.requireAuth, (req, res) => {
    res.json(drillingState);
});

// --- Main Socket & Data Loop ---

// Telegraf config + device-config persistence paths.
const CONFIG_PATH = process.env.TELEGRAF_CONFIG_PATH || path.join(DATA_DIR, 'telegraf', 'telegraf.conf');
const DB_PATH = path.join(DATA_DIR, 'plc_config.json');

const getModbusConfig = () => readJsonSync(DB_PATH, { slaves: [] });
const saveModbusConfig = (config) => writeJsonAtomic(DB_PATH, config);

// Map Modbus fields to application categories
// Map S7 field names to application categories
const FIELD_MAP = {
    // DAS (Data Acquisition System)
    "Total Active Tank Volume-m^3": { meas: "fluid", field: "total_tank_volume" },
    "Active Tank Volume Gain/Loss -m^3": { meas: "fluid", field: "tank_gain_loss" },
    "Trip Tank Active Mud Volume -m^3": { meas: "fluid", field: "trip_tank" },
    "Active TripTank Volume Gain/Loss -%": { meas: "fluid", field: "trip_tank_percentage" },
    "Mud Tank 1 Volume -m^3": { meas: "fluid", field: "tank_1" },
    "Mud Tank 2 Volume -m^3": { meas: "fluid", field: "tank_2" },
    "Mud Tank 3 Volume -m^3": { meas: "fluid", field: "tank_3" },
    "Mud Tank 4 Volume -m^3": { meas: "fluid", field: "tank_4" },
    "Mud Return Flow -%": { meas: "mudpump", field: "flow_out" },
    "Mud Pump Inlet Flow-Lt/min": { meas: "mudpump", field: "flow_in" },
    "Mud Pumps Total SPM-SPM": { meas: "mudpump", field: "spm" },
    "Mud Pumps Totals Strokes-Count": { meas: "mudpump", field: "total_spm" },

    // Drilling
    "Weight on Hook -Ton": { meas: "drawworks", field: "hook_load" },
    "WOB -Ton": { meas: "drilling", field: "wob" },
    "Bit Depth-m": { meas: "drilling", field: "bit_depth" }, // meters
    "TOTAL BIT Depth-m": { meas: "drilling", field: "hole_depth" }, // meters
    "SPP-Bar": { meas: "mudpump", field: "pressure" },
    "Delta SPP-Bar": { meas: "mudpump", field: "delta_pressure" },

    // Wellhead / well-service pressures (workover)
    "Tubing Pressure-Bar": { meas: "wellhead", field: "tubing_pressure" },
    "Casing Pressure-Bar": { meas: "wellhead", field: "casing_pressure" },
    "Wellhead Pressure-Bar": { meas: "wellhead", field: "wellhead_pressure" },
    "ROP-m/h": { meas: "drilling", field: "rop" },
    "Ropes Wear-ton/km": { meas: "drawworks", field: "rope_wear" },
    "Delta Torque-daN*m": { meas: "drilling", field: "delta_torque" },
    "Drill String Speed-RPM": { meas: "drilling", field: "rpm" },
    "Drill String Torque-daN*m": { meas: "drilling", field: "torque" },
    "Operation-1=DRILLING, 2=TRIP IN, 3=TRIP OUT, 4=CASING": { meas: "drilling", field: "operation_mode" },

    // CAT (Caterpillar Engine)
    "CAT status- -1=UNKNOWN, 0=READY, 1=IN PROGRESS, 2=STATUS DONE, 3=EMERGENCY NOT OK, 4=NOT READY, 5=FAULT, 6 = RUNNING + FAULT, 7=STOP FORCED ": { meas: "cat_engine", field: "status" },
    "CAT Sourcecmd-0=NONE, 1=LOCAL, 2=REMOTE, 3=MANUAL, 4=AUTO, 5=DCC, 6=---": { meas: "cat_engine", field: "source_cmd" },
    "CAT RunHours": { meas: "cat_engine", field: "run_hours" },
    "CAT Engine speed RPM": { meas: "cat_engine", field: "rpm" },
    "CAT Engine TorquePercentage": { meas: "cat_engine", field: "load" },
    "CAT Engine TotalHoursOperation": { meas: "cat_engine", field: "total_hours" },
    "CAT Engine TotalFuelUsed": { meas: "cat_engine", field: "total_fuel" },
    "CAT Engine CoolantTemperature": { meas: "cat_engine", field: "coolant_temp" },
    "CAT Engine FuelTemperature": { meas: "cat_engine", field: "fuel_temp" },
    "CAT Engine FuelDeliveryPressure": { meas: "cat_engine", field: "fuel_pressure" },
    "CAT Engine OilPressure": { meas: "cat_engine", field: "oil_pressure" },
    "CAT Engine CoolantLevelPercentage": { meas: "cat_engine", field: "coolant_level" },
    "CAT Engine FuelRate": { meas: "cat_engine", field: "fuel_rate" },
    "CAT Engine ElectricalPotential": { meas: "cat_engine", field: "battery_voltage" },
    "CAT Engine ACCELERATION PEDAL POSITION": { meas: "cat_engine", field: "pedal_position" },

    // ACS (Automatic Control System)
    "ACS status-0=UNKNONE, 1=ON, 2=OFF, 3=DISABLE ": { meas: "acs", field: "status" },
    "ACS Actual Block Position": { meas: "drawworks", field: "block_position" },
    "ACS Crownsaver in mm": { meas: "acs", field: "crownsaver" },
    "ACS floorsaver in mm": { meas: "acs", field: "floorsaver" },
    "ACS Bottomsaver in mm": { meas: "acs", field: "bottomsaver" },
    "ACS Calibration status--1=UNKNOWN, 1=SEQ IN PROGRESS, 2=NOT CALIBRATED, 3=CALIBRATED,10=MOVE UP TO CROWN, 10=MOVE UP TO CROWN, 11=MOVE DOWN TO TAG LOW ": { meas: "acs", field: "calibration_status" },
    "ACS UPPERTAG POSITION mm": { meas: "acs", field: "upper_tag" },
    "ACS Lowertag position in mm": { meas: "acs", field: "lower_tag" },

    // HPU (Hydraulic Power Unit)
    "HPU status-0 = OFF, 1 = ON in IDLE, 2 = ON ": { meas: "hpu", field: "status" },
    "HPU RUN HOURS": { meas: "hpu", field: "run_hours" },
    "HPU Auxilary line pressure in bar": { meas: "hpu", field: "aux_pressure" },
    "HPU Discharge line pressure in bar": { meas: "hpu", field: "discharge_pressure" },
    "HPU Oprmode-0 = Unknown, 1 = Drilling 2 = RigUp": { meas: "hpu", field: "op_mode" },
    "HPU Oil temp-0=Temp. OK, 1=Temp. Low, 2=Temp. High, 3=Temp. High-High": { meas: "hpu", field: "oil_temp_status" },
    "HPU ActTemp in c": { meas: "hpu", field: "oil_temp" },
    "HPU Oil level-0=Level OK, 1=Level Low, 2=Level Low-Low, 3=Level High, 4= Level High-High": { meas: "hpu", field: "oil_level_status" },
    "HPU ActOil level in %": { meas: "hpu", field: "oil_level" },
    "HPU Pilot status-0=OFF, 1=ON, 2=FAULT": { meas: "hpu", field: "pilot_status" },
    "HPU Pilot ActLSPress bar": { meas: "hpu", field: "pilot_pressure" },
    "HPU Gate valve-1=OPEN, 0=CLOSE": { meas: "hpu", field: "gate_valve" },

    // HPU Additional Parameters requested
    "HPU Oil filter:1-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_1" },
    "HPU Oil filter:2-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_2" },
    "HPU Oil filter:3-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_3" },
    "HPU Oil filter:4-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_4" },
    "HPU Oil filter:5-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_5" },
    "HPU Oil filter:6-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_6" },
    "HPU Oil filter:7-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_7" },
    "HPU Oil filter:8-1=OK, 0=CLOGGED": { meas: "hpu", field: "oil_filter_8" },

    "HPU HydrPumpPDW status-0=NOT READY, 1=READY, 2=ENABLE": { meas: "hpu", field: "pdw_pump_status" },
    "HPU HydrPumpPDW actual flow %": { meas: "hpu", field: "pdw_pump_flow" },
    "HPU HydrPumpPDW Actual Press bar": { meas: "hpu", field: "pdw_pump_press" },

    "HPU HydrPumpHTD pump1 status-0=NOT READY, 1=READY, 2=ENABLE": { meas: "hpu", field: "htd_pump1_status" },
    "HPU HydrPumpHTD pump1 actual flow %": { meas: "hpu", field: "htd_pump1_flow" },
    "HPU HydrPumpHTD pump1 Actual Press bar": { meas: "hpu", field: "htd_pump1_press" },

    "HPU HydrPumpHTD pump2 status-0=NOT READY, 1=READY, 2=ENABLE": { meas: "hpu", field: "htd_pump2_status" },
    "HPU HydrPumpHTD pump2 actual flow %": { meas: "hpu", field: "htd_pump2_flow" },
    "HPU HydrPumpHTD pump2 Actual Press bar": { meas: "hpu", field: "htd_pump2_press" },

    // HTD (Horizontal Top Drive)
    "HTD status-0 = OFF, 1 = ON in IDLE, 2 = ON ": { meas: "htd", field: "status" },
    "HTD workmode-0 = Unknown, 1 = Drill, 2 = Spin, 3 = Torque": { meas: "htd", field: "work_mode" },
    "HTD opmode-0 = Unknown, 1 = Dolly 2 = Link": { meas: "htd", field: "op_mode" },
    "HTD Rotation Status-0 = Stand still, 1 = Rotation FWD, 2 = Rotation BWD, 3 = Neutral": { meas: "htd", field: "rotation_status" },
    "HTD rpm": { meas: "htd", field: "rpm" },
    "HTD rpm Request": { meas: "htd", field: "rpm_request" },
    "HTD rpm COMMAND": { meas: "htd", field: "rpm_command" },
    "HTD torque Request": { meas: "htd", field: "torque_request" },
    "HTD torque COMMAND": { meas: "htd", field: "torque_command" },
    "HTD TORQUE DaNm": { meas: "htd", field: "torque" },
    "HTD Lube Status-0=OFF, 1=CMD RUN, 2=RUNNING, 3 = FAULT": { meas: "htd", field: "lube_status" },
    "HTD Brake Status-0=Unknown, 1 = Closing, 2 = Closed, 3 = Opening, 4 = Open, 5 = Fault": { meas: "htd", field: "brake_status" },
    "HTD Elevator Status-0= Uncknown, 1 = Opening, 2 = Closing, 3 = Open, 4 = Close, 5 = Fault": { meas: "htd", field: "elevator_status" },
    "HTD IBOP Status-0= Uncknown, 1 = Opening, 2 = Closing, 3 = Open, 4 = Close, 5 = Fault": { meas: "htd", field: "ibop_status" },
    "HTD Link Tilt status-0 = None, 1 = Float ON, 2 = Vertical, 3 = Float OFF, 4 = Extend, 5 = Retract, 6 = Fault": { meas: "htd", field: "tilt_status" },
    "HTD Inclination angle in %": { meas: "htd", field: "inclination" },
    "HTD suspensions Status-0=none, 1= in push, 2= in pull": { meas: "htd", field: "suspension_status" },
    "HTD vertical speed": { meas: "htd", field: "vertical_speed" },
    "HTD WORKING HOURS": { meas: "htd", field: "working_hours" },
    "HTD WORKING MINUTES": { meas: "htd", field: "working_minutes" },
    "HTD Link rotation Status-0= Uncknown, 1 = Unlocking, 2 = Unlocked, 3 = Rot. Fwd, 4 = Rot. Bwd, 5 = Locking, 6 = Locked ,  7 = Fault": { meas: "htd", field: "link_rotation_status" },
    "HTD Tilt status-1= Tilting IN, 2=Tilt IN, 3=Tilting OUT, 4=Tilt OUT, 5=Half Way, 6=Stand Still": { meas: "htd", field: "tilt_status_db65" },
    "HTD Inclination status-1= Inclination IN in progress, 2=Inclination IN, 3=Inclination OUT in progress, 4=Inclinated OUT, 5=Half Way, 6=Stand Still, 7=Tilted In, 8=Tilted Out": { meas: "htd", field: "inclination_status" },
    "HTD GEAR status--2=UNKNOWN, -1=FAULT, 1=GEAR 1, 2=GEAR 2, 3=GEAR 3, 4=GEAR 4. 5= GEAR 1 REGENERATIVE, 6= GEAR 2 REGENERATIVE, 7=GEAR 3 REGENERATIVE, 8= GEAR 4 REGENERATIVE": { meas: "htd", field: "gear_status" },

    // CWK (Catwalk)
    "CWK status-0= NOT IN PARK POSITION, 1=PARK POSITION ": { meas: "cwk", field: "status" },
    "CWK Indexer DX-1=UP, 2=DOWN, 3=FAULT": { meas: "cwk", field: "indexer_dx" },
    "CWK Indexer SX-1=UP, 2=DOWN, 3=FAULT": { meas: "cwk", field: "indexer_sx" },
    "CWK Kickers DX-1=EXTEND, 2=RETRACT, 3=FAULT": { meas: "cwk", field: "kickers_dx" },
    "CWK Kickers SX-1=EXTEND, 2=RETRACT, 3=FAULT": { meas: "cwk", field: "kickers_sx" },
    "CWK Skate-1=IDLE, 2=PARKING POSITION, 3=FWD CMD, 4=BWD CMD, 5=FAULT": { meas: "cwk", field: "skate_status" },
    "CWK Slide-1=IDLE, 2=PARKING POSITION, 3=FWD CMD, 4=BWD CMD, 5=FAULT": { meas: "cwk", field: "slide_status" },
    "CWK Carrier-1= STOP, 2=PARKING POSITION, 3= WORK POSITION, 4= LIFTING, 5=LOWERING, 6=FAULT": { meas: "cwk", field: "carrier_status" },
    "CWK Clamp-0=NONE, 1=OPENING, 2=CLOSING, 3=IS OPEN, 4=IS CLOSE, 5=FAULT": { meas: "cwk", field: "clamp_status" },
    "CWK Clamp close pressure": { meas: "cwk", field: "clamp_pressure" },
    "CWK Clamp close pressure OK": { meas: "cwk", field: "clamp_pressure_ok" },
    "CWK Clamp Actcloseforce": { meas: "cwk", field: "clamp_force" },
    "CWK Clamp Actcloeforce ok": { meas: "cwk", field: "clamp_force_ok" },
    "CWK sourcecmd-0 = UNKNOWN, 1 = DCC, 2 = RADIOCONTROL": { meas: "cwk", field: "source_cmd" },

    // PCT (Power Casing Tong)
    "PCT Operation mode-0 = UNKNOWN, 1 = NORMAL, 2 = MANUAL": { meas: "pct", field: "op_mode" },
    "PCT STATUS-0 = OFF, 1 = ON in IDLE, 2 = ON": { meas: "pct", field: "status" },
    "PCT DOLLY UP DOWN-0=NO CMD ACTIVE, 1=MOVE UP, 2=MOVE DOWN": { meas: "pct", field: "dolly_direction" },
    "PCT DollyWorkPark-0=NONE, 1=OUT PARK. POS, 2=MOVE WORK, 3=MOVE PARK, 4=IN PARK, 5=FAULT, 6=in work": { meas: "pct", field: "dolly_status" },
    "PCT Spinner Rotation-0=NO CMD ACTIVE, 1=FULLY UP, 2=FULLY DOWN, 3=MAKE-UP, 4= BREAK-OUT. 10=SPINNER NOT MOUNTED": { meas: "pct", field: "spinner_rotation_status" },
    "PCT SPINNER GRIPPER-0=NONE, 1=OPENING, 2=CLOSING, 3=OPEN, 4=CLOSE, 5=FAULT, 10=SPINNER NOT MOUNTED": { meas: "pct", field: "spinner_gripper_status" },
    "PCT SPINNER FLOATING-0=OFF, 1=ON, 10=SPINNER NOT MOUNTED": { meas: "pct", field: "spinner_floating" },
    "PCT SpinnerActMakeUpTorque-daN*m": { meas: "pct", field: "spinner_makeup_torque" },
    "PCT SpinnerActBOutTorque-daN*m": { meas: "pct", field: "spinner_breakout_torque" },
    "PCT ClampUp-0=NONE, 1=OPENING, 2=CLOSING, 3=IS OPEN, 4=IS CLOSE, 5=FAULT": { meas: "pct", field: "clamp_up_status" },
    "PCT ROTATION ActMakeUpPress": { meas: "pct", field: "rotation_makeup_pressure" },
    "PCT ROTATION ActBOutPress": { meas: "pct", field: "rotation_breakout_pressure" },
    "PCT Clamp up close pressure": { meas: "pct", field: "clamp_up_pressure" },
    "PCT Clamp up close pressure ok": { meas: "pct", field: "clamp_up_pressure_ok" },
    "PCT Clamp up ActCloseForce": { meas: "pct", field: "clamp_up_force" },
    "PCT Clamp up ActCloseForce ok": { meas: "pct", field: "clamp_up_force_ok" },
    "PCT Clamp up open pressure ok": { meas: "pct", field: "clamp_up_open_ok" },
    "PCT Clamplow-0=NONE, 1=OPENING, 2=CLOSING, 3=IS OPEN, 4=IS CLOSE, 5=FAULT": { meas: "pct", field: "clamp_low_status" },
    "PCT Clamp low close pressure": { meas: "pct", field: "clamp_low_pressure" },
    "PCT Clamp low close pressure ok": { meas: "pct", field: "clamp_low_pressure_ok" },
    "PCT Clamp low ActCloseForce": { meas: "pct", field: "clamp_low_force" },
    "PCT Clamp low ActCloseForce ok": { meas: "pct", field: "clamp_low_force_ok" },
    "PCT Clamp low open pressure ok": { meas: "pct", field: "clamp_low_open_ok" },
    "PCT Clamp Roatation-0=NONE, 1=NOT ALLIGNED, 2=ALLIGNED, 3=MAKE-UP, 4=BREAK-OUT, 5=FAULT": { meas: "pct", field: "clamp_rotation_status" },
    "PCT Makeup Torque-daN*m": { meas: "pct", field: "makeup_torque" },
    "PCT ClampLastMakeUpTorque-daN*m": { meas: "pct", field: "last_makeup_torque" },
    "PCT Sequence-0=OFF, 1=MAKE-UP, 2=BREAK-OUT, 3=RESET, 4=FAULT": { meas: "pct", field: "sequence" },
};

// Measurements polled for the live view (S7comm writes under "AHWR";
// app-level measurements support mock/Modbus sources). Shared with /api/history.
const LIVE_MEASUREMENTS = ['drawworks', 'engine', 'mudpump', 'wellcontrol', 'wellhead', 'modbus', 'AHWR', 'fluid', 'drilling', 'hpu', 'htd', 'acs', 'cat_engine', 'cwk', 'pct'];

let lastDataAt = 0; // epoch ms of the last tick that returned sensor data

const queryData = async () => {
    const measurementFilter = LIVE_MEASUREMENTS.map(m => `r["_measurement"] == "${m}"`).join(' or ');
    const fluxQuery = `
    from(bucket: "${INFLUX_BUCKET}")
      |> range(start: -10s)
      |> filter(fn: (r) => ${measurementFilter})
      |> last()
  `;

    try {
        const data = {};
        await new Promise((resolve, reject) => {
            queryApi.queryRows(fluxQuery, {
                next(row, tableMeta) {
                    const o = tableMeta.toObject(row);
                    let meas = o._measurement;
                    let f = o._field;
                    if (FIELD_MAP[f]) { meas = FIELD_MAP[f].meas; f = FIELD_MAP[f].field; }
                    if (!data[meas]) data[meas] = {};
                    data[meas][f] = o._value;
                },
                error(error) { reject(error); },
                complete() { resolve(); },
            });
        });

        const hasSensorData = !!(data.drawworks || data.engine || data.mudpump || data.drilling || data.AHWR);
        const now = Date.now();
        if (hasSensorData) lastDataAt = now;
        const stale = (now - lastDataAt) > FRESH_MS;

        if (hasSensorData) {
            const physicsData = updatePhysics(data);
            const plcWob = data.drilling ? data.drilling.wob : undefined;
            // Depth always comes from the clamped physics state (which itself
            // prefers PLC depth). WOB prefers the real PLC measurement when present.
            data.drilling = {
                ...(data.drilling || {}),            // keep PLC rop, rpm, torque, operation_mode, ...
                bit_depth: physicsData.bit_depth,
                hole_depth: physicsData.hole_depth,
                wob: Number.isFinite(plcWob) ? plcWob : physicsData.wob
            };
        } else {
            // No live feed: do NOT fabricate zeros. Show last-known depth and
            // let _meta.stale tell the UI the values are not live.
            data.drilling = {
                ...(data.drilling || {}),
                bit_depth: Number(drillingState.bitDepth.toFixed(2)),
                hole_depth: Number(drillingState.totalDepth.toFixed(2))
            };
        }

        // Well control / BOP: present ONLY when a real source exists. Never
        // coalesce safety-critical ram/pressure signals to a benign false/0 state.
        const wc = data.wellcontrol;
        if (wc && Object.keys(wc).length > 0) {
            data.well_control = {
                available: true,
                annular_pressure: wc.annular_pressure ?? null,
                manifold_pressure: wc.manifold_pressure ?? null,
                accumulator_pressure: wc.accumulator_pressure ?? null,
                annular_open: wc.annular_open ?? null,
                annular_close: wc.annular_close ?? null,
                pipe_ram_open: wc.pipe_ram_open ?? null,
                pipe_ram_close: wc.pipe_ram_close ?? null,
                blind_ram_open: wc.blind_ram_open ?? null,
                blind_ram_close: wc.blind_ram_close ?? null,
                shear_ram_open: wc.shear_ram_open ?? null
            };
        } else {
            data.well_control = { available: false };
        }
        delete data.wellcontrol;

        data._meta = {
            ts: new Date(now).toISOString(),
            source: hasSensorData ? DATA_SOURCE : 'none',
            stale,
            age_ms: lastDataAt ? (now - lastDataAt) : null,
            connected: hasSensorData
        };

        // --- Workover layer: activity/NPT, torque-turn, alarms ---
        if (hasSensorData) {
            data._activity = workover.updateActivity(data, now);
            const tt = workover.updateTorqueTurn(data, now);
            if (tt.connectionMade) io.emit('connection_made', tt.connectionMade);
            data._torqueturn = workover.getTorqueTurnLive();
            const al = alarms.evaluate(data, now);
            data._alarms = al.counts;
            if (al.changed) io.emit('alarms', al);
            maintenance.updateHours(data, now);
        } else {
            data._activity = workover.getCurrent();
            data._alarms = alarms.snapshot().counts;
        }

        latestRigData = data;
        io.emit('rig_data', data);
    } catch (err) {
        console.error('Error querying InfluxDB:', err.message);
    }
};

// Global cache for the latest data
let latestRigData = {};

// API: Get Latest Rig Data
app.get('/api/rig/latest', auth.requireAuth, (req, res) => {
    res.json(latestRigData);
});

// Self-scheduling poll loop with an in-flight guard so a slow Influx query
// can never let invocations overlap and stack up on shared mutable state.
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS || 1000);
let pollTimer = null;
let pollStopped = false;
const scheduleNextPoll = () => {
    if (pollStopped) return;
    pollTimer = setTimeout(async () => {
        try { await queryData(); } finally { scheduleNextPoll(); }
    }, POLL_INTERVAL_MS);
};

// API: Get Historical Data
// API: Get Historical Data
app.get('/api/history', auth.requireAuth, async (req, res) => {
    const { range, start, stop } = req.query;

    // Validate time inputs before they are interpolated into the Flux query
    // (prevents Flux injection). Allow relative durations and RFC3339 instants only.
    if (start !== undefined || stop !== undefined) {
        if (!validate.isFluxInstant(start) || !validate.isFluxInstant(stop)) {
            return res.status(400).json({ error: 'Invalid start/stop (use RFC3339 timestamps)' });
        }
    } else if (range !== undefined && !validate.isFluxRange(range)) {
        return res.status(400).json({ error: 'Invalid range (use a relative duration like -1h, -7d)' });
    }

    // Build range filter
    let rangeFilter = '';
    let windowPeriod = '5s';

    if (start && stop) {
        rangeFilter = `|> range(start: ${start}, stop: ${stop})`;

        // Calculate window dynamically based on duration
        const durationMs = new Date(stop).getTime() - new Date(start).getTime();
        const hours = durationMs / (1000 * 60 * 60);

        if (hours > 24 * 30 * 6) windowPeriod = '24h';
        else if (hours > 24 * 30) windowPeriod = '6h';
        else if (hours > 24 * 7) windowPeriod = '1h';
        else if (hours > 24) windowPeriod = '15m';
        else if (hours > 1) windowPeriod = '1m';
    } else {
        rangeFilter = `|> range(start: ${range || '-30s'})`;

        if (range?.includes('mo')) windowPeriod = '24h';
        else if (range?.includes('30d')) windowPeriod = '6h';
        else if (range?.includes('7d')) windowPeriod = '1h';
        else if (range?.includes('24h')) windowPeriod = '15m';
        else if (range?.includes('12h')) windowPeriod = '5m';
        else if (range?.includes('1h')) windowPeriod = '30s';
        else if (range?.includes('15m')) windowPeriod = '5s';
        else if (range?.includes('10m')) windowPeriod = '5s';
        else if (range?.includes('5m')) windowPeriod = '2s';
        else if (range?.includes('1m')) windowPeriod = '1s';
    }

    // Determine if we need date in the time label
    const needsDate = range?.includes('24h') || range?.includes('7d') || range?.includes('30d') || range?.includes('mo') || (start && stop);

    // Same measurement set as the live view (crucially includes "AHWR", under
    // which all S7comm/PLC fields are written) so equipment history isn't empty.
    const measurementFilter = LIVE_MEASUREMENTS.map(m => `r["_measurement"] == "${m}"`).join(' or ');

    const fluxQuery = `
    import "types"
    from(bucket: "${INFLUX_BUCKET}")
      ${rangeFilter}
      |> filter(fn: (r) => ${measurementFilter})
      |> filter(fn: (r) => types.isType(v: r._value, type: "float") or types.isType(v: r._value, type: "int") or types.isType(v: r._value, type: "uint"))
      |> aggregateWindow(every: ${windowPeriod}, fn: last, createEmpty: false)
      |> yield(name: "last")
  `;

    try {
        const history = [];
        await new Promise((resolve, reject) => {
            queryApi.queryRows(fluxQuery, {
                next(row, tableMeta) {
                    const o = tableMeta.toObject(row);
                    let meas = o._measurement;
                    let f = o._field;

                    if (FIELD_MAP[f]) {
                        meas = FIELD_MAP[f].meas;
                        f = FIELD_MAP[f].field;
                    }

                    history.push({
                        time: o._time,
                        measurement: meas,
                        field: f,
                        value: o._value
                    });
                },
                error(error) {
                    console.error(error);
                    reject(error);
                },
                complete() {
                    resolve();
                }
            });
        });

        // Group by timestamp for the chart
        const grouped = {};
        history.forEach(pt => {
            const t = new Date(pt.time).getTime(); // Use numeric timestamp as key
            if (!grouped[t]) {
                const d = new Date(pt.time);
                let label;
                if (needsDate) {
                    label = d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
                } else {
                    label = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
                }
                grouped[t] = { name: label, timestamp: t };
            }
            grouped[t][`${pt.measurement}.${pt.field}`] = pt.value;
        });

        // Sort by numeric timestamp (not string)
        res.json(Object.values(grouped).sort((a, b) => a.timestamp - b.timestamp));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Modbus Configuration API

// Helper: Generate Telegraf TOML
const generateTelegrafConfig = (config) => {
    let toml = '';

    // Slaves are now treated as "Devices" which can be Modbus or S7comm
    config.slaves.forEach(slave => {
        const protocol = slave.protocol || 'modbus';

        if (protocol === 'modbus') {
            toml += `[[inputs.modbus]]\n`;
            toml += `  name = "${slave.name}"\n`;
            toml += `  slave_id = ${slave.slaveId || 1}\n`;
            toml += `  timeout = "1s"\n`;
            toml += `  controller = "tcp://${slave.ip}:${slave.port || 502}"\n`;
            toml += `  configuration_type = "register"\n`;
            toml += `  optimization = "none"\n\n`;

            // Discrete Inputs
            const discretes = slave.registers.filter(r => r.type === 'discrete_input' && r.address !== null && r.address !== undefined && r.address !== "");
            if (discretes.length > 0) {
                toml += `  discrete_inputs = [\n`;
                discretes.forEach(r => {
                    toml += `    { name = "${r.name}", address = [${r.address}] },\n`;
                });
                toml += `  ]\n`;
            }

            // Coils
            const coils = slave.registers.filter(r => r.type === 'coil' && r.address !== null && r.address !== undefined && r.address !== "");
            if (coils.length > 0) {
                toml += `  coils = [\n`;
                coils.forEach(r => {
                    toml += `    { name = "${r.name}", address = [${r.address}] },\n`;
                });
                toml += `  ]\n`;
            }

            // Holding Registers
            const holding = slave.registers.filter(r => (r.type === 'holding_register' || r.type === 'input_register') && r.address !== null && r.address !== undefined && r.address !== "");
            if (holding.length > 0) {
                toml += `  holding_registers = [\n`;
                holding.forEach(r => {
                    let scaleVal = r.scale !== undefined && r.scale !== null && r.scale !== "" ? Number(r.scale) : 1.0;
                    let scaleStr = Number.isInteger(scaleVal) ? scaleVal.toFixed(1) : String(scaleVal);
                    const byteOrder = (r.dataType === 'INT16' || r.dataType === 'UINT16') ? 'AB' : 'ABCD';
                    toml += `    { name = "${r.name}", byte_order = "${byteOrder}", data_type = "${r.dataType}", scale = ${scaleStr}, address = [${r.address}] },\n`;
                });
                toml += `  ]\n`;
            }
        } else if (protocol === 's7comm') {
            toml += `[[inputs.s7comm]]\n`;
            toml += `  server = "${slave.ip}:${slave.port || 102}"\n`;
            toml += `  rack = ${slave.rack || 0}\n`;
            toml += `  slot = ${slave.slot || 0}\n`;

            // S7comm uses metrics which group fields together
            if (slave.metrics && slave.metrics.length > 0) {
                slave.metrics.forEach(metric => {
                    toml += `  [[inputs.s7comm.metric]]\n`;
                    toml += `    name = "${metric.name || 'AHWR'}"\n`;
                    toml += `    fields = [\n`;
                    metric.fields.forEach(f => {
                        toml += `      {name="${f.name}", address="${f.address}"},\n`;
                    });
                    toml += `    ]\n`;
                    if (metric.tags) {
                        toml += `    [inputs.s7comm.metric.tags]\n`;
                        Object.entries(metric.tags).forEach(([k, v]) => {
                            toml += `      ${k} = "${v}"\n`;
                        });
                    }
                });
            }
        }
        toml += `\n`;
    });
    return toml;
};

// Redundant endpoints removed (consolidated to /api/config/plc)

// --- User Management ---
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let users = [];

const saveUsers = () => writeJsonAtomic(USERS_FILE, users);

// Load users; migrate any legacy plaintext passwords to bcrypt hashes; seed the
// initial admin from env (ADMIN_USERNAME / ADMIN_PASSWORD) when no store exists.
const loadUsers = () => {
    const saved = readJsonSync(USERS_FILE, null);
    if (Array.isArray(saved) && saved.length) {
        let migrated = false;
        users = saved.map(u => {
            if (u.password && !auth.isHashed(u.password)) {
                migrated = true;
                return { ...u, password: auth.hashPassword(u.password) };
            }
            return u;
        });
        if (migrated) { saveUsers(); console.log('Migrated legacy plaintext passwords to bcrypt hashes.'); }
        return;
    }
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD;
    if (!adminPass) {
        console.error('FATAL: no users.json present and ADMIN_PASSWORD env is not set; cannot seed initial admin.');
        process.exit(1);
    }
    users = [{ id: 1, username: adminUser, password: auth.hashPassword(adminPass), role: 'admin', status: 'active' }];
    saveUsers();
    console.log(`Seeded initial admin user "${adminUser}" from environment.`);
};

loadUsers();

const sanitizeUser = ({ password, ...u }) => u;
const activeAdminCount = () => users.filter(u => u.role === 'admin' && u.status !== 'inactive').length;

// Just-in-time provisioning for a directory (LDAP/AD) user. Mirrors the AD
// account into the local store so roles/status/audit work. An admin can lock a
// role locally (roleLocked) or deactivate the account to block sign-in.
const upsertLdapUser = async (dir) => {
    let u = users.find(x => x.username.toLowerCase() === dir.username.toLowerCase());
    if (u) {
        if (u.status === 'inactive') return null; // locally disabled -> blocked
        if (!u.roleLocked) u.role = dir.role;      // refresh role from directory groups
        u.displayName = dir.displayName;
        u.source = 'ldap';
    } else {
        u = { id: Date.now(), username: dir.username, displayName: dir.displayName, role: dir.role, status: 'active', source: 'ldap' };
        users.push(u);
    }
    await saveUsers();
    return u;
};

// API: List Users (admin)
app.get('/api/users', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
    res.json(users.map(sanitizeUser));
});

// API: Add User (admin)
app.post('/api/users', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    const { username, password, role } = req.body;
    if (!validate.USERNAME_RE.test(String(username || ''))) {
        return res.status(400).json({ error: 'Username must be 3-40 chars [A-Za-z0-9_.-]' });
    }
    if (!password || String(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    const newRole = role || 'operator';
    if (!validate.ROLES.includes(newRole)) return res.status(400).json({ error: 'Invalid role' });
    if (users.find(u => u.username === username)) {
        return res.status(400).json({ error: 'Username already exists' });
    }
    const newUser = { id: Date.now(), username, password: auth.hashPassword(password), role: newRole, status: 'active' };
    users.push(newUser);
    await saveUsers();
    res.json({ success: true, user: sanitizeUser(newUser) });
});

// API: Update User (admin)
app.put('/api/users/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const { username, password, role, status } = req.body;
    const index = users.findIndex(u => u.id == id);
    if (index === -1) return res.status(404).json({ error: 'User not found' });

    if (username !== undefined) {
        if (!validate.USERNAME_RE.test(String(username))) return res.status(400).json({ error: 'Invalid username' });
        users[index].username = username;
    }
    if (password !== undefined && password !== '') {
        if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
        users[index].password = auth.hashPassword(password);
    }
    // Guard: never let the last active admin be demoted or deactivated.
    const wouldDropAdmin = (role && role !== 'admin') || (status === 'inactive');
    if (users[index].role === 'admin' && wouldDropAdmin && activeAdminCount() <= 1) {
        return res.status(400).json({ error: 'Cannot demote or deactivate the last active admin' });
    }
    if (role !== undefined) {
        if (!validate.ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role' });
        users[index].role = role;
    }
    if (status !== undefined) users[index].status = status;
    await saveUsers();
    res.json({ success: true, user: sanitizeUser(users[index]) });
});

// API: Delete User (admin)
app.delete('/api/users/:id', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    const { id } = req.params;
    const target = users.find(u => u.id == id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.role === 'admin' && activeAdminCount() <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last active admin' });
    }
    users = users.filter(u => u.id != id);
    await saveUsers();
    res.json({ success: true });
});

// --- Dashboard Persistence ---
const DASHBOARD_FULL_CONFIG_FILE = path.join(DATA_DIR, 'dashboard_layout.json');
const DASHBOARD_AUDIT_FILE = path.join(DATA_DIR, 'dashboard_layout_audit.json');
const DASHBOARD_AUDIT_LIMIT = 500;

const EDR_STRIP_LIMITS = { min: 1, max: 6 };
const EDR_PEN_LIMITS = { min: 1, max: 4 };
const EDR_COLOR_RE = /^#[0-9a-f]{6}$/i;
const EDR_METRICS = edrCatalog.categories.flatMap(category =>
    category.fields.map(field => ({
        ...field,
        value: `${category.id}.${field.id}`,
        category: category.id,
        categoryLabel: category.label
    }))
);
const EDR_METRIC_BY_VALUE = new Map(EDR_METRICS.map(metric => [metric.value, metric]));
const DEFAULT_EDR_CONFIG = edrCatalog.defaultLayout;

// Default Layout (Fallback)
const DEFAULT_DASHBOARD_CONFIG = {
    gauges: [
        { id: 'd1', label: 'WOH', dataKey: 'hook_load', min: 0, max: 100, unit: 'ton', color: '#3182ce', gridWidth: 3, size: 160, majorTicks: 10, minorTicks: 4 },
        { id: 'd2', label: 'WOB', dataKey: 'wob', min: 0, max: 100, unit: 'kips', color: '#e53e3e', gridWidth: 3, size: 160, majorTicks: 10, minorTicks: 4 },
        { id: 'd6', label: 'HTD RPM', dataKey: 'htd_rpm', min: 0, max: 200, unit: 'RPM', color: '#4ade80', gridWidth: 3, size: 160 },
        { id: 'd7', label: 'HTD TORQUE', dataKey: 'htd_torque', min: 0, max: 1000, unit: 'Nm', color: '#fbbf24', gridWidth: 3, size: 160 },
    ],
    sideStats: [
        { key: 'pump_pressure', label: 'SPP', unit: 'Bar', min: 0, max: 500 },
        { key: 'torque', label: 'Drill String Torque', unit: 'daN·m', min: 0, max: 20000 }
    ],
    _meta: { version: 1, updatedAt: null, updatedBy: 'system', updatedByRole: 'system' },
    edr: DEFAULT_EDR_CONFIG,
    units: { wob: 'tonnes', depth: 'm' },
    wellInfo: { well: 'WELL-001', rig: 'RIG-ALPHA' },
    bottomStats: [
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
    ]
};

const auditId = () => `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const appendDashboardAudit = async (record) => {
    const audit = readJsonSync(DASHBOARD_AUDIT_FILE, []);
    const rows = Array.isArray(audit) ? audit : [];
    rows.push(record);
    await writeJsonAtomic(DASHBOARD_AUDIT_FILE, rows.slice(-DASHBOARD_AUDIT_LIMIT));
};

const clampInteger = (value, fallback, min, max) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

const numericOrFallback = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const getDefaultEdrPen = (stripIndex, penIndex) => {
    const strip = DEFAULT_EDR_CONFIG.strips[stripIndex % DEFAULT_EDR_CONFIG.strips.length];
    return strip.pens[penIndex % strip.pens.length] || DEFAULT_EDR_CONFIG.strips[0].pens[0];
};

const sanitizeEdrPen = (pen, stripIndex, penIndex) => {
    const fallback = getDefaultEdrPen(stripIndex, penIndex);
    const source = pen && typeof pen === 'object' ? pen : {};
    const metric = EDR_METRIC_BY_VALUE.has(source.metric) ? source.metric : fallback.metric;
    const meta = EDR_METRIC_BY_VALUE.get(metric);
    const min = numericOrFallback(source.min, fallback.min ?? meta?.defaultMin ?? 0);
    let max = numericOrFallback(source.max, fallback.max ?? meta?.defaultMax ?? 1);
    if (max <= min) max = min + 1;

    return {
        id: typeof source.id === 'string' && source.id.trim() ? source.id.trim().slice(0, 40) : `s${stripIndex + 1}p${penIndex + 1}`,
        metric,
        min,
        max,
        color: EDR_COLOR_RE.test(source.color || '') ? source.color : fallback.color
    };
};

const normalizeLegacyEdrStrips = (config) => {
    if (Array.isArray(config?.strips)) return config.strips;
    if (!Array.isArray(config?.tracks)) return [];
    return config.tracks.map((track, stripIndex) => ({
        id: `strip-${stripIndex + 1}`,
        title: `Strip ${stripIndex + 1}`,
        pens: [track.left, track.right].filter(Boolean)
    }));
};

const sanitizeEdrPreset = (preset, index) => {
    const source = preset && typeof preset === 'object' ? preset : {};
    const configSource = source.config && typeof source.config === 'object' ? source.config : source;
    return {
        id: typeof source.id === 'string' && source.id.trim() ? source.id.trim().slice(0, 48) : `preset-${index + 1}`,
        name: typeof source.name === 'string' && source.name.trim() ? source.name.trim().slice(0, 80) : `Preset ${index + 1}`,
        createdAt: typeof source.createdAt === 'string' ? source.createdAt : new Date().toISOString(),
        createdBy: typeof source.createdBy === 'string' ? source.createdBy.slice(0, 80) : 'unknown',
        config: sanitizeEdrConfig(configSource, { includePresets: false })
    };
};

const sanitizeEdrConfig = (config = {}, options = { includePresets: true }) => {
    const source = config && typeof config === 'object' ? config : {};
    const sourceStrips = normalizeLegacyEdrStrips(source);
    const stripCount = clampInteger(
        source.stripCount ?? sourceStrips.length,
        DEFAULT_EDR_CONFIG.stripCount,
        EDR_STRIP_LIMITS.min,
        EDR_STRIP_LIMITS.max
    );
    const pensPerStrip = clampInteger(
        source.pensPerStrip,
        DEFAULT_EDR_CONFIG.pensPerStrip,
        EDR_PEN_LIMITS.min,
        EDR_PEN_LIMITS.max
    );

    const result = {
        stripCount,
        pensPerStrip,
        strips: Array.from({ length: stripCount }, (_, stripIndex) => {
            const sourceStrip = sourceStrips[stripIndex] || DEFAULT_EDR_CONFIG.strips[stripIndex % DEFAULT_EDR_CONFIG.strips.length];
            return {
                id: typeof sourceStrip.id === 'string' && sourceStrip.id.trim() ? sourceStrip.id.trim().slice(0, 40) : `strip-${stripIndex + 1}`,
                title: typeof sourceStrip.title === 'string' && sourceStrip.title.trim() ? sourceStrip.title.trim().slice(0, 60) : `Strip ${stripIndex + 1}`,
                pens: Array.from({ length: pensPerStrip }, (_, penIndex) => (
                    sanitizeEdrPen(sourceStrip.pens?.[penIndex], stripIndex, penIndex)
                ))
            };
        })
    };
    if (options.includePresets !== false) {
        result.presets = Array.isArray(source.presets)
            ? source.presets.slice(0, 20).map((preset, index) => sanitizeEdrPreset(preset, index))
            : [];
    }
    return result;
};

const getDashboardConfig = () => {
    // Clone the default so we never mutate the shared constant by reference.
    const defaultConfig = JSON.parse(JSON.stringify(DEFAULT_DASHBOARD_CONFIG));
    let config = readJsonSync(DASHBOARD_FULL_CONFIG_FILE, null) || defaultConfig;
    config = { ...defaultConfig, ...config };

    // Migration: Enforce allowed gauges (WOH, WOB, HTD RPM, HTD TORQUE, PCT TORQUE) and max 5
    if (config.gauges) {
        const allowedKeys = ['hook_load', 'wob', 'htd_rpm', 'htd_torque', 'pct_torque'];
        config.gauges = config.gauges.filter(g => allowedKeys.includes(g.dataKey)).slice(0, 5);

        // If empty, restore defaults
        if (config.gauges.length === 0) {
            config.gauges = DEFAULT_DASHBOARD_CONFIG.gauges;
        }
    }

    // Migration: Ensure units are 'm' for depth
    if (config.units && config.units.depth === 'ft') {
        config.units.depth = 'm';
    }

    const version = Number(config._meta?.version);
    config._meta = {
        version: Number.isFinite(version) && version > 0 ? version : 1,
        updatedAt: config._meta?.updatedAt || null,
        updatedBy: config._meta?.updatedBy || 'system',
        updatedByRole: config._meta?.updatedByRole || 'system'
    };
    config.edr = sanitizeEdrConfig(config.edr);

    return config;
};

const saveDashboardConfig = (config) => writeJsonAtomic(DASHBOARD_FULL_CONFIG_FILE, config);

// API: Get Dashboard Layout (any authenticated user)
app.get('/api/dashboard/layout', auth.requireAuth, (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.json(getDashboardConfig());
});

// API: Save Dashboard Layout (admin)
app.post('/api/dashboard/layout', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    const incomingConfig = { ...(req.body || {}) };
    delete incomingConfig._meta;
    const existingConfig = getDashboardConfig();
    const changedSections = Object.keys(incomingConfig);

    // Migration: Sanitize incoming gauges (Allow WOH, WOB, HTD RPM, HTD TORQUE, PCT TORQUE) and limit to 5
    if (incomingConfig.gauges) {
        const allowedKeys = ['hook_load', 'wob', 'htd_rpm', 'htd_torque', 'pct_torque'];
        incomingConfig.gauges = incomingConfig.gauges.filter(g => allowedKeys.includes(g.dataKey)).slice(0, 5);
    }

    if (incomingConfig.edr) {
        incomingConfig.edr = sanitizeEdrConfig(incomingConfig.edr);
    }

    // Merge existing config with incoming updates
    const mergedConfig = {
        ...existingConfig,
        ...incomingConfig
    };
    mergedConfig.edr = sanitizeEdrConfig(mergedConfig.edr);
    mergedConfig._meta = {
        version: (Number(existingConfig._meta?.version) || 1) + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: req.user?.username || 'unknown',
        updatedByRole: req.user?.role || 'unknown'
    };

    await saveDashboardConfig(mergedConfig);
    await appendDashboardAudit({
        id: auditId(),
        ts: mergedConfig._meta.updatedAt,
        version: mergedConfig._meta.version,
        by: mergedConfig._meta.updatedBy,
        role: mergedConfig._meta.updatedByRole,
        sections: changedSections,
        summary: {
            edr: incomingConfig.edr ? {
                stripCount: mergedConfig.edr.stripCount,
                pensPerStrip: mergedConfig.edr.pensPerStrip,
                metrics: mergedConfig.edr.strips.flatMap(strip => strip.pens.map(pen => pen.metric))
            } : undefined,
            wellInfo: incomingConfig.wellInfo || undefined
        }
    });
    // Real-time broadcast
    io.emit('dashboard_layout_update', mergedConfig);
    res.json({ success: true, config: mergedConfig });
});

// API: Dashboard layout audit (admin)
app.get('/api/dashboard/audit', auth.requireAuth, auth.requireRole('admin'), (req, res) => {
    const section = typeof req.query.section === 'string' ? req.query.section : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const audit = readJsonSync(DASHBOARD_AUDIT_FILE, []);
    const rows = Array.isArray(audit) ? audit : [];
    const filtered = section ? rows.filter(row => row.sections?.includes(section)) : rows;
    res.json({ events: filtered.slice(-limit).reverse() });
});

// --- Central / Fleet Baseline ---
const CENTRAL_REGISTRY_FILE = path.join(DATA_DIR, 'central_rig_registry.json');
const DEFAULT_CENTRAL_REGISTRY = {
    roleMappings: {
        admin: ['DGC', 'Corporate Digital', 'Rig Superintendent'],
        operator: ['Rig Operator', 'Driller', 'Toolpusher'],
        viewer: ['Asset Team', 'Planning', 'Maintenance']
    },
    rigs: [
        {
            id: 'local',
            source: 'local',
            rigName: 'RIG-ALPHA',
            wellName: 'WELL-001',
            assetType: 'Workover Rig',
            basin: 'Local',
            location: 'Current rig',
            connectionMode: 'site-gateway',
            offlineBufferCount: 0,
            notes: 'Live rig served by this gateway'
        }
    ]
};

const sanitizeText = (value, fallback = '', max = 120) => (
    typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback
);

const sanitizeCentralRig = (rig, index) => {
    const source = rig && typeof rig === 'object' ? rig : {};
    return {
        id: sanitizeText(source.id, `rig-${index + 1}`, 60).replace(/[^A-Za-z0-9_-]/g, '-'),
        source: source.source === 'local' ? 'local' : 'remote',
        rigName: sanitizeText(source.rigName, `RIG-${index + 1}`, 80),
        wellName: sanitizeText(source.wellName, '', 80),
        assetType: sanitizeText(source.assetType, 'Workover Rig', 80),
        basin: sanitizeText(source.basin, '', 80),
        location: sanitizeText(source.location, '', 120),
        connectionMode: sanitizeText(source.connectionMode, 'site-gateway', 80),
        status: ['online', 'stale', 'offline', 'planned'].includes(source.status) ? source.status : 'planned',
        syncStatus: ['healthy', 'stale', 'buffering', 'offline', 'not-configured'].includes(source.syncStatus) ? source.syncStatus : 'not-configured',
        lastSyncAt: typeof source.lastSyncAt === 'string' ? source.lastSyncAt : null,
        offlineBufferCount: Math.max(0, Number(source.offlineBufferCount) || 0),
        syncLagSec: Math.max(0, Number(source.syncLagSec) || 0),
        notes: sanitizeText(source.notes, '', 240)
    };
};

const sanitizeRoleMappings = (roleMappings = {}) => {
    const roles = ['admin', 'operator', 'viewer'];
    return Object.fromEntries(roles.map(role => {
        const values = Array.isArray(roleMappings[role]) ? roleMappings[role] : DEFAULT_CENTRAL_REGISTRY.roleMappings[role];
        return [role, values.slice(0, 12).map(value => sanitizeText(value, '', 80)).filter(Boolean)];
    }));
};

const getCentralRegistry = () => {
    const stored = readJsonSync(CENTRAL_REGISTRY_FILE, null);
    const source = stored && typeof stored === 'object' ? stored : DEFAULT_CENTRAL_REGISTRY;
    const rigs = Array.isArray(source.rigs) ? source.rigs.map(sanitizeCentralRig) : DEFAULT_CENTRAL_REGISTRY.rigs;
    if (!rigs.some(rig => rig.id === 'local')) {
        rigs.unshift(sanitizeCentralRig(DEFAULT_CENTRAL_REGISTRY.rigs[0], 0));
    }
    return {
        roleMappings: sanitizeRoleMappings(source.roleMappings),
        rigs: rigs.slice(0, 100)
    };
};

const saveCentralRegistry = async (registry) => writeJsonAtomic(CENTRAL_REGISTRY_FILE, registry);

const enrichRig = (rig) => {
    if (rig.source !== 'local') {
        const lastSyncMs = rig.lastSyncAt ? Date.parse(rig.lastSyncAt) : NaN;
        const lagSec = Number.isFinite(lastSyncMs) ? Math.max(0, Math.round((Date.now() - lastSyncMs) / 1000)) : rig.syncLagSec;
        return {
            ...rig,
            syncLagSec: lagSec,
            status: rig.status,
            syncStatus: rig.offlineBufferCount > 0 ? 'buffering' : rig.syncStatus,
            alarmCounts: { active: 0, unack: 0, p1: 0, p2: 0, p3: 0, highest: null },
            currentActivity: null
        };
    }

    const layout = getDashboardConfig();
    const meta = latestRigData?._meta || {};
    const alarmCounts = latestRigData?._alarms || alarms.snapshot().counts;
    const connected = !!meta.connected && !meta.stale;
    return {
        ...rig,
        rigName: layout.wellInfo?.rig || rig.rigName,
        wellName: layout.wellInfo?.well || rig.wellName,
        status: connected ? 'online' : (meta.stale ? 'stale' : 'offline'),
        syncStatus: connected ? 'healthy' : (meta.stale ? 'stale' : 'offline'),
        lastSyncAt: meta.ts || rig.lastSyncAt || null,
        syncLagSec: Math.round((meta.age_ms || 0) / 1000),
        offlineBufferCount: 0,
        alarmCounts,
        currentActivity: workover.getCurrent()
    };
};

const getCentralSnapshot = () => {
    const registry = getCentralRegistry();
    const rigs = registry.rigs.map(enrichRig);
    return {
        generatedAt: new Date().toISOString(),
        roleMappings: registry.roleMappings,
        rigs,
        summary: {
            total: rigs.length,
            online: rigs.filter(rig => rig.status === 'online').length,
            stale: rigs.filter(rig => rig.status === 'stale').length,
            offline: rigs.filter(rig => rig.status === 'offline').length,
            buffering: rigs.filter(rig => rig.offlineBufferCount > 0).length,
            activeAlarms: rigs.reduce((sum, rig) => sum + (rig.alarmCounts?.active || 0), 0),
            unackedAlarms: rigs.reduce((sum, rig) => sum + (rig.alarmCounts?.unack || 0), 0)
        }
    };
};

app.get('/api/central/rigs', auth.requireAuth, (req, res) => res.json(getCentralSnapshot()));

app.post('/api/central/rigs', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    const incoming = req.body && typeof req.body === 'object' ? req.body : {};
    const registry = {
        roleMappings: sanitizeRoleMappings(incoming.roleMappings),
        rigs: Array.isArray(incoming.rigs) ? incoming.rigs.map(sanitizeCentralRig).slice(0, 100) : getCentralRegistry().rigs
    };
    if (!registry.rigs.some(rig => rig.id === 'local')) registry.rigs.unshift(sanitizeCentralRig(DEFAULT_CENTRAL_REGISTRY.rigs[0], 0));
    await saveCentralRegistry(registry);
    res.json({ success: true, ...getCentralSnapshot() });
});

app.get('/api/central/role-mapping', auth.requireAuth, (req, res) => {
    res.json({ roleMappings: getCentralRegistry().roleMappings });
});

app.post('/api/central/role-mapping', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    const registry = getCentralRegistry();
    registry.roleMappings = sanitizeRoleMappings(req.body?.roleMappings || req.body || {});
    await saveCentralRegistry(registry);
    res.json({ success: true, roleMappings: registry.roleMappings });
});

app.get('/api/central/sync-health', auth.requireAuth, (req, res) => {
    const snapshot = getCentralSnapshot();
    res.json({
        generatedAt: snapshot.generatedAt,
        summary: snapshot.summary,
        rigs: snapshot.rigs.map(rig => ({
            id: rig.id,
            rigName: rig.rigName,
            status: rig.status,
            syncStatus: rig.syncStatus,
            lastSyncAt: rig.lastSyncAt,
            syncLagSec: rig.syncLagSec,
            offlineBufferCount: rig.offlineBufferCount
        }))
    });
});

// --- Workover: Activity / NPT ---
app.get('/api/activity/current', auth.requireAuth, (req, res) => res.json(workover.getCurrent() || {}));
app.get('/api/activity/codes', auth.requireAuth, (req, res) => res.json(workover.getCodes()));
app.get('/api/activity/log', auth.requireAuth, (req, res) => res.json(workover.getLog(req.query.date)));
app.post('/api/activity/set', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try {
        const { code, npt } = req.body || {};
        res.json({ success: true, current: workover.setActivity(code, npt) });
    } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- Workover: Alarm management ---
app.get('/api/alarms', auth.requireAuth, (req, res) => res.json(alarms.getActive()));
app.get('/api/alarms/history', auth.requireAuth, (req, res) => res.json(alarms.getHistory(Number(req.query.limit) || 200)));
app.post('/api/alarms/ack-all', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    const acknowledged = alarms.ackAll(req.user.username);
    const snap = alarms.snapshot(); io.emit('alarms', snap);
    res.json({ success: true, acknowledged, ...snap });
});
app.post('/api/alarms/:id/ack', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    const ok = alarms.ack(req.params.id, req.user.username);
    const snap = alarms.snapshot(); io.emit('alarms', snap);
    res.json({ success: ok, ...snap });
});
app.get('/api/alarms/config', auth.requireAuth, (req, res) => res.json(alarms.getConfig()));
app.put('/api/alarms/config', auth.requireAuth, auth.requireRole('admin'), async (req, res) => {
    try { res.json({ success: true, config: await alarms.setConfig(req.body) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- Workover: Torque-turn / connections ---
app.get('/api/connections', auth.requireAuth, (req, res) => res.json(workover.getConnections(req.query.date)));
app.get('/api/torqueturn/current', auth.requireAuth, (req, res) => res.json(workover.getTorqueTurnLive()));

// --- Workover: Daily report ---
app.get('/api/report/daily', auth.requireAuth, (req, res) => res.json(workover.getDailyReport(req.query.date)));
app.get('/api/report/header', auth.requireAuth, (req, res) => res.json(workover.getHeader()));
app.put('/api/report/header', auth.requireAuth, auth.requireRole('admin', 'operator'), async (req, res) => {
    res.json({ success: true, header: await workover.setHeader(req.body || {}) });
});

// --- Maintenance & asset health ---
app.get('/api/maintenance/summary', auth.requireAuth, (req, res) => res.json(maintenance.getSummary(latestRigData)));
app.get('/api/maintenance/pm', auth.requireAuth, (req, res) => res.json(maintenance.getPM(latestRigData)));
app.post('/api/maintenance/pm/:id/service', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, task: maintenance.serviceTask(req.params.id, { ...req.body, by: req.user.username }) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.get('/api/maintenance/calibrations', auth.requireAuth, (req, res) => res.json(maintenance.getCalibrations(Number(req.query.limit) || 200)));
app.post('/api/maintenance/calibrations', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    res.json({ success: true, record: maintenance.logCalibration({ ...req.body, by: req.user.username }) });
});
app.get('/api/maintenance/downtime', auth.requireAuth, (req, res) => res.json(maintenance.getDowntime(Number(req.query.limit) || 200)));
app.get('/api/maintenance/reason-codes', auth.requireAuth, (req, res) => res.json(maintenance.REASON_CODES));
app.post('/api/maintenance/downtime', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, record: maintenance.logDowntime({ ...req.body, by: req.user.username }) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/maintenance/downtime/:id/close', auth.requireAuth, auth.requireRole('admin', 'operator'), (req, res) => {
    try { res.json({ success: true, record: maintenance.closeDowntime(req.params.id, { by: req.user.username }) }); }
    catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});

// --- Authentication API ---
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_RATE_LIMIT || 20),
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, message: 'Too many login attempts. Please try again later.' }
});

// Tells the login UI which providers are available (unauthenticated).
app.get('/api/auth/info', (req, res) => res.json(ldap.info()));

// Login supports local accounts and/or Windows-domain (LDAP/AD) accounts,
// selected by AUTH_MODE (local | ldap | both). In 'both', a local account is
// tried first (break-glass admin), then the directory.
app.post('/api/login', loginLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username and password required' });
    }
    const mode = (process.env.AUTH_MODE || 'local').toLowerCase();

    // 1) Local authentication.
    if (mode === 'local' || mode === 'both') {
        const local = users.find(u => u.username === username && u.status !== 'inactive');
        if (local && local.password && auth.verifyPassword(password, local.password)) {
            return res.json({ success: true, token: auth.signToken(local), user: sanitizeUser(local) });
        }
        if (mode === 'local') {
            return res.status(401).json({ success: false, message: 'Invalid credentials or account inactive' });
        }
    }

    // 2) Windows domain (LDAP/Active Directory) authentication.
    if ((mode === 'ldap' || mode === 'both') && ldap.ldapEnabled()) {
        try {
            const dir = await ldap.authenticate(username, password);
            const u = await upsertLdapUser(dir);
            if (!u) return res.status(403).json({ success: false, message: 'Account disabled' });
            return res.json({ success: true, token: auth.signToken(u), user: sanitizeUser(u) });
        } catch (e) {
            return res.status(401).json({ success: false, message: 'Invalid domain credentials' });
        }
    }

    return res.status(401).json({ success: false, message: 'Invalid credentials or account inactive' });
});

// --- Error handling, startup & graceful shutdown ---------------------------
// Catch-all error middleware so a thrown error in any handler returns JSON
// instead of crashing or leaking a stack trace.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error('Unhandled error:', err.message);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
});

server.listen(PORT, () => {
    console.log(`ROM-II backend listening on port ${PORT} (data source: ${DATA_SOURCE})`);
    scheduleNextPoll();
});

// Periodically flush drilling state off the hot loop.
const flushTimer = setInterval(flushDrillingState, Number(process.env.STATE_FLUSH_MS || 5000));

process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));
process.on('uncaughtException', (err) => console.error('Uncaught exception:', err));

let shuttingDown = false;
const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);
    pollStopped = true;
    if (pollTimer) clearTimeout(pollTimer);
    clearInterval(flushTimer);
    try { await flushDrillingState(); } catch (e) { /* best effort */ }
    io.close();
    server.close(() => { console.log('HTTP server closed.'); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref(); // hard cap
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
