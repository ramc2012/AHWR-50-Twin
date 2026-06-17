import React, { useState } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
    Box, Drawer, AppBar, Toolbar, Typography, List, ListItemButton, ListItemIcon, ListItemText,
    Divider, Chip, IconButton, Menu, MenuItem, Avatar, Tooltip, Stack, Alert,
} from '@mui/material';
import {
    GridView, NotificationsActive, FactCheck, Construction, AccountTree,
    Description, Storage, Logout, Circle, Warning, Healing, ManageAccounts,
} from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';
import { FleetProvider, useFleet } from '../context/FleetContext';
import { disconnectSocket } from '../socket';
import ErrorBoundary from './ErrorBoundary';

const DRAWER = 248;
// `role` (optional) gates a nav item: only shown when can(role) is true.
const NAV = [
    { to: '/', label: 'Fleet Overview', icon: <GridView /> },
    { to: '/alarms', label: 'Alarm Command Centre', icon: <NotificationsActive /> },
    { to: '/data-quality', label: 'Data Quality', icon: <FactCheck /> },
    { to: '/workover', label: 'Workover Performance', icon: <Construction /> },
    { to: '/maintenance', label: 'Maintenance & Reliability', icon: <Healing /> },
    { to: '/governance', label: 'Governance & Rollout', icon: <AccountTree /> },
    { to: '/reports', label: 'Reports', icon: <Description /> },
    { to: '/registry', label: 'Config Registry', icon: <Storage /> },
    { to: '/users', label: 'User Access', icon: <ManageAccounts />, role: 'admin' },
];

function TopBar() {
    const { summary, connected } = useFleet();
    const { user, logout } = useAuth();
    const nav = useNavigate();
    const [anchor, setAnchor] = useState(null);

    const doLogout = () => { disconnectSocket(); logout(); nav('/login'); };
    const s = summary || {};

    return (
        <AppBar position="fixed" sx={{ width: `calc(100% - ${DRAWER}px)`, ml: `${DRAWER}px`, bgcolor: 'background.paper', borderBottom: '1px solid rgba(255,255,255,0.06)' }} elevation={0}>
            <Toolbar sx={{ gap: 2 }}>
                <Typography variant="subtitle1" fontWeight={700} sx={{ flexShrink: 0 }}>Asset Monitoring Centre</Typography>
                <Stack direction="row" spacing={1} sx={{ flexGrow: 1 }} flexWrap="wrap" useFlexGap>
                    <Chip size="small" color="success" variant="outlined" label={`${s.online ?? 0} online`} />
                    <Chip size="small" color="warning" variant="outlined" label={`${s.degraded ?? 0} degraded`} />
                    <Chip size="small" color="error" variant="outlined" label={`${s.offline ?? 0} offline`} />
                    <Chip size="small" variant="outlined" label={`${s.rigsReporting ?? 0}/${s.total ?? 0} reporting`} />
                    <Chip size="small" variant="outlined" label={`avg health ${s.avgHealth ?? 0}`} />
                </Stack>
                <Tooltip title={connected ? 'Live link up' : 'Reconnecting…'}>
                    <Circle sx={{ fontSize: 12, color: connected ? 'success.main' : 'error.main' }} />
                </Tooltip>
                <IconButton onClick={(e) => setAnchor(e.currentTarget)} size="small">
                    <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.main', fontSize: 14 }}>
                        {(user?.display || user?.username || '?').slice(0, 1).toUpperCase()}
                    </Avatar>
                </IconButton>
                <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
                    <MenuItem disabled>
                        <Box>
                            <Typography variant="body2" fontWeight={700}>{user?.display || user?.username}</Typography>
                            <Typography variant="caption" color="text.secondary">role: {user?.role}</Typography>
                        </Box>
                    </MenuItem>
                    <Divider />
                    <MenuItem onClick={doLogout}><Logout fontSize="small" sx={{ mr: 1 }} /> Sign out</MenuItem>
                </Menu>
            </Toolbar>
        </AppBar>
    );
}

