'use strict';
// Idempotent seed for a demonstrable fleet: 50-rig registry around the Ankleshwar
// Asset at varied rollout stages (proposal §6.2 rig master, §8 stage-gate plan),
// the standard tag dictionary, default portal users, and §7 value-realization KPIs.
const { query } = require('./db');
const { hash } = require('./auth');
const { TAGS } = require('./tags');

const FLEET_SIZE = Number(process.env.FLEET_SIZE || 50);
const ANK_LAT = 21.628, ANK_LON = 73.014; // Ankleshwar Asset, Gujarat

// Stage-gate distribution across the fleet (demonstrates rollout governance).
function plan(n) {
    if (n <= 10) return { gate: 'live', commissioning: 'commissioned', site: true, sec: true, adopt: 78 + (n % 5) * 4, ver: 'v1.4.1', wave: 1 };
    if (n <= 16) return { gate: 'operation', commissioning: 'commissioned', site: true, sec: true, adopt: 50 + (n % 4) * 7, ver: 'v1.4.0', wave: 2 };
    if (n <= 24) return { gate: 'implementation', commissioning: 'in_progress', site: true, sec: true, adopt: 20 + (n % 4) * 6, ver: 'v1.3.2', wave: 3 };
    if (n <= 34) return { gate: 'discovery', commissioning: 'in_progress', site: (n % 2 === 0), sec: false, adopt: (n % 3) * 5, ver: null, wave: 4 };
    return { gate: 'gate0', commissioning: 'planned', site: false, sec: false, adopt: 0, ver: null, wave: 5 };
}

async function seedRigs() {
    for (let n = 1; n <= FLEET_SIZE; n++) {
        const rigId = `AHWR-50-${n}`;
        const name = `AHWR-${String(n).padStart(2, '0')}`;
        const p = plan(n);
        // Cluster the rigs across the field with a deterministic spiral so the map reads as an oilfield.
        const ang = n * 2.39996, rad = 0.02 + (n % 12) * 0.012;
        const lat = ANK_LAT + Math.sin(ang) * rad + ((n % 5) - 2) * 0.006;
        const lon = ANK_LON + Math.cos(ang) * rad + ((n % 7) - 3) * 0.006;
        await query(
            `INSERT INTO rigs (rig_id, name, section, field, latitude, longitude, commissioned_at, status, schema_version)
             VALUES ($1,$2,'Workover Services','Ankleshwar',$3,$4,$5,$6,'1.0')
             ON CONFLICT (rig_id) DO NOTHING`,
            [rigId, name, Number(lat.toFixed(5)), Number(lon.toFixed(5)),
             p.commissioning === 'commissioned' ? '2026-01-15' : null,
             p.gate === 'gate0' || p.gate === 'discovery' ? 'pending' : 'offline']);
        await query(
            `INSERT INTO deployment_status (rig_id, gate, commissioning, site_ready, security_review, adoption_pct, edge_version, wave)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (rig_id) DO NOTHING`,
            [rigId, p.gate, p.commissioning, p.site, p.sec, p.adopt, p.ver, p.wave]);
    }
}

async function seedTags() {
    for (const t of TAGS) {
        await query(
            `INSERT INTO tags (metric, label, unit, group_name, expected)
             VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (metric) DO UPDATE SET label = EXCLUDED.label, unit = EXCLUDED.unit,
               group_name = EXCLUDED.group_name, expected = EXCLUDED.expected`,
            [t.metric, t.label, t.unit, t.group, t.expected]);
    }
}

async function seedUsers() {
    const { rows } = await query('SELECT count(*)::int AS c FROM users');
    if (rows[0].c > 0) return;
    // All seed passwords are env-overridable (audit #8/#13) so demo creds don't
    // survive into a pilot. Defaults remain for the local docker-compose demo.
    const adminPw = process.env.ADMIN_PASSWORD || 'admin123';
    const operatorPw = process.env.OPERATOR_PASSWORD || 'operator123';
    const viewerPw = process.env.VIEWER_PASSWORD || 'viewer123';
    const users = [
        ['admin', adminPw, 'Asset Administrator', 'admin'],
        ['operator', operatorPw, 'Monitoring Operator', 'operator'],
        ['viewer', viewerPw, 'Management Viewer', 'viewer'],
    ];
    for (const [u, pw, d, role] of users) {
        await query('INSERT INTO users (username, password, display, role, source) VALUES ($1,$2,$3,$4,$5)',
            [u, hash(pw), d, role, 'local']);
    }
}

async function seedValueMetrics() {
    const { rows } = await query('SELECT count(*)::int AS c FROM value_metrics');
    if (rows[0].c > 0) return;
    const vm = [
        ['NPT % per AHWR', 'Operations', 14, 11.5, 12.8, '%', '24-month'],
        ['Job cycle time (rig-up→down)', 'Operations', 100, 87, 94, 'index', '24-month'],
        ['HPU breakdowns during ops', 'Reliability', 100, 70, 82, 'index', '24-month'],
        ['PM compliance', 'Reliability', 71, 95, 88, '%', '24-month'],
        ['Manual reporting effort', 'Efficiency', 100, 30, 41, 'index', '24-month'],
        ['Data availability to mgmt', 'Visibility', 0, 100, 96, '%', 'live'],
        ['Per-rig data-freshness score', 'Data quality', 0, 98, 94, '%', 'live'],
    ];
    for (const v of vm) {
        await query(
            `INSERT INTO value_metrics (kpi, category, baseline, target, actual, unit, period)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`, v);
    }
}

