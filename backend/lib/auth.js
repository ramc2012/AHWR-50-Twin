'use strict';
// Authentication & authorization helpers: bcrypt password hashing + signed JWTs.
// Replaces the previous "mock-jwt" string and plaintext password comparison.
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 16) {
    console.error('FATAL: JWT_SECRET env var is missing or too short (>=16 chars required). Refusing to start.');
    process.exit(1);
}
const JWT_EXPIRES = process.env.JWT_EXPIRES || '8h';
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);
const MCP_BACKEND_TOKEN = process.env.MCP_BACKEND_TOKEN || '';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

if (MCP_BACKEND_TOKEN && MCP_BACKEND_TOKEN.length < 32) {
    throw new Error('MCP_BACKEND_TOKEN must be at least 32 characters when configured.');
}

const hashPassword = (pw) => bcrypt.hashSync(String(pw), BCRYPT_ROUNDS);
const verifyPassword = (pw, hash) => {
    try { return bcrypt.compareSync(String(pw), String(hash)); } catch { return false; }
};
// Detect an already-bcrypt-hashed value so we can migrate legacy plaintext on load.
const isHashed = (s) => typeof s === 'string' && /^\$2[aby]\$/.test(s);

const signToken = (user) => jwt.sign(
    { sub: user.id, username: user.username, role: user.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES }
);
const verifyToken = (token) => jwt.verify(token, JWT_SECRET);

const extractBearer = (header) => {
    if (typeof header !== 'string') return null;
    if (!header.startsWith('Bearer ')) return null;
    const t = header.slice(7).trim();
    return t || null;
};

const secureEqual = (actual, expected) => {
    const a = Buffer.from(String(actual));
    const b = Buffer.from(String(expected));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const isMcpServiceToken = (token) =>
    MCP_BACKEND_TOKEN.length >= 32 && secureEqual(token, MCP_BACKEND_TOKEN);

// Express middleware: require a valid token on the route.
const requireAuth = (req, res, next) => {
    const token = extractBearer(req.headers['authorization']);
    if (!token) return res.status(401).json({ error: 'Authentication required' });
    if (isMcpServiceToken(token)) {
        if (!SAFE_METHODS.has(req.method)) {
            return res.status(403).json({ error: 'MCP service credential is read-only' });
        }
        req.user = { sub: 'mcp-readonly', username: 'mcp-readonly', role: 'viewer', source: 'service' };
        req.authKind = 'mcp-service';
        return next();
    }
    try {
        req.user = verifyToken(token);
        return next();
    } catch (e) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
};

// Express middleware factory: require one of the given roles (after requireAuth).
const requireRole = (...roles) => (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
        return res.status(403).json({ error: 'Insufficient privileges' });
    }
    return next();
};

// Socket.io handshake middleware: token via auth payload or Authorization header.
const socketAuth = (socket, next) => {
    const token = (socket.handshake.auth && socket.handshake.auth.token) ||
        extractBearer(socket.handshake.headers['authorization']);
    if (!token) return next(new Error('Authentication required'));
    try {
        socket.user = verifyToken(token);
        return next();
    } catch (e) {
        return next(new Error('Invalid or expired token'));
    }
};

module.exports = {
    hashPassword, verifyPassword, isHashed,
    signToken, verifyToken,
    requireAuth, requireRole, socketAuth,
    JWT_EXPIRES,
};
