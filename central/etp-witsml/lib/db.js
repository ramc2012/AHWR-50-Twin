'use strict';
// PostgreSQL / TimescaleDB pool (the CMF historian). Connects as the
// least-privilege application role (crmf_app), like the backend.
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.PGHOST || 'timescaledb',
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'crmf',
    user: process.env.PGUSER || 'crmf_app',
    password: process.env.PGPASSWORD,
    max: Number(process.env.PGPOOL_MAX || 10),
});
pool.on('error', (e) => console.error('[db] idle client error:', e.message));

module.exports = { pool };
