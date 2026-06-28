'use strict';
// Server-side derived drilling KPIs. The HMI/clients only CONSUME these (no
// client-side math), and because they live in the rig-data payload they are
// also alarmable via the parameter catalog (_kpi.*). Formulas mirror what the
// overview previously computed in the browser.
//
// Assumed engineering constants (NOT in telemetry — tune per rig if needed).
const BIT_DIA_M = 8.5 * 0.0254;          // 8½" bit
const PIPE_OD_M = 5.0 * 0.0254;          // 5" drillpipe
const A_BIT = Math.PI / 4 * BIT_DIA_M ** 2;
const A_ANN = Math.PI / 4 * (BIT_DIA_M ** 2 - PIPE_OD_M ** 2);
const MUD_BASE_KGM3 = 1200;              // base mud weight for ECD estimate
const CO2_KG_PER_L = 2.68;               // diesel CO₂ factor (kg/L)
const PSI_PER_BAR = 14.5038;
const HIST_MAX = 60;                      // ~1 min of 1 Hz samples

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const round = (v, d = 2) => { const p = 10 ** d; return Math.round(num(v) * p) / p; };

// Rolling state across ticks (server holds it so the client is stateless).
let sppHist = [];
let hookMin = Infinity;

// Stateless KPI computation (used for the no-sensor branch / one-offs).
function compute(data) {
    const d = data.drilling || {}, dw = data.drawworks || {}, mp = data.mudpump || {},
        fl = data.fluid || {}, htd = data.htd || {}, cat = data.cat_engine || {},
        wc = data.well_control || {}, eff = data._efficiency || {};

    const wob = num(d.wob), rpm = num(d.rpm), rop = num(d.rop), torqueDaNm = num(htd.torque);

    // Mechanical Specific Energy (Teale, SI) -> MPa.
    let mse = 0;
    if (rop > 0) {
        const wobN = wob * 9806.65, tNm = torqueDaNm * 10, nRps = rpm / 60, ropMps = rop / 3600;
        mse = Math.min(600, (wobN / A_BIT + (2 * Math.PI * nRps * tNm) / (A_BIT * ropMps)) / 1e6);
    }
    const annVel = num(mp.flow_in) / 60000 / A_ANN;                         // L/min -> m/s
    const holeDepth = Math.max(num(d.hole_depth), 1);
    const ecd = MUD_BASE_KGM3 + (num(wc.annular_pressure) * 6894.76) / (9.81 * holeDepth);
    const sppPsi = num(mp.pressure) * PSI_PER_BAR;
    const tRatio = clamp01(1 - 0.25 / Math.max(annVel, 0.01));              // transport ratio (slip≈0.25 m/s)
    const co2 = num(eff.fuelLph != null ? eff.fuelLph : cat.fuel_rate) * CO2_KG_PER_L;
    const powerKw = num(eff.engineKw);
    const driveEff = num((eff.circuits || []).find((x) => x.id === 'htd_rot')?.efficiency);
    const friction = clamp01(num(d.torque) / Math.max(wob * 60, 1));        // torque/WOB proxy
    const kickConf = clamp01(0.45 * clamp01(num(fl.tank_gain_loss) / 3) + 0.55 * clamp01((num(mp.flow_out) - 95) / 8));
    const lossConf = clamp01(-num(fl.tank_gain_loss) / 3);

    return {
        mse: round(mse, 1), ann_velocity: round(annVel, 3), ecd: round(ecd, 0), spp_psi: round(sppPsi, 0),
        transport_ratio: round(tRatio, 2), co2_kgph: round(co2, 0), power_kw: round(powerKw, 0),
        drive_eff_pct: round(driveEff, 0), friction: round(friction, 2),
        kick_confidence: round(kickConf, 2), loss_confidence: round(lossConf, 2),
    };
}

// Stateful update (call once per poll). Adds rolling-window KPIs.
function update(data, nowMs) {
    const k = compute(data);

    // SPP deviation vs a rolling baseline (%).
    sppHist.push(k.spp_psi);
    if (sppHist.length > HIST_MAX) sppHist.shift();
    const base = sppHist.length ? sppHist.reduce((s, v) => s + v, 0) / sppHist.length : k.spp_psi;
    k.spp_baseline_psi = round(base, 0);
    k.spp_dev_pct = base > 0 ? round(((k.spp_psi - base) / base) * 100, 0) : 0;

    // Overpull above the rolling free-rotating hookload baseline (t).
    const hl = num(data.drawworks?.hook_load);
    if (hl > 1) hookMin = Math.min(hookMin, hl);
    k.overpull = round(Math.max(0, hl - (Number.isFinite(hookMin) ? hookMin : hl)), 1);

    return k;
}

// Reset rolling state (e.g. on well change).
function reset() { sppHist = []; hookMin = Infinity; }

module.exports = { update, compute, reset };
