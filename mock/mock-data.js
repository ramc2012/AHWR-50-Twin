'use strict';
// Synthetic rig-telemetry generator for LOCAL DEMO ONLY (no physical PLC).
// Writes app-level measurements/fields straight to InfluxDB every second so the
// dashboard shows live, moving data. Values are plausible but NOT physical.
const { InfluxDB, Point } = require('@influxdata/influxdb-client');

const url = process.env.INFLUX_URL || 'http://influxdb:8086';
const token = process.env.INFLUX_TOKEN;
const org = process.env.INFLUX_ORG || 'romii_org';
const bucket = process.env.INFLUX_BUCKET || 'romii_bucket';
const interval = Number(process.env.MOCK_INTERVAL_MS || 1000);

if (!token) { console.error('MOCK: INFLUX_TOKEN env required'); process.exit(1); }

// flushInterval defaults to 60s in the JS client — far too slow for a live
// demo, so flush every second with small batches.
const writeApi = new InfluxDB({ url, token }).getWriteApi(org, bucket, 'ms', {
    batchSize: 200,
    flushInterval: 1000,
    maxRetries: 3,
});

let t = 0;
const osc = (base, amp, period, phase = 0) => base + amp * Math.sin((2 * Math.PI * (t + phase)) / period);
const noise = (a) => (Math.random() - 0.5) * a;
const r = (v, d = 2) => Number(Number(v).toFixed(d));

let totalStrokes = 100000;
let holeDepth = 1500;   // m
let runHours = 4200;    // h
let blockPos = 45;      // ft — driven by the workover cycle below
let lastMakeupPeak = 13000;

// Scripted workover cycle so activity classification, torque-turn and alarms are demonstrable.
const PHASES = [['RIH', 20], ['MAKE_UP', 8], ['CIRCULATE', 15], ['POOH', 20], ['BREAK_OUT', 8]];
const CYCLE_LEN = PHASES.reduce((s, p) => s + p[1], 0);
function workoverPhase(tt) {
    const cycleIndex = Math.floor(tt / CYCLE_LEN);
    let x = tt % CYCLE_LEN;
    for (const [name, dur] of PHASES) { if (x < dur) return { phase: name, elapsed: x, dur, cycleIndex }; x -= dur; }
    return { phase: 'RIH', elapsed: 0, dur: 20, cycleIndex };
}

