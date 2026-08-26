import React, { useState, useCallback, useEffect } from 'react';
import { Outlet, useNavigate, useLocation } from 'react-router-dom';
import {
    Box, Drawer, AppBar, Toolbar, Typography, List, ListItemButton, ListItemIcon, ListItemText,
    ListSubheader, Divider, Chip, IconButton, Menu, MenuItem, Avatar, Tooltip, Stack, Alert,
    Badge, ButtonBase,
} from '@mui/material';
import {
    GridView, NotificationsActive, FactCheck, Construction, AccountTree,
    Description, Storage, Logout, Circle, Warning, Healing, ManageAccounts,
    MenuOpen, Menu as MenuIcon, ShieldOutlined, Tune, People, Water,
    VolumeUp, VolumeOff,
} from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';
import { FleetProvider, useFleetStatus } from '../context/FleetContext';
import { disconnectSocket } from '../socket';
import { api } from '../api';
import ErrorBoundary from './ErrorBoundary';

const DRAWER = 248;          // expanded width
const DRAWER_MINI = 72;      // collapsed (icon-only) width

// Nav grouped into labelled sections (audit UI-32). `role` (optional) gates a nav
// item: only shown when can(role) is true. `alarmBadge` marks the item that carries
// the live alarm-count Badge.
const NAV_SECTIONS = [
    {
        label: 'Operations',
        items: [
            { to: '/', label: 'Fleet Overview', icon: <GridView /> },
            { to: '/wells', label: 'Wells', icon: <Water /> },
            { to: '/alarms', label: 'Alarm Command Centre', icon: <NotificationsActive />, alarmBadge: true },
            { to: '/data-quality', label: 'Data Quality', icon: <FactCheck /> },
        ],
    },
    {
        label: 'Performance',
        items: [
            { to: '/workover', label: 'Workover Performance', icon: <Construction /> },
            { to: '/maintenance', label: 'Maintenance & Reliability', icon: <Healing /> },
            { to: '/governance', label: 'Governance & Rollout', icon: <AccountTree /> },
            { to: '/reports', label: 'Reports', icon: <Description /> },
        ],
    },
    {
        label: 'Administration',
        items: [
            { to: '/registry', label: 'Config Registry', icon: <Storage /> },
            { to: '/users', label: 'User Access', icon: <ManageAccounts />, role: 'admin' },
            { to: '/settings', label: 'Settings', icon: <Tune />, role: 'admin' },
        ],
    },
];

// User-liveness: best-effort heartbeat (~30s) keeping this user's session fresh,
// plus a poll (~15s) of who else is online. Errors are swallowed — presence is
// non-critical and self-heals on the next tick.
function usePresence() {
    const [onlineCount, setOnlineCount] = useState(0);
    useEffect(() => {
        let alive = true;
        const ping = () => { api.pingPresence().catch(() => {}); };
        const refresh = () => {
            api.presence()
                .then((rows) => { if (alive) setOnlineCount((rows || []).filter((u) => u.online).length); })
                .catch(() => {});
        };
        ping(); refresh();
        const pingTimer = setInterval(ping, 30000);
        const pollTimer = setInterval(refresh, 15000);
        return () => { alive = false; clearInterval(pingTimer); clearInterval(pollTimer); };
    }, []);
    return onlineCount;
}

