const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require("socket.io");
const { InfluxDB } = require('@influxdata/influxdb-client');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const PORT = 5000;
const INFLUX_URL = process.env.INFLUX_URL || 'http://influxdb:8086';
const INFLUX_TOKEN = process.env.INFLUX_TOKEN || 'my-super-secret-auth-token';
const INFLUX_ORG = process.env.INFLUX_ORG || 'romii_org';
const INFLUX_BUCKET = process.env.INFLUX_BUCKET || 'romii_bucket';

app.use(cors());
app.use(express.json());

// Basic health check
app.get('/', (req, res) => {
    res.send('ROM-II Backend is running');
});

// Start server
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// Socket.io connection
io.on('connection', (socket) => {
    console.log('A user connected');
    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// InfluxDB Query Client
const queryApi = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN }).getQueryApi(INFLUX_ORG);

// --- Drilling Physics Engine ---
const DRILLING_STATE_FILE = './drilling_state.json';
let drillingState = {
    stringWeight: 0, // kips (Tare weight)
    totalDepth: 304.8, // 1000 ft in meters
    bitDepth: 0, // meters
    lastBlockPosition: 0 // ft (Block position is still in ft in ACS tag)
};

// Load state from disk if exists
if (fs.existsSync(DRILLING_STATE_FILE)) {
    try {
        const saved = JSON.parse(fs.readFileSync(DRILLING_STATE_FILE));
        drillingState = { ...drillingState, ...saved };
    } catch (e) {
        console.error("Failed to load drilling state:", e);
    }
}

const saveDrillingState = () => {
    fs.writeFileSync(DRILLING_STATE_FILE, JSON.stringify(drillingState, null, 2));
};

// --- PLC / S7 Configuration API ---
app.get('/api/config/plc', (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'plc_config.json'), 'utf8'));
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Failed to read PLC configuration' });
    }
});

