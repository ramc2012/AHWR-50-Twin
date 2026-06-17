'use strict';
// PostgreSQL / TimescaleDB connection pool for the CRMF.
// The schema itself is created by db/init.sql on first container start; here we
// only connect and wait until the database is reachable (compose ordering can
// race the DB becoming ready even with depends_on: healthy).
const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.PGHOST || 'timescaledb',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'crmf',
    password: process.env.PGPASSWORD || 'crmf',
    database: process.env.PGDATABASE || 'crmf',
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
});

pool.on('error', (err) => console.error('PG pool error:', err.message));

const query = (text, params) => pool.query(text, params);

// Block until the DB answers a trivial query (bounded retry on boot).
async function waitForDb(retries = 30, delayMs = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            await pool.query('SELECT 1');
            // init.sql may still be applying on a brand-new volume — wait for a core table.
            await pool.query('SELECT 1 FROM rigs LIMIT 1').catch(() => {
                throw new Error('schema not ready');
            });
            return;
        } catch (e) {
            console.log(`Waiting for TimescaleDB (${i + 1}/${retries}): ${e.message}`);
            await new Promise((r) => setTimeout(r, delayMs));
        }
    }
    throw new Error('TimescaleDB not reachable / schema not initialised');
}

module.exports = { pool, query, waitForDb };