function tick() {
    t += 1;
    const wf = workoverPhase(t);
    if (wf.phase === 'RIH') blockPos = Math.max(3, blockPos - 2);
    else if (wf.phase === 'POOH') blockPos = Math.min(88, blockPos + 2);
    const pumping = wf.phase === 'CIRCULATE';
    let pctSequence = 0, makeupTorque = r(500 + noise(50));
    if (wf.phase === 'MAKE_UP') {
        pctSequence = 1;
        const peak = (wf.cycleIndex % 4 === 3) ? 19500 : (11500 + (wf.cycleIndex % 3) * 1400); // every 4th joint over-torques -> FAIL
        makeupTorque = r(2000 + (wf.elapsed / wf.dur) * (peak - 2000) + noise(150));
        lastMakeupPeak = peak;
    } else if (wf.phase === 'BREAK_OUT') { pctSequence = 2; }
    // periodic alarm excursions
    const tubingPressure = (pumping && wf.cycleIndex % 3 === 1) ? r(222 + noise(4)) : r(118 + noise(4));
    const tankGainLoss = (wf.phase === 'RIH' && wf.cycleIndex % 4 === 2 && wf.elapsed > 5) ? r(2.2 + noise(0.2)) : r(noise(0.5));
    // Read-only safety status from the PLC (digital inputs) — surfaced as P1 alarms, never actuated.
    // Simple periodic windows so the top alarm strip is demonstrable: ESD ~7s every 90s, lockout ~6s every 120s.
    const esdActive = (t % 90 >= 40 && t % 90 < 47) ? 1 : 0;        // simulated floor E-stop press
    const lockoutActive = (t % 120 >= 80 && t % 120 < 86) ? 1 : 0;  // simulated equipment lockout
    totalStrokes += Math.round(Math.abs(osc(95, 15, 40)));
    const rop = Math.max(0, osc(18, 8, 90) + noise(2)); // m/h
    holeDepth += (rop / 3600) * (interval / 1000);
    const bitDepth = Math.max(0, holeDepth - Math.max(0, osc(0.4, 0.6, 30)));
    runHours += interval / 3600000;

    const points = [];
    const P = (meas, fields) => {
        const p = new Point(meas);
        for (const [k, v] of Object.entries(fields)) {
            if (typeof v === 'boolean') p.booleanField(k, v);
            else p.floatField(k, v);
        }
        points.push(p);
    };

    const hookLoad = r(osc(95, 18, 60) + noise(2)); // tonnes

    P('drawworks', { hook_load: hookLoad, block_position: r(blockPos), rope_wear: r(osc(2.5, 0.3, 300)) });
    P('drilling', {
        wob: r(Math.max(0, osc(14, 9, 75) + noise(1))),
        rop: r(rop), rpm: r(osc(95, 25, 50)), torque: r(osc(9000, 3000, 70)),
        delta_torque: r(osc(500, 200, 40)), operation_mode: 1,
        bit_depth: r(bitDepth), hole_depth: r(holeDepth)
    });
    P('mudpump', {
        spm: pumping ? r(osc(95, 12, 40)) : r(6 + noise(1)), total_spm: totalStrokes,
        flow_in: pumping ? r(osc(900, 90, 55)) : r(40 + noise(10)),
        flow_out: pumping ? r(osc(95, 4, 55)) : r(3 + noise(1)),
        pressure: pumping ? r(osc(195, 30, 65)) : r(15 + noise(3)), delta_pressure: r(osc(5, 3, 30))
    });
    P('fluid', {
        total_tank_volume: r(osc(220, 8, 400)), tank_gain_loss: tankGainLoss, trip_tank: r(osc(18, 2, 200)),
        trip_tank_percentage: r(osc(55, 10, 200)), tank_1: r(osc(55, 3, 400)), tank_2: r(osc(55, 3, 420)),
        tank_3: r(osc(55, 3, 440)), tank_4: r(osc(55, 3, 460))
    });
    P('cat_engine', {
        status: 1, rpm: r(osc(1200, 120, 45)), load: r(osc(62, 18, 60)), run_hours: r(runHours),
        coolant_temp: r(osc(85, 4, 200)), oil_pressure: r(osc(45, 4, 90)), fuel_rate: r(osc(110, 20, 70)),
        fuel_temp: r(osc(40, 3, 300)), battery_voltage: r(osc(26, 1, 120)),
        total_hours: r(runHours), total_fuel: r(50000 + runHours), coolant_level: r(osc(85, 3, 500))
    });
    P('hpu', {
        status: 2, run_hours: r(runHours * 0.8), aux_pressure: r(osc(150, 15, 80)),
        discharge_pressure: r(osc(180, 20, 75)), oil_temp: r(osc(50, 6, 250)), oil_level: r(osc(82, 4, 400)),
        pdw_pump_flow: r(osc(70, 15, 60)), pdw_pump_press: r(osc(180, 15, 70)), pilot_pressure: r(osc(25, 3, 90)),
        htd_pump1_flow: r(osc(65, 12, 60)), htd_pump1_press: r(osc(175, 15, 70)),
        htd_pump2_flow: r(osc(64, 12, 62)), htd_pump2_press: r(osc(176, 15, 72)), gate_valve: 1
    });
    P('htd', {
        status: 2, rpm: r(osc(85, 30, 50)), torque: r(osc(900, 250, 70)), work_mode: 1, op_mode: 1,  // daN·m (workover top drive ~0.6-1.2 kdaN·m → ~65-115 kW mech)
        rotation_status: 1, brake_status: 4, elevator_status: 3, ibop_status: 3, tilt_status: 2,
        vertical_speed: r(osc(0, 0.3, 30)), inclination: r(osc(50, 5, 200)), working_hours: r(runHours * 0.6),
        gear_status: 2, lube_status: 2
    });
    P('acs', {
        status: 1, crownsaver: r(osc(2200, 200, 60)), floorsaver: r(osc(1800, 150, 60)),
        bottomsaver: r(osc(1500, 120, 60)), calibration_status: 3, upper_tag: 2400, lower_tag: 200
    });
    P('cwk', {
        status: 1, indexer_dx: 1, indexer_sx: 1, kickers_dx: 2, kickers_sx: 2, skate_status: 2,
        slide_status: 2, carrier_status: 3, clamp_status: 4, clamp_pressure: r(osc(180, 20, 70)),
        clamp_force: r(osc(150, 15, 70)), source_cmd: 1
    });
    P('pct', {
        status: 2, op_mode: 1, sequence: pctSequence, dolly_status: 6,
        spinner_floating: 1, spinner_makeup_torque: r(makeupTorque * 0.9), makeup_torque: makeupTorque,
        last_makeup_torque: r(lastMakeupPeak + noise(100)), clamp_up_status: 4, clamp_low_status: 4,
        clamp_up_pressure: r(osc(190, 20, 70)), clamp_low_pressure: r(osc(190, 20, 72))
    });
    // Well control / BOP — a real source so the panel shows live data (psi).
    P('wellcontrol', {
        annular_pressure: r(osc(1400, 120, 120)),
        manifold_pressure: r(osc(1200, 100, 110)),
        accumulator_pressure: r(osc(2950, 80, 300)),
        annular_open: false, annular_close: true,
        pipe_ram_open: false, pipe_ram_close: true,
        blind_ram_open: false, blind_ram_close: true, shear_ram_open: false
    });
    // Wellhead / well-service pressures (bar) — workover tubing/casing/wellhead
    P('wellhead', {
        tubing_pressure: tubingPressure,
        casing_pressure: r(88 + noise(4)),
        wellhead_pressure: r(108 + noise(4))
    });
    // Safety status (read-only PLC digital inputs) — drive ESD/lockout alarms.
    P('safety', { esd_active: esdActive, lockout_active: lockoutActive });

    try { writeApi.writePoints(points); } catch (e) { console.error('MOCK write error:', e.message); }
}

console.log(`MOCK generator -> ${url} bucket=${bucket} every ${interval}ms`);
const timer = setInterval(tick, interval);

const stop = async () => {
    clearInterval(timer);
    try { await writeApi.close(); } catch { /* ignore */ }
    process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