app.post('/api/config/plc', async (req, res) => {
    try {
        const config = req.body; // Expect { slaves: [...] }
        saveModbusConfig(config);

        // Update Telegraf.conf
        let content = fs.readFileSync(CONFIG_PATH, 'utf8');

        // Write to telegraf.conf
        const startMarker = '# PLC_CONFIG_START';
        const endMarker = '# PLC_CONFIG_END';
        const startIndex = content.indexOf(startMarker);
        const endIndex = content.indexOf(endMarker);

        if (startIndex === -1 || endIndex === -1) {
            throw new Error("Telegraf configuration file is missing markers.");
        }

        const newSection = generateTelegrafConfig(config);
        const before = content.substring(0, startIndex + startMarker.length);
        const after = content.substring(endIndex);
        const newContent = `${before}\n${newSection}\n${after}`;
        fs.writeFileSync(CONFIG_PATH, newContent);

        // Restart Telegraf Container via Docker Socket API
        const options = {
            socketPath: '/var/run/docker.sock',
            path: '/containers/romii_telegraf/restart',
            method: 'POST'
        };

        const dockerReq = http.request(options, (dockerRes) => {
            if (dockerRes.statusCode === 204 || dockerRes.statusCode === 200) {
                console.log("Telegraf container restarted successfully.");
                res.json({ success: true, message: "Configuration saved and Telegraf restarted." });
            } else {
                res.status(500).json({ success: false, error: 'Failed to restart Telegraf. Docker status: ' + dockerRes.statusCode });
            }
        });

        dockerReq.on('error', (err) => {
            res.status(500).json({ success: false, error: 'Docker socket error: ' + err.message });
        });
        dockerReq.end();

    } catch (err) {
        console.error("Error saving PLC config:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Physics Loop (Runs on data update)
const updatePhysics = (rigData) => {
    // 1. Get Inputs
    const currentHookLoad = rigData.drawworks?.hook_load || 0;
    const currentBlockPos = rigData.drawworks?.block_position || 0;

    // PLC Source of Truth Check
    // If the PLC is providing depth data directly, we prioritize it
    const plcBitDepth = rigData.drilling?.bit_depth;
    const plcHoleDepth = rigData.drilling?.hole_depth;

    if (plcBitDepth !== undefined && plcBitDepth > 0) {
        drillingState.bitDepth = plcBitDepth;
    }
    if (plcHoleDepth !== undefined && plcHoleDepth > 0) {
        drillingState.totalDepth = plcHoleDepth;
    }

    // 2. Calculate WOB
    // WOB is the weight of the string supported by the bottom, so StringWeight - HookLoad
    let wob = Math.max(0, drillingState.stringWeight - currentHookLoad);

    // 3. Calculate Depths (Backup/Local Calculation)
    const deltaBlock = drillingState.lastBlockPosition - currentBlockPos; // Positive = Moving Down

    // Update Bit Depth based on block movement ONLY if PLC data isn't active
    // This maintains historical consistency if PLC sends 0 or is missing
    if (!plcBitDepth) {
        // Delta block is in feet, bitDepth is in meters
        let deltaBlockMeters = deltaBlock * 0.3048;
        let newBitDepth = drillingState.bitDepth + deltaBlockMeters;
        newBitDepth = Math.max(0, newBitDepth);

        // Drilling Logic
        const WOB_THRESHOLD = 1.0; // kips
        if (wob > WOB_THRESHOLD) {
            drillingState.bitDepth = newBitDepth;
            if (drillingState.bitDepth > drillingState.totalDepth) {
                drillingState.totalDepth = drillingState.bitDepth;
            }
        } else {
            drillingState.bitDepth = Math.min(newBitDepth, drillingState.totalDepth);
        }
    }

    // Update History
    drillingState.lastBlockPosition = currentBlockPos;
    saveDrillingState();

    return {
        wob: Number(wob.toFixed(1)),
        bit_depth: Number(drillingState.bitDepth.toFixed(2)),
        hole_depth: Number(drillingState.totalDepth.toFixed(2))
    };
};

// --- APIs for Calibration ---
app.post('/api/drilling/zero-wob', (req, res) => {
    // Set String Weight to current Hook Load
    // We need the latest hook load, which we might not have direct access to here easily 
    // without querying DB or caching. For now, let's accept it from the client or use valid cached data.
    // Better: Client sends current hookload to confirm? Or we just use strict state.
    // Let's rely on the body for now to be explicit, or fetch latest.
    const { currentHookLoad } = req.body;
    if (currentHookLoad !== undefined) {
        drillingState.stringWeight = Number(currentHookLoad);
        saveDrillingState();
        res.json({ success: true, stringWeight: drillingState.stringWeight });
    } else {
        res.status(400).json({ error: "Missing currentHookLoad" });
    }
});

app.post('/api/drilling/set-depth', (req, res) => {
    const { bitDepth, holeDepth } = req.body;
    if (bitDepth !== undefined) drillingState.bitDepth = Number(bitDepth);
    if (holeDepth !== undefined) drillingState.totalDepth = Number(holeDepth);
    saveDrillingState();
    res.json({ success: true, state: drillingState });
});

app.get('/api/drilling/state', (req, res) => {
    res.json(drillingState);
});

// --- Main Socket & Data Loop ---

// Modbus Configuration API helpers
const CONFIG_PATH = process.env.TELEGRAF_CONFIG_PATH || './telegraf/telegraf.conf';
const DB_PATH = path.join(__dirname, 'plc_config.json');

// Helper: Read/Write JSON DB
const getModbusConfig = () => {
    if (!fs.existsSync(DB_PATH)) return { slaves: [] };
    return JSON.parse(fs.readFileSync(DB_PATH));
};

const saveModbusConfig = (config) => {
    fs.writeFileSync(DB_PATH, JSON.stringify(config, null, 2));
};

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

const queryData = async () => {
    // Query for latest values. S7comm uses 'AHWR' as measurement name.
    const measurements = ['drawworks', 'engine', 'mudpump', 'wellcontrol', 'modbus', 'AHWR', 'fluid', 'drilling', 'hpu', 'system', 'htd', 'acs', 'cat_engine', 'cwk', 'pct'];
    const measurementFilter = measurements.map(m => `r["_measurement"] == "${m}"`).join(' or ');

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

                    if (FIELD_MAP[f]) {
                        meas = FIELD_MAP[f].meas;
                        f = FIELD_MAP[f].field;
                    }

                    if (!data[meas]) data[meas] = {};
                    data[meas][f] = o._value;
                },
                error(error) {
                    console.error('InfluxDB Query Error:', error);
                    reject(error);
                },
                complete() {
                    resolve();
                },
            });
        });

        // Check if we have valid sensor data (Drawworks is critical)
        const hasSensorData = data.drawworks || data.engine || data.mudpump;

        if (hasSensorData) {
            // Run Physics Engine
            const physicsData = updatePhysics(data);
            data.drilling = { ...(data.drilling || {}), ...physicsData };
        } else {
            // No Sensor Data (PLC Disconnected) -> Aggressive Zero State
            data.drilling = {
                ...(data.drilling || {}),
                wob: 0,
                bit_depth: 0,
                hole_depth: 0
            };
        }

        // Map real Modbus "wellcontrol" data to frontend expectation "well_control", defaulting to safely zeroed fields if missing
        const wcReal = data.wellcontrol || {};
        data.well_control = {
            annular_pressure: wcReal.annular_pressure || 0,
            manifold_pressure: wcReal.manifold_pressure || 0,
            accumulator_pressure: wcReal.accumulator_pressure || 0,
            annular_open: wcReal.annular_open || false,
            annular_close: wcReal.annular_close || false,
            pipe_ram_open: wcReal.pipe_ram_open || false,
            pipe_ram_close: wcReal.pipe_ram_close || false,
            blind_ram_open: wcReal.blind_ram_open || false,
            blind_ram_close: wcReal.blind_ram_close || false,
            shear_ram_open: wcReal.shear_ram_open || false
        };
        // Remove the internal un-underscored reference to save payload size
        delete data.wellcontrol;

        // Emit data (Real or Zeroed)
        // console.log("Drawworks payload:", JSON.stringify(data.drawworks));
        console.log("Raw Modbus Object:", JSON.stringify(data.modbus));
        console.log("Well Control payload:", JSON.stringify(data.well_control));


        // Cache the latest data for initial page loads
        latestRigData = data;
        io.emit('rig_data', data);

    } catch (err) {
        console.error("Error querying InfluxDB:", err);
    }
};

