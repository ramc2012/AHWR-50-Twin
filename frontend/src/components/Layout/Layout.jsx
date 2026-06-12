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
    ChevronDown,
    Database,
    Bell,
    Wrench,
    FileText,
    HeartPulse,
    Network
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
    Popover,
    List,
    ListItem,
    ListItemButton,
    ListItemIcon,
    ListItemText
} from '@mui/material';
import { useAuth } from '../../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { socket, connectSocket } from '../../socket';
import AlarmBanner from '../Alarms/AlarmBanner';
import axios from '../../api';

const menuItems = [
    { text: 'Rig Overview', icon: <LayoutDashboard size={20} />, path: '/' },
    { text: 'EDR', icon: <Activity size={20} />, path: '/edr' },
    { text: 'EQUIPMENT', icon: <Database size={20} />, path: '/equipment' },
    { text: 'Activity', icon: <Activity size={20} />, path: '/activity' },
    { text: 'Alarms', icon: <Bell size={20} />, path: '/alarms' },
    { text: 'Workover', icon: <Wrench size={20} />, path: '/workover' },
    { text: 'Well Control', icon: <ShieldAlert size={20} />, path: '/wellcontrol' },
    { text: 'Fishing Ops', icon: <Anchor size={20} />, path: '/fishing' },
    { text: 'Live Trends', icon: <ChartIcon size={20} />, path: '/trends' },
    { text: 'Reports', icon: <FileText size={20} />, path: '/reports' },
    { text: 'Maintenance', icon: <HeartPulse size={20} />, path: '/maintenance' },
    { text: 'Fleet', icon: <Network size={20} />, path: '/fleet' },
    // Admin/Settings is appended at render time only for role 'admin'.
];

