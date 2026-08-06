import React, { useState, useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import {
    LayoutDashboard,
    Activity,
    ShieldAlert,
    LineChart as ChartIcon,
    Settings,
    Edit2,
    Anchor,
    LogOut,
    Database,
    Bell,
    Wrench,
    FileText,
    HeartPulse,
    Cable,
    RefreshCw,
    ClipboardList,
    Gauge,
    MapPin,
    KeyRound,
    Menu as MenuIcon,
    PanelLeftClose,
    PanelLeftOpen
} from 'lucide-react';
import {
    Box,
    AppBar,
    Toolbar,
    Typography,
    IconButton,
    CssBaseline,
    Dialog,
    DialogTitle,
    DialogContent,
    TextField,
    DialogActions,
    Button,
    Alert,
    List,
    ListItem,
    ListItemButton,
    ListItemIcon,
    ListItemText,
    Drawer,
    Divider,
    Tooltip,
    useMediaQuery
} from '@mui/material';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { socket, connectSocket, getLatestRigData } from '../../socket';
import AlarmStrip from '../Alarms/AlarmStrip';
import { AlarmProvider } from '../../context/AlarmContext';
import ChangePasswordDialog from '../Account/ChangePasswordDialog';
import ThemeSwitcher from './ThemeSwitcher';
import OngcBrand from './OngcBrand';
import axios from '../../api';

// Collapsible left navigation rail (standard app shell). Collapsing hides the
// rail entirely, leaving only a slim edge handle to pull it back open.
const SIDEBAR_W = 244;
const SIDEBAR_KEY = 'ahwr_sidebar_collapsed';

const menuItems = [
    { text: 'Rig Overview', icon: <LayoutDashboard size={20} />, path: '/' },
    { text: 'EDR', icon: <Activity size={20} />, path: '/edr' },
    { text: 'Equipment', icon: <Database size={20} />, path: '/equipment' },
    { text: 'Activity', icon: <Activity size={20} />, path: '/activity' },
    { text: 'Alarms', icon: <Bell size={20} />, path: '/alarms' },
    { text: 'Operations', icon: <ClipboardList size={20} />, path: '/operations' },
    { text: 'Well', icon: <MapPin size={20} />, path: '/well' },
    { text: 'Reports', icon: <FileText size={20} />, path: '/reports' },
    { text: 'Maintenance', icon: <HeartPulse size={20} />, path: '/maintenance' },
    { text: 'Efficiency', icon: <Gauge size={20} />, path: '/efficiency' },
    { text: 'Edge Sync', icon: <RefreshCw size={20} />, path: '/sync' },
    { text: 'Settings', icon: <Settings size={20} />, path: '/settings' },
];

export default function Layout() {
    const location = useLocation();
    const { logout, user } = useAuth();
    const navigate = useNavigate();

    const [pwdOpen, setPwdOpen] = useState(false);
    const [connected, setConnected] = useState(socket.connected);
    // Sidebar: collapsed state persists; on small screens it becomes a temporary overlay.
    const isDesktop = useMediaQuery('(min-width:900px)');
    const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === '1');
    const [mobileNavOpen, setMobileNavOpen] = useState(false);
    const toggleCollapsed = () => setCollapsed((v) => { localStorage.setItem(SIDEBAR_KEY, v ? '0' : '1'); return !v; });

    // Live rig parameters for the top bar
    const [liveParams, setLiveParams] = useState({ opMode: 0, acsStatus: 0, holeDepth: 0, bitDepth: 0, activity: '', productive: true, stale: false });

    const getOpModeLabel = (code) => {
        switch (Number(code)) {
            case 1: return "DRILLING";
            case 2: return "TRIP IN";
            case 3: return "TRIP OUT";
            case 4: return "CASING";
            default: return "IDLE";
        }
    };

    const getAcsStatusLabel = (code) => {
        switch (Number(code)) {
            case 1: return "ON";
            case 2: return "OFF";
            case 3: return "DISABLE";
            default: return "UNKNOWN";
        }
    };

    const getOpModeColor = (code) => Number(code) === 1 ? '#4ade80' : '#38bdf8';
    const getAcsColor = (code) => Number(code) === 1 ? '#4ade80' : (Number(code) === 2 ? '#ef4444' : '#94a3b8');

    // Settings is visible to all (Variables tab is read-only for non-admins; the
    // Administration tab inside Settings is gated to admins).
    const navItems = menuItems;

    const handleLogout = () => {
        logout();
        navigate('/login');
    };

    // Well & Rig State
    const [wellInfo, setWellInfo] = useState({ well: 'WELL-001', rig: 'RIG-ALPHA' });
    // Active well from the Well registry — drives the top-bar RIG/WELL display when set.
    const [activeWell, setActiveWell] = useState(null);
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [tempInfo, setTempInfo] = useState({ well: '', rig: '' });
    const [infoError, setInfoError] = useState('');

    useEffect(() => {
        // Layout owns the socket connection lifecycle (persistent shell, post-auth).
        // It is NOT disconnected when feature pages unmount — only on logout.
        connectSocket();

        // Initial Load
        axios.get(`/api/dashboard/layout?t=${Date.now()}`)
            .then(({ data: config }) => {
                if (config.wellInfo) setWellInfo(config.wellInfo);
            })
            .catch(err => console.error("Failed to load rig info:", err));

        // Active well: drives the top-bar RIG/WELL when a well is started.
        // Poll it (no socket event for it) so the bar reflects start/complete.
        const loadActiveWell = () => {
            axios.get('/api/wells/active')
                .then(({ data }) => setActiveWell(data || null))
                .catch(err => console.error("Failed to load active well:", err));
        };
        loadActiveWell();
        const activeWellPoll = setInterval(loadActiveWell, 5000);

        // Real-time Updates
        const handleLayoutUpdate = (config) => {
            if (config.wellInfo) setWellInfo(config.wellInfo);
        };
        socket.on('dashboard_layout_update', handleLayoutUpdate);

        // Live connection-state indicator.
        const handleConnect = () => setConnected(true);
        const handleDisconnect = () => setConnected(false);
        const handleConnectError = () => setConnected(false);
        socket.on('connect', handleConnect);
        socket.on('disconnect', handleDisconnect);
        socket.on('connect_error', handleConnectError);
        setConnected(socket.connected);

        // Live rig parameters for top bar
        const handleRigData = (data) => {
            setLiveParams({
                opMode: data.drilling?.operation_mode || 0,
                acsStatus: data.acs?.status || 0,
                holeDepth: data.drilling?.hole_depth || 0,
                bitDepth: data.drilling?.bit_depth || 0,
                activity: data._activity?.label || '',
                productive: data._activity?.productive !== false,
                stale: !!data._meta?.stale,
            });
        };
        // Seed the top bar from the cache. Layout only remounts on a hard reload
        // today, but this also covers the window between connect and first tick.
        const cachedRig = getLatestRigData();
        if (cachedRig) handleRigData(cachedRig);
        socket.on('rig_data', handleRigData);

        return () => {
            // Remove ONLY our own handlers; do NOT disconnect the shared socket here.
            clearInterval(activeWellPoll);
            socket.off('dashboard_layout_update', handleLayoutUpdate);
            socket.off('connect', handleConnect);
            socket.off('disconnect', handleDisconnect);
            socket.off('connect_error', handleConnectError);
            socket.off('rig_data', handleRigData);
        };
    }, []);

    const handleEditClick = () => {
        if (user?.role !== 'admin') return;
        setTempInfo(wellInfo);
        setInfoError('');
        setIsDialogOpen(true);
    };

    const handleSaveInfo = async () => {
        if (user?.role !== 'admin') return;
        const nextInfo = {
            rig: tempInfo.rig.trim(),
            well: tempInfo.well.trim()
        };
        if (!nextInfo.rig || !nextInfo.well) {
            setInfoError('Rig name and well name are required.');
            return;
        }

        try {
            const { data } = await axios.post('/api/dashboard/layout', { wellInfo: nextInfo });
            setWellInfo(data?.config?.wellInfo || nextInfo);
            setIsDialogOpen(false);
        } catch (e) {
            console.error("Failed to save rig info", e);
            setInfoError(e.response?.data?.error || 'Failed to save rig details.');
        }
    };

    const handleNavClick = (path) => {
        navigate(path);
        setMobileNavOpen(false);   // close the overlay rail on small screens
    };

    const currentPage = navItems.find(item => item.path === location.pathname);

    // When a well is active in the Well registry, the top bar reflects it.
    // Otherwise fall back to the admin-editable dashboard wellInfo.
    const displayWell = activeWell?.name || wellInfo.well;
    const displayRig = activeWell?.rig || wellInfo.rig;

    // ---- Left navigation rail -------------------------------------------------
    const navRail = (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', bgcolor: '#0b1220' }}>
            {/* Brand: ONGC logo + company + product. Click -> Overview. */}
            <Box sx={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                gap: 1, px: 1.75, py: 1.5, minHeight: 64,
                borderBottom: '1px solid #1e293b',
            }}>
                <OngcBrand
                    size={26}
                    onClick={() => handleNavClick('/')}
                    title="ONGC — go to Rig Overview"
                />
                {isDesktop && (
                    <Tooltip title="Hide menu">
                        <IconButton onClick={toggleCollapsed} size="small" sx={{ color: '#64748b', '&:hover': { color: '#38bdf8' } }} aria-label="Hide menu">
                            <PanelLeftClose size={18} />
                        </IconButton>
                    </Tooltip>
                )}
            </Box>

            {/* Menu items */}
            <List sx={{ py: 1, flexGrow: 1, overflowY: 'auto', overflowX: 'hidden' }}>
                {navItems.map((item) => {
                    const isActive = location.pathname === item.path;
                    return (
                        <ListItem key={item.text} disablePadding sx={{ display: 'block' }}>
                            <ListItemButton
                                onClick={() => handleNavClick(item.path)}
                                sx={{
                                    mx: 1, mb: 0.25, borderRadius: 1.5, px: 1.75, py: 0.9,
                                    bgcolor: isActive ? 'rgba(56, 189, 248, 0.13)' : 'transparent',
                                    borderLeft: isActive ? '3px solid #38bdf8' : '3px solid transparent',
                                    '&:hover': { bgcolor: 'rgba(56, 189, 248, 0.08)' },
                                }}
                            >
                                <ListItemIcon sx={{ color: isActive ? '#38bdf8' : '#94a3b8', minWidth: 36 }}>
                                    {item.icon}
                                </ListItemIcon>
                                <ListItemText
                                    primary={item.text}
                                    primaryTypographyProps={{ sx: { color: isActive ? '#38bdf8' : '#e2e8f0', fontWeight: isActive ? 700 : 500, fontSize: 14 } }}
                                />
                            </ListItemButton>
                        </ListItem>
                    );
                })}
            </List>

            {/* Signed-in user */}
            {user?.username && (
                <>
                    <Divider sx={{ borderColor: '#1e293b' }} />
                    <Box sx={{ px: 2, py: 1.25 }}>
                        <Typography noWrap sx={{ fontSize: 12, fontWeight: 700, color: '#e2e8f0' }}>{user.username}</Typography>
                        <Typography noWrap sx={{ fontSize: 10, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1 }}>{user.role}</Typography>
                    </Box>
                </>
            )}
        </Box>
    );

    return (
        <AlarmProvider>
        <Box sx={{ display: 'flex', minHeight: '100vh' }}>
            <CssBaseline />

            {/* Desktop: permanent rail; when fully collapsed it disappears and
                leaves only a slim edge handle to pull it back open. */}
            {isDesktop && !collapsed && (
                <Drawer
                    variant="permanent"
                    sx={{
                        width: SIDEBAR_W, flexShrink: 0,
                        '& .MuiDrawer-paper': {
                            width: SIDEBAR_W, boxSizing: 'border-box', border: 'none',
                            borderRight: '1px solid #1e293b', bgcolor: '#0b1220', overflowX: 'hidden',
                        },
                    }}
                >
                    {navRail}
                </Drawer>
            )}

            {/* Drawer handle — the only thing left when the menu is fully collapsed */}
            {isDesktop && collapsed && (
                <Tooltip title="Open menu" placement="right">
                    <Box
                        onClick={toggleCollapsed}
                        role="button" tabIndex={0}
                        aria-label="Open navigation menu"
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') toggleCollapsed(); }}
                        sx={{
                            position: 'fixed', left: 0, top: '50%', transform: 'translateY(-50%)',
                            zIndex: (theme) => theme.zIndex.drawer + 2,
                            width: 22, height: 92, cursor: 'pointer',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            bgcolor: '#111c2e', color: '#94a3b8',
                            border: '1px solid #1e293b', borderLeft: 'none',
                            borderRadius: '0 10px 10px 0',
                            boxShadow: '2px 0 10px rgba(0,0,0,.45)',
                            transition: 'background-color .15s, color .15s, width .15s',
                            '&:hover': { bgcolor: '#16233a', color: '#38bdf8', width: 26 },
                        }}
                    >
                        <PanelLeftOpen size={15} />
                    </Box>
                </Tooltip>
            )}

            {!isDesktop && (
                <Drawer
                    variant="temporary"
                    open={mobileNavOpen}
                    onClose={() => setMobileNavOpen(false)}
                    ModalProps={{ keepMounted: true }}
                    sx={{ '& .MuiDrawer-paper': { width: SIDEBAR_W, boxSizing: 'border-box', bgcolor: '#0b1220', border: 'none' } }}
                >
                    {navRail}
                </Drawer>
            )}

            {/* Right side: top bar + alarm strip + page */}
            <Box sx={{ flexGrow: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>

            {/* Top AppBar */}
            <AppBar
                position="sticky"
                sx={{
                    top: 0,
                    bgcolor: '#0f172a',
                    borderBottom: '1px solid #334155',
                    boxShadow: 'none',
                    zIndex: (theme) => theme.zIndex.drawer - 1
                }}
            >
                <Toolbar
                    sx={{
                        gap: { xs: 1, md: 2 },
                        alignItems: 'center',
                        flexWrap: { xs: 'wrap', md: 'nowrap' },
                        minHeight: { xs: 'auto', md: 64 },
                        py: { xs: 1, md: 0 },
                        px: { xs: 1.5, sm: 2, md: 3 }
                    }}
                >
                    {/* Hamburger — opens the nav rail as an overlay on small screens */}
                    {!isDesktop && (
                        <IconButton onClick={() => setMobileNavOpen(true)} sx={{ color: '#e2e8f0', mr: 0.5 }} aria-label="Open navigation">
                            <MenuIcon size={20} />
                        </IconButton>
                    )}

                    {/* Current page title (nav itself lives in the left rail) */}
                    <Typography noWrap sx={{ fontWeight: 800, color: '#e2e8f0', fontSize: { xs: 14, sm: 17 }, mr: { xs: 0.5, md: 1.5 }, display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Box component="span" sx={{ color: '#38bdf8', display: 'flex' }}>{currentPage?.icon}</Box>
                        {currentPage?.text || 'Rig Overview'}
                    </Typography>

                    {/* Live Rig Parameters */}
                    <Box sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: { xs: 0.5, xl: 2 },
                        flexGrow: 1,
                        ml: { xs: 1, md: 2 },
                        mr: { xs: 1, md: 2 },
                        flexWrap: 'nowrap',
                        overflow: 'hidden',
                    }}>
                        {/* OP.MODE */}
                        <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center', bgcolor: '#1e293b', px: { xs: 1, sm: 3 }, height: 60, borderRadius: 1, border: '1px solid #334155', minWidth: 100 }}>
                            <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 'bold', letterSpacing: 1, fontSize: 12, lineHeight: 1.2 }}>OP.MODE</Typography>
                            <Typography variant="subtitle2" sx={{ color: getOpModeColor(liveParams.opMode), fontWeight: 'bold', fontSize: 16, lineHeight: 1.2 }}>
                                {getOpModeLabel(liveParams.opMode)}
                            </Typography>
                        </Box>
                        {/* ACS */}
                        <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center', bgcolor: '#1e293b', px: { xs: 1, sm: 3 }, height: 60, borderRadius: 1, border: '1px solid #334155', minWidth: 90 }}>
                            <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 'bold', letterSpacing: 1, fontSize: 12, lineHeight: 1.2 }}>ACS</Typography>
                            <Typography variant="subtitle2" sx={{ color: getAcsColor(liveParams.acsStatus), fontWeight: 'bold', fontSize: 16, lineHeight: 1.2 }}>
                                {getAcsStatusLabel(liveParams.acsStatus)}
                            </Typography>
                        </Box>
                        {/* TOTAL BIT DEPTH */}
                        <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center', bgcolor: '#1e293b', px: { xs: 1, sm: 3 }, height: 60, borderRadius: 1, border: '1px solid #334155', minWidth: 110 }}>
                            <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 'bold', letterSpacing: 1, fontSize: 12, lineHeight: 1.2 }}>HOLE DEPTH</Typography>
                            <Typography variant="subtitle2" sx={{ color: '#4ade80', fontWeight: 'bold', fontSize: 16, lineHeight: 1.2 }}>
                                {Number(liveParams.holeDepth).toFixed(1)}
                                <Typography component="span" variant="caption" sx={{ ml: 0.5, color: '#64748b', fontSize: 11 }}>m</Typography>
                            </Typography>
                        </Box>
                        {/* BIT DEPTH */}
                        <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center', bgcolor: '#1e293b', px: { xs: 1, sm: 3 }, height: 60, borderRadius: 1, border: '1px solid #334155', minWidth: 110 }}>
                            <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 'bold', letterSpacing: 1, fontSize: 12, lineHeight: 1.2 }}>BIT DEPTH</Typography>
                            <Typography variant="subtitle2" sx={{ color: '#38bdf8', fontWeight: 'bold', fontSize: 16, lineHeight: 1.2 }}>
                                {Number(liveParams.bitDepth).toFixed(1)}
                                <Typography component="span" variant="caption" sx={{ ml: 0.5, color: '#64748b', fontSize: 11 }}>m</Typography>
                            </Typography>
                        </Box>
                        {/* ACTIVITY (workover phase) */}
                        {liveParams.activity ? (
                            <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center', bgcolor: '#1e293b', px: { xs: 1, sm: 2.5 }, height: 60, borderRadius: 1, border: '1px solid #334155', minWidth: 120 }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 'bold', letterSpacing: 1, fontSize: 12, lineHeight: 1.2 }}>ACTIVITY</Typography>
                                <Typography noWrap variant="subtitle2" sx={{ color: liveParams.productive ? '#4ade80' : '#fbbf24', fontWeight: 'bold', fontSize: 15, lineHeight: 1.2 }}>
                                    {String(liveParams.activity).toUpperCase()}
                                </Typography>
                            </Box>
                        ) : null}
                        {/* LIVE / STALE feed indicator */}
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 0.5 }}>
                            <Box sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: !connected ? '#ef4444' : (liveParams.stale ? '#fbbf24' : '#22c55e'), boxShadow: `0 0 6px ${!connected ? '#ef4444' : (liveParams.stale ? '#fbbf24' : '#22c55e')}`, animation: (connected && !liveParams.stale) ? 'romiiLivePulse 1.6s ease-in-out infinite' : 'none' }} />
                            <Typography variant="caption" sx={{ color: '#cbd5e1', fontWeight: 'bold', letterSpacing: 1, fontSize: 12 }}>
                                {!connected ? 'OFFLINE' : (liveParams.stale ? 'STALE' : 'LIVE')}
                            </Typography>
                            <style>{'@keyframes romiiLivePulse{0%,100%{opacity:1}50%{opacity:.25}}'}</style>
                        </Box>
                    </Box>



                    {/* Right side - Connection status, Rig/Well info & Logout */}
                    <Box sx={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: { xs: 'flex-start', md: 'flex-end' },
                        gap: { xs: 1, md: 2 },
                        flexWrap: 'wrap',
                        flex: { xs: '1 1 auto', md: '0 0 auto' },
                        minWidth: 0
                    }}>
                        {/* Rig / Well Info */}
                        <Box
                            onClick={user?.role === 'admin' ? handleEditClick : undefined}
                            title={user?.role === 'admin' ? 'Edit rig and well details' : undefined}
                            sx={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: { xs: 1, sm: 3 },
                                bgcolor: '#1e293b',
                                px: { xs: 1, sm: 3 },
                                height: 60,
                                borderRadius: 1,
                                minWidth: 0,
                                cursor: user?.role === 'admin' ? 'pointer' : 'default',
                                border: user?.role === 'admin' ? '1px solid rgba(56, 189, 248, 0.4)' : '1px solid #334155',
                                '&:hover': user?.role === 'admin' ? { borderColor: 'rgba(56, 189, 248, 0.8)' } : undefined
                            }}
                        >
                            <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 'bold', letterSpacing: 1, fontSize: 12, lineHeight: 1.2 }}>RIG</Typography>
                                <Typography variant="subtitle2" sx={{ color: '#38bdf8', fontWeight: 'bold', fontSize: 16, lineHeight: 1.2 }}>{displayRig}</Typography>
                            </Box>
                            <Box sx={{ width: '1px', height: '32px', bgcolor: '#334155' }} />
                            <Box sx={{ display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
                                <Typography variant="caption" sx={{ color: '#94a3b8', fontWeight: 'bold', letterSpacing: 1, fontSize: 12, lineHeight: 1.2 }}>WELL</Typography>
                                <Typography variant="subtitle2" sx={{ color: activeWell ? '#4ade80' : '#38bdf8', fontWeight: 'bold', fontSize: 16, lineHeight: 1.2 }}>{displayWell}</Typography>
                            </Box>
                            {user?.role === 'admin' && (
                                <IconButton size="small" onClick={(event) => { event.stopPropagation(); handleEditClick(); }} sx={{ color: '#38bdf8', bgcolor: 'rgba(56, 189, 248, 0.1)', ml: { xs: 0, sm: 1 }, '&:hover': { bgcolor: 'rgba(56, 189, 248, 0.2)' } }}>
                                    <Edit2 size={14} />
                                </IconButton>
                            )}
                        </Box>
                        
                        <ThemeSwitcher />

                        <IconButton onClick={() => setPwdOpen(true)} sx={{ color: '#94a3b8', '&:hover': { color: '#38bdf8', bgcolor: 'rgba(56,189,248,0.1)' } }}
                            title={user?.username ? `${user.username} — change password` : 'Change password'}>
                            <KeyRound size={19} />
                        </IconButton>

                        <IconButton onClick={handleLogout} sx={{ color: '#ef4444', '&:hover': { bgcolor: 'rgba(239, 68, 68, 0.1)' } }} title="Logout">
                            <LogOut size={20} />
                        </IconButton>
                    </Box>
                </Toolbar>
            </AppBar>

            <ChangePasswordDialog open={pwdOpen} onClose={() => setPwdOpen(false)} />

            {/* Persistent global alarm strip — shown on every route, directly below the AppBar. */}
            <Box
                sx={{
                    position: 'sticky',
                    top: { xs: 'auto', md: 64 },
                    zIndex: (theme) => theme.zIndex.drawer,
                }}
            >
                <AlarmStrip />
            </Box>

            {/* Edit Details Dialog */}
            <Dialog open={isDialogOpen} onClose={() => setIsDialogOpen(false)} PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white', minWidth: 400 } }}>
                <DialogTitle>Edit Rig / Well Details</DialogTitle>
                <DialogContent>
                    {infoError && (
                        <Alert severity="error" sx={{ mb: 2, bgcolor: 'rgba(127, 29, 29, 0.45)', color: '#fecaca' }}>
                            {infoError}
                        </Alert>
                    )}
                    <TextField
                        autoFocus
                        margin="dense"
                        label="Rig Name"
                        fullWidth
                        variant="outlined"
                        value={tempInfo.rig}
                        onChange={(e) => setTempInfo({ ...tempInfo, rig: e.target.value })}
                        helperText="Admin editable"
                        sx={{
                            mb: 2,
                            '& .MuiOutlinedInput-root': { color: 'white', '& fieldset': { borderColor: '#334155' } },
                            '& .MuiInputLabel-root': { color: '#94a3b8' },
                            '& .MuiFormHelperText-root': { color: '#64748b' }
                        }}
                    />
                    <TextField
                        margin="dense"
                        label="Well Name"
                        fullWidth
                        variant="outlined"
                        value={tempInfo.well}
                        onChange={(e) => setTempInfo({ ...tempInfo, well: e.target.value })}
                        sx={{
                            '& .MuiOutlinedInput-root': { color: 'white', '& fieldset': { borderColor: '#334155' } },
                            '& .MuiInputLabel-root': { color: '#94a3b8' }
                        }}
                    />
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 3 }}>
                    <Button onClick={() => setIsDialogOpen(false)} sx={{ color: '#94a3b8' }}>Cancel</Button>
                    <Button onClick={handleSaveInfo} variant="contained" sx={{ bgcolor: '#38bdf8', color: '#0f172a', '&:hover': { bgcolor: '#0ea5e9' } }}>Save Changes</Button>
                </DialogActions>
            </Dialog>

            {/* Main Content */}
            <Box
                component="main"
                sx={{
                    flexGrow: 1,
                    p: { xs: 2, sm: 3 },
                    // Honor the active theme so the shell background changes when the theme switches.
                    bgcolor: 'background.default',
                    color: 'text.primary',
                    overflowX: 'hidden'
                }}
            >
                <Outlet />
            </Box>
            </Box>
        </Box>
        </AlarmProvider>
    );
}
