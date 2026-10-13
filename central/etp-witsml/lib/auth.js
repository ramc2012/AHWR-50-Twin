'use strict';
// Authentication of the ETP WebSocket upgrade (RFC 7235 Authorization header,
// as ETP v1.2 section 4.1.4 requires):
//   Basic <rig id>:<device token>  a rig edge; same per-rig credential and
//                                  constant-time check as the backend's /ingest.
//                                  May load data and put objects for ITS rig only.
//   Bearer <CMF JWT>               a portal user (backend /api/auth/login), role
//                                  viewer or above: read-only access.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { pool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || '';
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

function tokenEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ab = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (!ab.length || ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
}

/** @returns { kind: 'edge', rigId } | { kind: 'user', user, role } | null */
async function authenticate(header) {
    const h = String(header || '');
    if (h.startsWith('Basic ')) {
        const raw = Buffer.from(h.slice(6).trim(), 'base64').toString('utf8');
        const i = raw.indexOf(':');
        if (i <= 0) return null;
        const rigId = raw.slice(0, i);
        const token = raw.slice(i + 1);
        const { rows } = await pool.query('SELECT device_token FROM rigs WHERE rig_id = $1', [rigId]);
        if (!rows[0] || !rows[0].device_token || !tokenEquals(token, rows[0].device_token)) return null;
        return { kind: 'edge', rigId };
    }
    if (h.startsWith('Bearer ') && JWT_SECRET) {
        try {
            const user = jwt.verify(h.slice(7).trim(), JWT_SECRET);
            if ((ROLE_RANK[user.role] || 0) < ROLE_RANK.viewer) return null;
            return { kind: 'user', user: user.username || user.sub || 'user', role: user.role };
        } catch { return null; }
    }
    return null;
}

module.exports = { authenticate, tokenEquals };
