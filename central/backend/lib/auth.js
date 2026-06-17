'use strict';
// Authentication + RBAC for the fleet portal (proposal §6.5).
// Local accounts (bcrypt) with a break-glass admin; ONGC AD/SSO (Keycloak) federates
// on top in production. Roles: admin | operator | viewer.
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query } = require('./db');
const { verifyOidc } = require('./oidc');

// Fail-fast on a weak/placeholder signing secret (audit #13): an unset or
// well-known secret lets anyone forge an admin HS256 token (full RBAC bypass).
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'change-me-in-production') {
    throw new Error(
        'JWT_SECRET is unset or uses the insecure placeholder — refusing to start. ' +
        'Set a strong, unique JWT_SECRET (see .env.example).');
}
const TOKEN_TTL = process.env.TOKEN_TTL || '12h';
const OIDC_ENABLED = process.env.OIDC_ENABLED === 'true';
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };

async function login(username, password) {
    if (!username || !password) return null;
    const { rows } = await query('SELECT * FROM users WHERE username = $1', [username]);
    const u = rows[0];
    if (!u) return null;
    // Reject disabled accounts (audit #8) — column added by the SCHEMA agent.
    if (u.disabled === true) return null;
    const ok = await bcrypt.compare(password, u.password);
    if (!ok) return null;
    const user = { username: u.username, display: u.display || u.username, role: u.role, source: u.source };
    const token = jwt.sign(user, JWT_SECRET, { expiresIn: TOKEN_TTL });
    return { token, user };
}

function verify(token) {
    try { return jwt.verify(token, JWT_SECRET); } catch { return null; }
}

// Auth middleware. Tries the local JWT first (existing behaviour); when
// OIDC_ENABLED, falls back to verifying a Keycloak bearer token. Async-safe.
function requireAuth(req, res, next) {
    (async () => {
        const hdr = req.headers.authorization || '';
        const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'unauthorized' });

        let user = verify(token);
        if (!user && OIDC_ENABLED) user = await verifyOidc(token);
        if (!user) return res.status(401).json({ error: 'unauthorized' });

        req.user = user;
        next();
    })().catch(() => res.status(401).json({ error: 'unauthorized' }));
}

function requireRole(min) {
    return (req, res, next) => {
        if (!req.user || (ROLE_RANK[req.user.role] || 0) < (ROLE_RANK[min] || 99)) {
            return res.status(403).json({ error: 'forbidden' });
        }
        next();
    };
}

// True when the user's role meets/exceeds the required minimum, mirroring
// requireRole's defaults (unknown user role => 0, unknown minimum => 99) so
// callers can build their own audited RBAC checks. (audit #14)
function roleMeets(userRole, min) {
    return (ROLE_RANK[userRole] || 0) >= (ROLE_RANK[min] || 99);
}

// Socket.IO handshake auth (mirrors the edge app's token-in-auth pattern).
function socketAuth(socket, next) {
    const token = socket.handshake.auth?.token;
    const user = token && verify(token);
    if (!user) return next(new Error('unauthorized'));
    socket.user = user;
    next();
}

const hash = (pw) => bcrypt.hashSync(pw, 10);

module.exports = { login, verify, requireAuth, requireRole, roleMeets, socketAuth, hash };