// Global cache for the latest data
let latestRigData = {};

// API: Get Latest Rig Data
app.get('/api/rig/latest', (req, res) => {
    res.json(latestRigData);
});

// Poll InfluxDB every second
setInterval(queryData, 1000);

// API: Get Historical Data
// API: Get Historical Data
app.get('/api/history', async (req, res) => {
    const { range, start, stop } = req.query;

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

    const measurements = ['drawworks', 'engine', 'mudpump', 'wellcontrol', 'modbus'];
    const measurementFilter = measurements.map(m => `r["_measurement"] == "${m}"`).join(' or ');

    const fluxQuery = `
    import "types"
    from(bucket: "${INFLUX_BUCKET}")
      ${rangeFilter}
      |> filter(fn: (r) => ${measurementFilter})
      |> filter(fn: (r) => types.isType(v: r._value, type: "float") or types.isType(v: r._value, type: "int") or types.isType(v: r._value, type: "uint"))
      |> aggregateWindow(every: ${windowPeriod}, fn: mean, createEmpty: false)
      |> yield(name: "mean")
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
const USERS_FILE = './users.json';
let users = [];

// Load users
const loadUsers = () => {
    if (fs.existsSync(USERS_FILE)) {
        try {
            users = JSON.parse(fs.readFileSync(USERS_FILE));
        } catch (e) {
            console.error("Failed to load users:", e);
            users = [];
        }
    } else {
        // Default Admin
        users = [{ id: 1, username: 'admin', password: 'admin', role: 'admin', status: 'active' }];
        saveUsers();
    }
};

const saveUsers = () => {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
};

loadUsers();

// API: List Users
app.get('/api/users', (req, res) => {
    // Return users without passwords
    const safeUsers = users.map(({ password, ...u }) => u);
    res.json(safeUsers);
});

// API: Add User
app.post('/api/users', (req, res) => {
    const { username, password, role } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });

    if (users.find(u => u.username === username)) {
        return res.status(400).json({ error: "Username already exists" });
    }

    const newUser = {
        id: Date.now(),
        username,
        password, // In prod, hash this!
        role: role || 'operator',
        status: 'active'
    };
    users.push(newUser);
    saveUsers();
    res.json({ success: true, user: { ...newUser, password: undefined } });
});

// API: Update User
app.put('/api/users/:id', (req, res) => {
    const { id } = req.params;
    const { username, password, role, status } = req.body;

    const index = users.findIndex(u => u.id == id);
    if (index === -1) return res.status(404).json({ error: "User not found" });

    // Update fields
    if (username) users[index].username = username;
    if (password) users[index].password = password; // In prod, hash!
    if (role) users[index].role = role;
    if (status) users[index].status = status;

    saveUsers();
    res.json({ success: true, user: { ...users[index], password: undefined } });
});

// API: Delete User
app.delete('/api/users/:id', (req, res) => {
    const { id } = req.params;
    const initialLength = users.length;
    users = users.filter(u => u.id != id);

    if (users.length < initialLength) {
        saveUsers();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: "User not found" });
    }
});

// --- Dashboard Persistence ---
const DASHBOARD_FULL_CONFIG_FILE = './dashboard_layout.json';

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

const getDashboardConfig = () => {
    let config = DEFAULT_DASHBOARD_CONFIG;
    if (fs.existsSync(DASHBOARD_FULL_CONFIG_FILE)) {
        try {
            config = JSON.parse(fs.readFileSync(DASHBOARD_FULL_CONFIG_FILE));
        } catch (e) {
            console.error("Failed to load dashboard config:", e);
        }
    }

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

    return config;
};

const saveDashboardConfig = (config) => {
    fs.writeFileSync(DASHBOARD_FULL_CONFIG_FILE, JSON.stringify(config, null, 2));
};

// API: Get Dashboard Layout
app.get('/api/dashboard/layout', (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
    res.json(getDashboardConfig());
});

// API: Save Dashboard Layout
app.post('/api/dashboard/layout', (req, res) => {
    const incomingConfig = req.body;
    const existingConfig = getDashboardConfig();

    // Migration: Sanitize incoming gauges (Allow WOH, WOB, HTD RPM, HTD TORQUE, PCT TORQUE) and limit to 5
    if (incomingConfig.gauges) {
        const allowedKeys = ['hook_load', 'wob', 'htd_rpm', 'htd_torque', 'pct_torque'];
        incomingConfig.gauges = incomingConfig.gauges.filter(g => allowedKeys.includes(g.dataKey)).slice(0, 5);
    }

    // Merge existing config with incoming updates
    const mergedConfig = {
        ...existingConfig,
        ...incomingConfig
    };

    saveDashboardConfig(mergedConfig);
    // Real-time broadcast
    io.emit('dashboard_layout_update', mergedConfig);
    res.json({ success: true, config: mergedConfig });
});

// --- Authentication API ---
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;

    const user = users.find(u => u.username === username && u.password === password && u.status !== 'inactive');

    if (user) {
        // Return mock token and user info (excluding password)
        const { password, ...safeUser } = user;
        res.json({
            success: true,
            token: `mock-jwt-token-romii-${user.role}`,
            user: safeUser
        });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials or account inactive' });
    }
});
