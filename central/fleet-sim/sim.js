'use strict';
// =====================================================================
// CRMF Fleet Simulator — DEMO ONLY
// Emulates N rig-edge sync agents streaming store-and-forward batches to the
// CRMF /ingest endpoint, in the EXACT contract produced by the real edge agent
// (repo backend/lib/sync.js): gzipped JSON, X-Device-Id header, optional bearer.
//
// Stands in for 50 physical rigs so the fleet portal is live end-to-end. Some
// rigs are healthy, one is intentionally degraded (missing tags), and one is
// flaky (drops offline and recovers) so the data-quality monitor and alarm
// command centre have something real to show.
// =====================================================================
const http = require('http');
const https = require('https');
const zlib = require('zlib');

const CENTRAL_URL = process.env.CENTRAL_URL || 'http://crmf-backend:6000';
const TOKEN = process.env.INGEST_TOKEN || '';
const ACTIVE = Number(process.env.ACTIVE_RIGS || 14);
const BATCH_SECONDS = Number(process.env.BATCH_SECONDS || 10);

const osc = (t, base, amp, period, phase = 0) => base + amp * Math.sin((2 * Math.PI * (t + phase)) / period);
const noise = (a) => (Math.random() - 0.5) * a;
const r = (v, d = 1) => Number(Number(v).toFixed(d));

// Scripted workover cycle (mirrors the edge mock) so activity / torque-turn / alarms are demonstrable.
const PHASES = [['RIH', 20], ['MAKE_UP', 8], ['CIRCULATE', 15], ['POOH', 20], ['BREAK_OUT', 8]];
const CYCLE_LEN = PHASES.reduce((s, p) => s + p[1], 0);
function phaseAt(tt) {
    const cycleIndex = Math.floor(tt / CYCLE_LEN);
    let x = tt % CYCLE_LEN;
    for (const [name, dur] of PHASES) { if (x < dur) return { phase: name, elapsed: x, dur, cycleIndex }; x -= dur; }
    return { phase: 'RIH', elapsed: 0, dur: 20, cycleIndex };
}

// Per-rig runtime state.
const rigs = [];
for (let n = 1; n <= ACTIVE; n++) {
    rigs.push({
        id: `AHWR-50-${n}`,
        offset: (n * 7) % CYCLE_LEN,         // desync the cycles
        seq: 1,
        batch: { channels: [], events: [] },
        blockPos: 40 + (n % 10),
        lastMakeupPeak: 12000,
        alarmActive: false,
        degraded: n % 7 === 0,               // missing-tag rig -> lower completeness score
        flaky: n === ACTIVE,                 // last rig drops offline periodically
        well: `GS-${10 + n}#${3 + (n % 5)}`,
        sealCountdown: (n * 3) % BATCH_SECONDS,
    });
}

