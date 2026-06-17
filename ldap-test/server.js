'use strict';
// Mock Active Directory / LDAP server for LOCAL DEMO ONLY — stands in for a Windows
// Domain Controller so the backend's real ldapts bind+search auth path can be verified
// end-to-end (no external image needed). Speaks the LDAP wire protocol via ldapjs.
const ldap = require('ldapjs');

const ROOT = 'dc=ahwr,dc=local';
const USERS_OU = `ou=users,${ROOT}`;
const ADMIN_DN = `cn=admin,${ROOT}`;
const ADMIN_PW = process.env.LDAP_ADMIN_PASSWORD || 'adminpassword';

// Seeded domain users + AD group membership (drives the app role mapping).
const USERS = [
    { uid: 'driller1', name: 'Driller One', pw: 'Driller@123', groups: ['rig-operators'] },
    { uid: 'toolpusher1', name: 'Toolpusher One', pw: 'Push@123', groups: ['rig-admins'] },
    { uid: 'viewer1', name: 'Asset Viewer', pw: 'View@123', groups: ['rig-viewers'] },
].map((u) => ({
    ...u,
    dn: `cn=${u.uid},${USERS_OU}`,
    attributes: {
        objectClass: ['inetOrgPerson', 'user'],
        uid: u.uid, cn: u.uid, sAMAccountName: u.uid, displayName: u.name, sn: u.name,
        userPrincipalName: `${u.uid}@ahwr.local`,
        memberOf: u.groups.map((g) => `cn=${g},ou=groups,${ROOT}`),
    },
}));

const norm = (dn) => String(dn).replace(/,\s+/g, ',').toLowerCase().trim();
const byDn = new Map([[norm(ADMIN_DN), { pw: ADMIN_PW }], ...USERS.map((u) => [norm(u.dn), u])]);

const server = ldap.createServer();

// Bind: verify the password for the admin (service account) or a user DN.
server.bind(ROOT, (req, res, next) => {
    const dn = norm(req.dn.toString());
    const rec = byDn.get(dn);
    const pw = req.credentials;
    if (rec && pw && pw === rec.pw) { res.end(); return next(); }
    return next(new ldap.InvalidCredentialsError());
});

// Search: return matching user entries (used by the service-account search flow).
server.search(ROOT, (req, res, next) => {
    for (const u of USERS) {
        if (req.filter.matches(u.attributes)) {
            res.send({ dn: u.dn, attributes: u.attributes });
        }
    }
    res.end();
    return next();
});

server.on('error', (e) => console.error('MOCK-LDAP server error:', e.message));
// Belt-and-suspenders: never let a malformed packet from a client kill the mock.
process.on('uncaughtException', (e) => console.error('MOCK-LDAP uncaught:', e.message));

const PORT = Number(process.env.LDAP_PORT || 1389);
server.listen(PORT, '0.0.0.0', () => console.log(`MOCK-LDAP (AD stand-in) listening on ldap://0.0.0.0:${PORT}  base=${ROOT}`));