export default function Layout() {
    const location = useLocation();
    const { logout, user } = useAuth();
    const navigate = useNavigate();

    const [menuAnchor, setMenuAnchor] = useState(null);
    const [connected, setConnected] = useState(socket.connected);

    // Admin sees the Settings entry; everyone else does not.
    const navItems = user?.role === 'admin'
        ? [...menuItems, { text: 'Settings', icon: <Settings size={20} />, path: '/admin' }]
        : menuItems;

    const handleLogout = () => {
        logout();
        navigate('/login');
    };

    // Well & Rig State
    const [wellInfo, setWellInfo] = useState({ well: 'WELL-001', rig: 'RIG-ALPHA' });
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [tempInfo, setTempInfo] = useState({ well: '', rig: '' });

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

        // Real-time Updates
        const handleLayoutUpdate = (config) => {
            if (config.wellInfo && (config.wellInfo.well !== wellInfo.well || config.wellInfo.rig !== wellInfo.rig)) {
                setWellInfo(config.wellInfo);
            }
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

        return () => {
            // Remove ONLY our own handlers; do NOT disconnect the shared socket here.
            socket.off('dashboard_layout_update', handleLayoutUpdate);
            socket.off('connect', handleConnect);
            socket.off('disconnect', handleDisconnect);
            socket.off('connect_error', handleConnectError);
        };
    }, []);

    const handleEditClick = () => {
        setTempInfo(wellInfo);
        setIsDialogOpen(true);
    };

    const handleSaveInfo = () => {
        setWellInfo(tempInfo);
        // Save to Backend (Partial Update)
        axios.post('/api/dashboard/layout', { wellInfo: tempInfo })
            .catch(e => console.error("Failed to save rig info", e));

        setIsDialogOpen(false);
    };

    const handleMenuOpen = (event) => {
        setMenuAnchor(event.currentTarget);
    };

    const handleMenuClose = () => {
        setMenuAnchor(null);
    };

    const handleNavClick = (path) => {
        navigate(path);
        setMenuAnchor(null);
    };

    const currentPage = navItems.find(item => item.path === location.pathname);

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
            <CssBaseline />

            {/* Top AppBar */}
            <AppBar
                position="sticky"
                sx={{
                    top: 0,
                    bgcolor: '#0f172a',
                    borderBottom: '1px solid #334155',
                    boxShadow: 'none',
                    zIndex: (theme) => theme.zIndex.drawer + 1
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
                    {/* App Name */}
                    <Typography variant="h6" noWrap sx={{ fontWeight: 'bold', color: '#38bdf8', mr: { xs: 0.5, md: 1 }, fontSize: { xs: '1rem', sm: '1.25rem' } }}>
                        ANK-WS
                    </Typography>

                    {/* Navigation Dropdown Button */}
                    <Button
                        onClick={handleMenuOpen}
                        sx={{
                            color: 'white',
                            textTransform: 'none',
                            display: 'flex',
                            alignItems: 'center',
                            gap: 1,
                            px: { xs: 1, sm: 2 },
                            py: 0.8,
                            borderRadius: 1,
                            minWidth: 0,
                            maxWidth: { xs: 150, sm: 'none' },
                            bgcolor: menuAnchor ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255,255,255,0.05)',
                            border: '1px solid #334155',
                            '&:hover': { bgcolor: 'rgba(56, 189, 248, 0.1)', borderColor: '#38bdf8' }
                        }}
                    >
                        {currentPage?.icon}
                        <Typography variant="body1" noWrap sx={{ fontWeight: 'bold', fontSize: { xs: 13, sm: 16 } }}>
                            {currentPage?.text || 'Rig Overview'}
                        </Typography>
                        <ChevronDown size={16} style={{ transform: menuAnchor ? 'rotate(180deg)' : 'rotate(0deg)', transition: '0.2s' }} />
                    </Button>

                    {/* Dropdown Menu */}
                    <Popover
                        open={Boolean(menuAnchor)}
                        anchorEl={menuAnchor}
                        onClose={handleMenuClose}
                        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
                        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
                        PaperProps={{
                            sx: {
                                bgcolor: '#1e293b',
                                border: '1px solid #334155',
                                borderRadius: 2,
                                minWidth: 220,
                                mt: 0.5,
                                boxShadow: '0 4px 20px rgba(0,0,0,0.4)'
                            }
                        }}
                    >
                        <List sx={{ py: 0.5 }}>
                            {navItems.map((item) => {
                                const isActive = location.pathname === item.path;
                                return (
                                    <ListItem key={item.text} disablePadding>
                                        <ListItemButton
                                            onClick={() => handleNavClick(item.path)}
                                            sx={{
                                                px: 2, py: 1,
                                                bgcolor: isActive ? 'rgba(56, 189, 248, 0.1)' : 'transparent',
                                                borderLeft: isActive ? '3px solid #38bdf8' : '3px solid transparent',
                                                '&:hover': { bgcolor: 'rgba(56, 189, 248, 0.08)' }
                                            }}
                                        >
                                            <ListItemIcon sx={{ color: isActive ? '#38bdf8' : '#94a3b8', minWidth: 36 }}>
                                                {item.icon}
                                            </ListItemIcon>
                                            <ListItemText
                                                primary={item.text}
                                                primaryTypographyProps={{
                                                    sx: { color: isActive ? '#38bdf8' : 'white', fontWeight: isActive ? 'bold' : 'normal', fontSize: 14 }
                                                }}
                                            />
                                        </ListItemButton>
                                    </ListItem>
                                );
                            })}
                        </List>
                    </Popover>

                    <Box sx={{ flexGrow: 1, display: { xs: 'none', md: 'block' } }} />

                    {/* Persistent alarm banner — visible on every page. */}
                    <AlarmBanner />

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
                        {/* Live socket connection indicator */}
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, bgcolor: '#1e293b', px: { xs: 1, sm: 1.5 }, py: 1, borderRadius: 1 }}>
                            <Box sx={{
                                width: 10, height: 10, borderRadius: '50%',
                                bgcolor: connected ? '#4ade80' : '#ef4444',
                                boxShadow: connected ? '0 0 8px #4ade80' : '0 0 8px #ef4444',
                                transition: 'all 0.3s'
                            }} />
                            <Typography variant="caption" sx={{ color: connected ? '#4ade80' : '#ef4444', fontWeight: 'bold', letterSpacing: 0.5 }}>
                                {connected ? 'Connected' : 'Disconnected'}
                            </Typography>
                        </Box>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: { xs: 1, sm: 2 }, bgcolor: '#1e293b', px: { xs: 1, sm: 2 }, py: 1, borderRadius: 1, minWidth: 0 }}>
                            <Box>
                                <Typography variant="body2" sx={{ color: '#94a3b8', lineHeight: 1 }}>Rig</Typography>
                                <Typography variant="subtitle2" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{wellInfo.rig}</Typography>
                            </Box>
                            <Box sx={{ width: '1px', height: '20px', bgcolor: '#334155' }} />
                            <Box>
                                <Typography variant="body2" sx={{ color: '#94a3b8', lineHeight: 1 }}>Well</Typography>
                                <Typography variant="subtitle2" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{wellInfo.well}</Typography>
                            </Box>
                            {user?.role === 'admin' && (
                                <IconButton size="small" onClick={handleEditClick} sx={{ color: '#38bdf8', bgcolor: 'rgba(56, 189, 248, 0.1)', ml: { xs: 0, sm: 1 }, '&:hover': { bgcolor: 'rgba(56, 189, 248, 0.2)' } }}>
                                    <Edit2 size={14} />
                                </IconButton>
                            )}
                        </Box>
                        <IconButton onClick={handleLogout} sx={{ color: '#ef4444', '&:hover': { bgcolor: 'rgba(239, 68, 68, 0.1)' } }} title="Logout">
                            <LogOut size={20} />
                        </IconButton>
                    </Box>
                </Toolbar>
            </AppBar>

            {/* Edit Details Dialog */}
            <Dialog open={isDialogOpen} onClose={() => setIsDialogOpen(false)} PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white', minWidth: 400 } }}>
                <DialogTitle>Edit Operation Details</DialogTitle>
                <DialogContent>
                    <TextField
                        autoFocus
                        margin="dense"
                        label="Well Name"
                        fullWidth
                        variant="outlined"
                        value={tempInfo.well}
                        onChange={(e) => setTempInfo({ ...tempInfo, well: e.target.value })}
                        sx={{
                            mb: 2,
                            '& .MuiOutlinedInput-root': { color: 'white', '& fieldset': { borderColor: '#334155' } },
                            '& .MuiInputLabel-root': { color: '#94a3b8' }
                        }}
                    />
                    <TextField
                        margin="dense"
                        label="Rig Name"
                        fullWidth
                        variant="outlined"
                        value={tempInfo.rig}
                        onChange={(e) => setTempInfo({ ...tempInfo, rig: e.target.value })}
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
                    bgcolor: '#0f172a',
                    minHeight: '100vh',
                    color: 'white',
                    overflowX: 'hidden'
                }}
            >
                <Outlet />
            </Box>
        </Box>
    );
}