async function seedGovernanceExtras() {
    const { rows } = await query('SELECT count(*)::int AS c FROM escalations');
    if (rows[0].c === 0) {
        await query(`INSERT INTO escalations (rig_id, title, severity, status, owner, notes) VALUES
            ('AHWR-50-21','Cellular link unstable — sync lag > 10 min during peak','high','open','Instrumentation','Dual-SIM failover not provisioned; VSAT survey requested'),
            ('AHWR-50-28','PLC tag access pending vendor approval','medium','in_progress','Asset OT','Read-only tap design submitted for security review'),
            ('AHWR-50-33','Panel temperature alarms during commissioning','low','open','Site team','Ventilation kit dispatched')`);
    }
    const d = await query('SELECT count(*)::int AS c FROM decisions');
    if (d.rows[0].c === 0) {
        await query(`INSERT INTO decisions (title, detail, author) VALUES
            ('Adopt TimescaleDB as canonical central store','Ratified per architecture review; continuous aggregates for 1s→1m→1h rollups','Architecture Board'),
            ('Standard edge kit ratified for fleet','Single BoQ prevents fragmented parallel development across rigs','Instrumentation Section')`);
    }
}

// Maintenance & Reliability sample records (audit #7 / proposal §6.1). Seeded
// against commissioned rigs so the PM-compliance/overdue/breakdown KPIs read as a
// live module rather than the static governance value-realization figures.
async function seedMaintenance() {
    // Guard on table existence so the backend still boots if the SCHEMA agent's
    // maintenance_record table has not been applied yet (defensive, idempotent).
    const reg = await query("SELECT to_regclass('public.maintenance_record') AS t");
    if (!reg.rows[0] || !reg.rows[0].t) {
        console.warn('Seed: maintenance_record table not present yet — skipping maintenance seed.');
        return;
    }
    const { rows } = await query('SELECT count(*)::int AS c FROM maintenance_record');
    if (rows[0].c > 0) return;

    // [rig#, type, title, status, dueOffsetDays(null=none), performedOffsetDays(null=none), runtimeHours, outcome, notes]
    const recs = [
        [1,  'PM',          'Quarterly HPU preventive maintenance', 'done',        -20, -18, 2100, 'pass', 'Filters + hydraulic oil replaced'],
        [2,  'PM',          'Drawworks brake inspection PM',        'done',        -12, -12, 1850, 'pass', 'Brake linings within tolerance'],
        [3,  'calibration', 'Hookload sensor calibration',          'done',        -30, -29, null, 'pass', 'Calibrated against reference load cell'],
        [4,  'PM',          'Monthly rotary table PM',              'overdue',      -5,  null, 2400, null,  'Awaiting spare bearing kit'],
        [5,  'breakdown',   'HPU pump seal failure',                'done',        null, -3,  2600, 'repaired', 'Seal kit replaced; 6h NPT'],
        [6,  'inspection',  'Wireline BOP visual inspection',       'open',         7,   null, null, null,  'Scheduled with OEM technician'],
        [7,  'PM',          'Top-drive gearbox oil change',         'in_progress',  2,   null, 1990, null,  'Oil sample sent for analysis'],
        [8,  'calibration', 'HTD torque transducer calibration',    'open',         10,  null, null, null,  'Calibration certificate due'],
        [9,  'breakdown',   'Mud pump liner washout',               'done',        null, -8,  2750, 'repaired', 'Liner + piston replaced'],
        [10, 'PM',          'Annual structural integrity PM',       'open',         21,  null, 3100, null,  'Third-party NDT planned'],
        [12, 'inspection',  'Crown block sheave inspection',        'overdue',     -2,  null, 2200, null,  'Access platform required'],
        [14, 'PM',          'Diesel genset 500h service',           'done',        -40, -39, 500,  'pass', 'Routine service completed'],
    ];

    for (const [n, type, title, status, dueOff, perfOff, runtime, outcome, notes] of recs) {
        const rigId = `AHWR-50-${n}`;
        const dueExpr = dueOff == null ? null : new Date(Date.now() + dueOff * 86400000).toISOString().slice(0, 10);
        const perfExpr = perfOff == null ? null : new Date(Date.now() + perfOff * 86400000).toISOString();
        await query(
            `INSERT INTO maintenance_record
               (rig_id, type, title, status, due_date, performed_at, runtime_hours, outcome, notes)
             SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9
             WHERE EXISTS (SELECT 1 FROM rigs WHERE rig_id = $1)`,
            [rigId, type, title, status, dueExpr, perfExpr, runtime, outcome, notes]);
    }
}

// Seed a demo webhook notification channel when NOTIFY_DEMO_WEBHOOK_URL is set
// (compose points it at the notify-sink), so P1 alerts are demonstrable end-to-end.
async function seedNotificationChannels() {
    const url = process.env.NOTIFY_DEMO_WEBHOOK_URL;
    if (!url) return;
    const { rows } = await query('SELECT count(*)::int AS c FROM notification_channels');
    if (rows[0].c > 0) return;
    await query(
        `INSERT INTO notification_channels (type, name, target, min_severity, enabled)
         VALUES ('webhook', 'Demo webhook (notify-sink)', $1, 'P1', true)`, [url]);
}

async function seedAll() {
    await seedRigs();
    await seedTags();
    await seedUsers();
    await seedValueMetrics();
    await seedGovernanceExtras();
    await seedMaintenance();
    await seedNotificationChannels();
    console.log(`Seed complete: ${FLEET_SIZE}-rig registry, tag dictionary, users, value metrics, maintenance records.`);
}

module.exports = { seedAll };