function TopBar({ width, collapsed, onToggle }) {
    const { summary, connected, lastUpdate, muted, toggleMute } = useFleetStatus();
    const { user, logout } = useAuth();
    const nav = useNavigate();
    const [anchor, setAnchor] = useState(null);
    const onlineUsers = usePresence();

    const doLogout = () => { disconnectSocket(); logout(); nav('/login'); };
    const s = summary || {};
    // Actionable chips (audit UI-31): status chips deep-link to the filtered Fleet
    // Overview (?filter= contract), alarm chips to the Alarm Command Centre.
    const goFilter = (f) => nav(`/?filter=${f}`);

    return (
        <AppBar position="fixed" sx={{ width: `calc(100% - ${width}px)`, ml: `${width}px`, bgcolor: 'background.paper', borderBottom: '1px solid rgba(255,255,255,0.06)', transition: 'width .2s, margin .2s' }} elevation={0}>
            <Toolbar sx={{ gap: 2 }}>
                <Tooltip title={collapsed ? 'Expand menu' : 'Collapse menu'}>
                    <IconButton onClick={onToggle} edge="start" size="small" sx={{ color: 'text.secondary' }}>
                        {collapsed ? <MenuIcon /> : <MenuOpen />}
                    </IconButton>
                </Tooltip>
                <Typography variant="subtitle1" fontWeight={700} sx={{ flexShrink: 0 }}>Asset Monitoring Centre</Typography>
                <Stack direction="row" spacing={1} sx={{ flexGrow: 1 }} flexWrap="wrap" useFlexGap>
                    <Chip size="small" color="success" variant="outlined" label={`${s.online ?? 0} online`} onClick={() => goFilter('online')} />
                    <Chip size="small" color="warning" variant="outlined" label={`${s.degraded ?? 0} degraded`} onClick={() => goFilter('degraded')} />
                    <Chip size="small" variant="outlined" label={`${s.stale ?? 0} stale`} onClick={() => goFilter('stale')} />
                    <Chip size="small" color="error" variant="outlined" label={`${s.offline ?? 0} offline`} onClick={() => goFilter('offline')} />
                    <Chip size="small" variant="outlined" label={`${s.rigsReporting ?? 0}/${s.total ?? 0} reporting`} />
                    <Chip size="small" variant="outlined" label={`avg health ${s.avgHealth ?? 0}`} />
                    {(s.alarmsP1 ?? 0) > 0 && (
                        <Chip size="small" color="error" label={`${s.alarmsP1} P1`} onClick={() => nav('/alarms')} />
                    )}
                    <Chip size="small" color="warning" variant="outlined" label={`${s.alarmsActive ?? 0} alarms`} onClick={() => nav('/alarms')} />
                </Stack>
                <Tooltip title={`${onlineUsers} user${onlineUsers === 1 ? '' : 's'} online`}>
                    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ color: 'text.secondary', flexShrink: 0 }}>
                        <People fontSize="small" />
                        <Typography variant="body2" fontWeight={700}>{onlineUsers}</Typography>
                    </Stack>
                </Tooltip>
                {/* Mute toggle for the audible P1 annunciation (audit UI-08). */}
                <Tooltip title={muted ? 'Alarm chime muted — click to unmute' : 'Alarm chime on — click to mute'}>
                    <IconButton size="small" onClick={toggleMute}
                        aria-label={muted ? 'Unmute priority-1 alarm chime' : 'Mute priority-1 alarm chime'}
                        sx={{ color: muted ? 'text.disabled' : 'text.secondary' }}>
                        {muted ? <VolumeOff fontSize="small" /> : <VolumeUp fontSize="small" />}
                    </IconButton>
                </Tooltip>
                {/* Connectivity indicator with text + aria label, plus the time of the
                    last successful data receipt (audit UI-10). */}
                <Tooltip title={connected ? 'Live link up' : 'Live link down — reconnecting'}>
                    <Stack direction="row" spacing={0.5} alignItems="center" role="status"
                        aria-label={connected ? 'Live link up' : 'Live link down — reconnecting'}
                        sx={{ color: connected ? 'success.main' : 'error.main', flexShrink: 0 }}>
                        <Circle sx={{ fontSize: 12 }} />
                        <Typography variant="caption" fontWeight={700}>{connected ? 'LIVE' : 'DOWN'}</Typography>
                    </Stack>
                </Tooltip>
                {lastUpdate && (
                    <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                        upd {new Date(lastUpdate).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </Typography>
                )}
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
// Audit UI-12: keyboard/AT-accessible ButtonBase, pulse honours prefers-reduced-motion
// and decays to steady after ~60s (re-arming whenever the P1 count changes).
function AlarmStrip() {
    const { summary } = useFleetStatus();
    const nav = useNavigate();
    const p1 = summary?.alarmsP1 ?? 0;
    const [pulsing, setPulsing] = useState(false);
    useEffect(() => {
        if (p1 > 0) {
            setPulsing(true);
            const t = setTimeout(() => setPulsing(false), 60000);
            return () => clearTimeout(t);
        }
        setPulsing(false);
        return undefined;
    }, [p1]);
    if (p1 === 0) return null;
    const label = `${p1} priority-1 (ESD / lockout / well-control) alarm${p1 > 1 ? 's' : ''} active across the fleet — read-only`;
    return (
        <ButtonBase onClick={() => nav('/alarms')} aria-label={`${label}. Open the alarm command centre.`} sx={{
            width: '100%', bgcolor: 'error.main', color: '#fff', px: 3, py: 0.75,
            display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 1, fontWeight: 700,
            animation: pulsing ? 'crmfpulse 1.6s ease-in-out infinite' : 'none',
            '@keyframes crmfpulse': { '0%,100%': { opacity: 1 }, '50%': { opacity: 0.78 } },
            '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
        }}>
            <Warning fontSize="small" />
            <Typography variant="body2" fontWeight={700}>{label}</Typography>
        </ButtonBase>
    );
}

// Surfaces a non-401 fleet-load failure (audit #25) so an operator sees an explicit
// banner rather than a silently-empty/stale console. Self-heals via FleetContext polling.
function FleetErrorBanner() {
    const { error } = useFleetStatus();
    if (!error) return null;
    return (
        <Box sx={{ px: 3, pt: 2 }}>
            <Alert severity="warning">Live fleet data unavailable — {error}. Retrying automatically.</Alert>
        </Box>
    );
}

// Audit UI-10: once the socket has been down for ~5s (FleetContext sets linkDownSince),
// tell the operator explicitly that the wall may be showing stale numbers.
function LinkDownBanner() {
    const { connected, linkDownSince } = useFleetStatus();
    if (connected || !linkDownSince) return null;
    const hhmm = new Date(linkDownSince).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return (
        <Box sx={{ px: 3, pt: 2 }}>
            <Alert severity="error">Live link down since {hhmm} — data may be stale.</Alert>
        </Box>
    );
}

function NavDrawer({ width, collapsed }) {
    const nav = useNavigate();
    const loc = useLocation();
    const { can } = useAuth();
    const { summary } = useFleetStatus();
    const isActive = (to) => to === '/' ? loc.pathname === '/' : loc.pathname.startsWith(to);
    const p1 = summary?.alarmsP1 ?? 0;
    const act = summary?.alarmsActive ?? 0;
    const sections = NAV_SECTIONS
        .map((sec) => ({ ...sec, items: sec.items.filter((n) => !n.role || can(n.role)) }))
        .filter((sec) => sec.items.length > 0);
    return (
        <Drawer variant="permanent" sx={{ width, flexShrink: 0, whiteSpace: 'nowrap', boxSizing: 'border-box',
            '& .MuiDrawer-paper': { width, boxSizing: 'border-box', bgcolor: '#0d1526', borderRight: '1px solid rgba(255,255,255,0.06)', overflowX: 'hidden', transition: 'width .2s' } }}>
            <Toolbar sx={{ flexDirection: 'column', alignItems: collapsed ? 'center' : 'flex-start', justifyContent: 'center', py: 1, px: collapsed ? 0 : 2 }}>
                <Typography variant="h6" fontWeight={900} letterSpacing={collapsed ? 0 : 1}>{collapsed ? 'C' : 'CRMF'}</Typography>
                {!collapsed && <Typography variant="caption" color="text.secondary">ONGC · AHWR Fleet</Typography>}
            </Toolbar>
            <Divider />
            {sections.map((sec, si) => (
                <List key={sec.label} dense sx={{ px: 1, py: 0.5 }} aria-label={sec.label}
                    subheader={collapsed ? undefined : (
                        <ListSubheader disableSticky sx={{ bgcolor: 'transparent', lineHeight: '28px', fontSize: 11,
                            letterSpacing: 1, textTransform: 'uppercase', color: 'text.secondary' }}>
                            {sec.label}
                        </ListSubheader>
                    )}>
                    {/* Collapsed mode has no room for subheader text — a divider marks the section break. */}
                    {collapsed && si > 0 && <Divider sx={{ mb: 0.5 }} />}
                    {sec.items.map((n) => {
                        const active = isActive(n.to);
                        // Live alarm badge on the Alarm Command Centre item (audit UI-32):
                        // red with the P1 count when any P1 is active, amber with the active
                        // count otherwise. Sits on the icon, so it survives collapsed mode.
                        const icon = n.alarmBadge ? (
                            <Badge badgeContent={p1 > 0 ? p1 : act} max={99} invisible={p1 === 0 && act === 0}
                                sx={{ '& .MuiBadge-badge': { bgcolor: p1 > 0 ? 'error.main' : 'warning.main',
                                    color: p1 > 0 ? '#fff' : 'rgba(0,0,0,0.87)', fontWeight: 700 } }}>
                                {n.icon}
                            </Badge>
                        ) : n.icon;
                        const btn = (
                            <ListItemButton key={n.to} selected={active} onClick={() => nav(n.to)}
                                sx={{ borderRadius: 2, mb: 0.5, justifyContent: collapsed ? 'center' : 'flex-start',
                                    px: collapsed ? 1 : 2, '&.Mui-selected': { bgcolor: 'rgba(62,166,255,0.15)' } }}>
                                <ListItemIcon sx={{ minWidth: 0, mr: collapsed ? 0 : 1.5, justifyContent: 'center', color: active ? 'primary.main' : 'text.secondary' }}>{icon}</ListItemIcon>
                                {!collapsed && <ListItemText primary={n.label} primaryTypographyProps={{ fontSize: 14, fontWeight: active ? 700 : 500 }} />}
                            </ListItemButton>
                        );
                        return collapsed ? <Tooltip key={n.to} title={n.label} placement="right">{btn}</Tooltip> : btn;
                    })}
                </List>
            ))}
            <Box sx={{ mt: 'auto', p: collapsed ? 1 : 2 }}>
                {collapsed ? (
                    <Tooltip title="Monitoring-only · read-only · no write path to any rig PLC" placement="right">
                        <Box sx={{ display: 'flex', justifyContent: 'center', color: 'info.main' }}><ShieldOutlined fontSize="small" /></Box>
                    </Tooltip>
                ) : (
                    <>
                        <Chip size="small" color="info" variant="outlined" label="Monitoring-only · read-only" sx={{ width: '100%' }} />
                        <Typography variant="caption" color="text.secondary" display="block" mt={1}>
                            No write path to any rig PLC.
                        </Typography>
                    </>
                )}
            </Box>
        </Drawer>
    );
}

export default function Layout() {
    // Key the boundary on the route so navigating to a different view clears a
    // previously-caught error (a fresh panel gets a fresh boundary).
    const loc = useLocation();
    const [collapsed, setCollapsed] = useState(() => localStorage.getItem('crmf_nav_collapsed') === '1');
    const toggle = useCallback(() => setCollapsed((c) => {
        const next = !c; localStorage.setItem('crmf_nav_collapsed', next ? '1' : '0'); return next;
    }), []);
    const width = collapsed ? DRAWER_MINI : DRAWER;

    return (
        <FleetProvider>
            {/* App shell: fixed sidebar + header, the content region fills the remaining
                viewport height and scrolls internally so pages can fill the real estate. */}
            <Box sx={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>
                <NavDrawer width={width} collapsed={collapsed} />
                <Box sx={{ flexGrow: 1, width: `calc(100% - ${width}px)`, transition: 'width .2s', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                    {/* Dedicated boundary for the chrome (audit UI-06): a throw in the
                        TopBar/AlarmStrip cluster degrades to a compact fallback instead of
                        blanking the whole monitoring wall. */}
                    <ErrorBoundary label="The console header" compact>
                        <TopBar width={width} collapsed={collapsed} onToggle={toggle} />
                        <Toolbar />
                        <AlarmStrip />
                        <LinkDownBanner />
                        <FleetErrorBanner />
                    </ErrorBoundary>
                    <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: { xs: 1.5, sm: 2, md: 3 } }}>
                        <ErrorBoundary key={loc.pathname} label="This panel">
                            <Outlet />
                        </ErrorBoundary>
                    </Box>
                </Box>
            </Box>
        </FleetProvider>
    );
}