function snapshot(rig, t) {
    const tt = t + rig.offset;
    const wf = phaseAt(tt);
    if (wf.phase === 'RIH') rig.blockPos = Math.max(3, rig.blockPos - 2);
    else if (wf.phase === 'POOH') rig.blockPos = Math.min(88, rig.blockPos + 2);
    const pumping = wf.phase === 'CIRCULATE';

    let makeupTorque = r(500 + noise(50));
    if (wf.phase === 'MAKE_UP') {
        const peak = (wf.cycleIndex % 4 === 3) ? 19500 : (11500 + (wf.cycleIndex % 3) * 1400);
        makeupTorque = r(2000 + (wf.elapsed / wf.dur) * (peak - 2000) + noise(150));
        rig.lastMakeupPeak = peak;
    }
    const tubing = (pumping && wf.cycleIndex % 3 === 1) ? r(222 + noise(4)) : r(118 + noise(4));
    const tankGL = (wf.phase === 'RIH' && wf.cycleIndex % 4 === 2 && wf.elapsed > 5) ? r(2.2 + noise(0.2), 2) : r(noise(0.5), 2);
    const esd = (tt % 90 >= 40 && tt % 90 < 47) ? 1 : 0;
    const lockout = (tt % 120 >= 80 && tt % 120 < 86) ? 1 : 0;

    const v = {
        'drawworks.hook_load': r(osc(t, 95, 18, 60) + noise(2)),
        'drawworks.block_position': r(rig.blockPos),
        'drawworks.rope_wear': r(osc(t, 2.5, 0.3, 300), 2),
        'drilling.wob': r(Math.max(0, osc(t, 14, 9, 75) + noise(1))),
        'drilling.rop': r(Math.max(0, osc(t, 18, 8, 90) + noise(2))),
        'drilling.rpm': r(osc(t, 95, 25, 50)),
        'drilling.torque': r(osc(t, 9000, 3000, 70)),
        'drilling.bit_depth': r(1480 + osc(t, 0, 6, 200)),
        'drilling.hole_depth': r(1500 + (t / 600)),
        'htd.rpm': r(osc(t, 85, 30, 50)),
        'htd.torque': r(osc(t, 8000, 3000, 70)),
        'pct.makeup_torque': makeupTorque,
        'pct.last_makeup_torque': r(rig.lastMakeupPeak + noise(100)),
        'hpu.aux_pressure': r(osc(t, 150, 15, 80)),
        'hpu.discharge_pressure': r(osc(t, 180, 20, 75)),
        'hpu.oil_temp': r(osc(t, 50, 6, 250) + (rig.degraded ? 0 : 0)),
        'hpu.oil_level': r(osc(t, 82, 4, 400)),
        'hpu.pilot_pressure': r(osc(t, 25, 3, 90)),
        'wellhead.tubing_pressure': tubing,
        'wellhead.casing_pressure': r(88 + noise(4)),
        'wellhead.wellhead_pressure': r(108 + noise(4)),
        'mudpump.spm': pumping ? r(osc(t, 95, 12, 40)) : r(6 + noise(1)),
        'mudpump.flow_in': pumping ? r(osc(t, 2000, 150, 55)) : r(40 + noise(10)),
        'mudpump.pressure': pumping ? r(osc(t, 195, 30, 65)) : r(15 + noise(3)),
        'fluid.tank_gain_loss': tankGL,
        'fluid.total_tank_volume': r(osc(t, 220, 8, 400)),
        'fluid.trip_tank': r(osc(t, 18, 2, 200)),
        'wellcontrol.accumulator_pressure': r(osc(t, 2950, 80, 300)),
        'wellcontrol.annular_pressure': r(osc(t, 1400, 120, 120)),
        'wellcontrol.manifold_pressure': r(osc(t, 1200, 100, 110)),
        'safety.esd_active': esd,
        'safety.lockout_active': lockout,
        'cat_engine.rpm': r(osc(t, 1200, 120, 45)),
        'cat_engine.load': r(osc(t, 62, 18, 60)),
        'cat_engine.coolant_temp': r(osc(t, 85, 4, 200)),
        'cat_engine.oil_pressure': r(osc(t, 45, 4, 90)),
        'cat_engine.fuel_rate': r(osc(t, 110, 20, 70)),
        'cat_engine.fuel_temp': r(osc(t, 40, 3, 300)),
        'cat_engine.battery_voltage': r(osc(t, 26, 1, 120), 2),
    };

    // Degraded rig: drop many EXPECTED tags so its completeness (and health score)
    // falls into the "degraded" band — exercises the data-quality monitor.
    if (rig.degraded) {
        for (const k of ['mudpump.flow_in', 'mudpump.pressure', 'mudpump.spm', 'wellhead.casing_pressure',
            'wellhead.wellhead_pressure', 'drilling.bit_depth', 'drilling.wob', 'drilling.rop', 'htd.torque',
            'hpu.oil_level', 'hpu.aux_pressure', 'wellcontrol.annular_pressure', 'cat_engine.coolant_temp',
            'cat_engine.oil_pressure', 'fluid.total_tank_volume']) delete v[k];
    }

    // ----- Events -----
    const events = [];
    // Activity each tick boundary (cheap; one per batch is enough — emit on seal instead).
    rig._wf = wf;

    // Connection record at the end of MAKE_UP.
    if (wf.phase === 'MAKE_UP' && wf.elapsed === wf.dur - 1) {
        const fail = wf.cycleIndex % 4 === 3;
        events.push({ type: 'connection', payload: {
            peakTorque: rig.lastMakeupPeak, result: fail ? 'FAIL' : 'PASS',
            joint: wf.cycleIndex + 1, limit: 18000,
        } });
    }

    // Unified current alarm snapshot (mirrors the edge's alarms.evaluate output: the
    // latest alarm event always carries the FULL current counts, so conditions clear
    // correctly). ESD/lockout are read-only P1 indications — never actuated.
    const p1 = (esd || lockout) ? 1 : 0;
    const p2 = tubing > 200 ? 1 : 0;
    const active = p1 + p2;
    const highest = p1 ? 'P1' : (p2 ? 'P2' : null);
    const sig = `${active}|${p1}|${p2}`;
    if (sig !== rig.lastAlarmSig) {
        rig.lastAlarmSig = sig;
        events.push({ type: 'alarm', payload: { active, unack: active, p1, p2, p3: 0, highest } });
    }

    return { v, events };
}

function post(rig, batch) {
    const json = Buffer.from(JSON.stringify(batch));
    const body = zlib.gzipSync(json);
    let u; try { u = new URL('/ingest', CENTRAL_URL); } catch { return; }
    const lib = u.protocol === 'https:' ? https : http;
    const headers = {
        'Content-Type': 'application/json', 'Content-Encoding': 'gzip',
        'X-Device-Id': rig.id, 'X-Schema-Version': '1.0', 'Content-Length': body.length,
    };
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
    const req = lib.request(u, { method: 'POST', headers, timeout: 8000 }, (res) => {
        res.resume();
        if (res.statusCode >= 300) console.warn(`${rig.id}: ingest HTTP ${res.statusCode}`);
    });
    req.on('error', (e) => console.warn(`${rig.id}: post error ${e.message}`));
    req.on('timeout', () => req.destroy());
    req.end(body);
}

let t = 0;
function tick() {
    t += 1;
    for (const rig of rigs) {
        // Flaky rig: 40s offline every ~3 min so it flips offline then recovers.
        if (rig.flaky && (t % 180) >= 140) { rig.sealCountdown = 0; rig.batch = { channels: [], events: [] }; continue; }

        const { v, events } = snapshot(rig, t);
        rig.batch.channels.push({ ts: new Date().toISOString(), values: v });
        for (const e of events) rig.batch.events.push({ ts: new Date().toISOString(), ...e });

        rig.sealCountdown -= 1;
        if (rig.sealCountdown <= 0) {
            // Activity event once per batch.
            if (rig._wf) rig.batch.events.push({ ts: new Date().toISOString(), type: 'activity', payload: { phase: rig._wf.phase, job: rig.well } });
            const batch = {
                seq: rig.seq++, deviceId: rig.id, schemaVersion: '1.0',
                createdAt: new Date().toISOString(),
                channels: rig.batch.channels, events: rig.batch.events,
            };
            post(rig, batch);
            rig.batch = { channels: [], events: [] };
            rig.sealCountdown = BATCH_SECONDS;
        }
    }
}

console.log(`CRMF fleet-sim: streaming ${ACTIVE} rigs -> ${CENTRAL_URL}/ingest every ${BATCH_SECONDS}s (1 Hz channels)`);
setInterval(tick, 1000);