// Read-only fleet alarm strip (proposal §6.1 alarm command centre; project rule:
// ESD/lockout are surfaced as alarms here — the CRMF never actuates anything).
function AlarmStrip() {
    const { summary } = useFleet();
    const nav = useNavigate();
    if (!summary || (summary.alarmsP1 ?? 0) === 0) return null;
    return (
        <Box onClick={() => nav('/alarms')} sx={{
            cursor: 'pointer', bgcolor: 'error.main', color: '#fff', px: 3, py: 0.75,
            display: 'flex', alignItems: 'center', gap: 1, fontWeight: 700,
            animation: 'crmfpulse 1.6s ease-in-out infinite',
            '@keyframes crmfpulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.78 } },
        }}>
            <Warning fontSize="small" />
            <Typography variant="body2" fontWeight={700}>
                {summary.alarmsP1} priority-1 (ESD / lockout / well-control) alarm{summary.alarmsP1 > 1 ? 's' : ''} active across the fleet — read-only
            </Typography>
        </Box>
    );
}

// Surfaces a non-401 fleet-load failure (audit #25) so an operator sees an explicit
// banner rather than a silently-empty/stale console. Self-heals via FleetContext polling.
function FleetErrorBanner() {
    const { error } = useFleet();
    if (!error) return null;
    return (
        <Box sx={{ px: 3, pt: 2 }}>
            <Alert severity="warning">Live fleet data unavailable — {error}. Retrying automatically.</Alert>
        </Box>
    );
}

function NavDrawer() {
    const nav = useNavigate();
    const loc = useLocation();
    const { can } = useAuth();
    const isActive = (to) => to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(to);
    const items = NAV.filter((n) => !n.role || can(n.role));
    return (
        <Drawer variant="permanent" sx={{ width: DRAWER, flexShrink: 0,
            '& .MuiDrawer-paper': { width: DRAWER, boxSizing: 'border-box', bgcolor: '#0d1526', borderRight: '1px solid rgba(255,255,255,0.06)' } }}>
            <Toolbar sx={{ flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'center', py: 1 }}>
                <Typography variant="h6" fontWeight={900} letterSpacing={1}>CRMF</Typography>
                <Typography variant="caption" color="text.secondary">ONGC · AHWR Fleet</Typography>
            </Toolbar>
            <Divider />
            <List sx={{ px: 1 }}>
                {items.map((n) => (
                    <ListItemButton key={n.to} selected={isActive(n.to)} onClick={() => nav(n.to)}
                        sx={{ borderRadius: 2, mb: 0.5, '&.Mui-selected': { bgcolor: 'rgba(62,166,255,0.15)' } }}>
                        <ListItemIcon sx={{ minWidth: 38, color: isActive(n.to) ? 'primary.main' : 'text.secondary' }}>{n.icon}</ListItemIcon>
                        <ListItemText primary={n.label} primaryTypographyProps={{ fontSize: 14, fontWeight: isActive(n.to) ? 700 : 500 }} />
                    </ListItemButton>
                ))}
            </List>
            <Box sx={{ mt: 'auto', p: 2 }}>
                <Chip size="small" color="info" variant="outlined" label="Monitoring-only · read-only" sx={{ width: '100%' }} />
                <Typography variant="caption" color="text.secondary" display="block" mt={1}>
                    No write path to any rig PLC.
                </Typography>
            </Box>
        </Drawer>
    );
}

export default function Layout() {
    // Key the boundary on the route so navigating to a different view clears a
    // previously-caught error (a fresh panel gets a fresh boundary).
    const loc = useLocation();
    return (
        <FleetProvider>
            <Box sx={{ display: 'flex', minHeight: '100vh' }}>
                <NavDrawer />
                <Box sx={{ flexGrow: 1, width: `calc(100% - ${DRAWER}px)` }}>
                    <TopBar />
                    <Toolbar />
                    <AlarmStrip />
                    <FleetErrorBanner />
                    <Box sx={{ p: 3 }}>
                        <ErrorBoundary key={loc.pathname} label="This panel">
                            <Outlet />
                        </ErrorBoundary>
                    </Box>
                </Box>
            </Box>
        </FleetProvider>
    );
}
