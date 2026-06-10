import React, { useState, useEffect } from 'react';
import { Outlet, Link, useLocation } from 'react-router-dom';
import {
    LayoutDashboard,
    Activity,
    Gauge,
    Droplets,
    ShieldAlert,
    LineChart as ChartIcon,
    Settings,
    Edit2,
    Anchor,
    LogOut,
    ChevronDown,
    Database
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

const menuItems = [
    { text: 'Rig Overview', icon: <LayoutDashboard size={20} />, path: '/' },
    { text: 'EDR', icon: <Activity size={20} />, path: '/edr' },
    { text: 'EQUIPMENT', icon: <Database size={20} />, path: '/equipment' },
    { text: 'Well Control', icon: <ShieldAlert size={20} />, path: '/wellcontrol' },
    { text: 'Fishing Ops', icon: <Anchor size={20} />, path: '/fishing' },
    { text: 'Live Trends', icon: <ChartIcon size={20} />, path: '/trends' },
    { text: 'Settings', icon: <Settings size={20} />, path: '/admin' },
];

import io from 'socket.io-client';

const socket = io('/'); // Singleton socket for Layout

export default function Layout() {
    const location = useLocation();
    const { logout } = useAuth();
    const navigate = useNavigate();

    const [menuAnchor, setMenuAnchor] = useState(null);

    const handleLogout = () => {
        logout();
        navigate('/login');
    };

    // Well & Rig State
    const [wellInfo, setWellInfo] = useState({ well: 'WELL-001', rig: 'RIG-ALPHA' });
    const [isDialogOpen, setIsDialogOpen] = useState(false);
    const [tempInfo, setTempInfo] = useState({ well: '', rig: '' });

    useEffect(() => {
        // Initial Load
        fetch(`/api/dashboard/layout?t=${Date.now()}`)
            .then(res => res.json())
            .then(config => {
                if (config.wellInfo) setWellInfo(config.wellInfo);
            })
            .catch(err => console.error("Failed to load rig info:", err));

        // Real-time Updates
        socket.on('dashboard_layout_update', (config) => {
            if (config.wellInfo && (config.wellInfo.well !== wellInfo.well || config.wellInfo.rig !== wellInfo.rig)) {
                setWellInfo(config.wellInfo);
            }
        });

        return () => {
            socket.off('dashboard_layout_update');
            socket.disconnect();
        };
    }, []);

    const handleEditClick = () => {
        setTempInfo(wellInfo);
        setIsDialogOpen(true);
    };

    const handleSaveInfo = () => {
        setWellInfo(tempInfo);
        // Save to Backend (Partial Update)
        fetch('/api/dashboard/layout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wellInfo: tempInfo })
        }).catch(e => console.error("Failed to save rig info", e));

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

    const currentPage = menuItems.find(item => item.path === location.pathname);

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
            <CssBaseline />

            {/* Top AppBar */}
            <AppBar
                position="fixed"
                sx={{
                    bgcolor: '#0f172a',
                    borderBottom: '1px solid #334155',
                    boxShadow: 'none'
                }}
            >
                <Toolbar>
                    {/* App Name */}
                    <Typography variant="h6" noWrap sx={{ fontWeight: 'bold', color: '#38bdf8', mr: 2 }}>
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
                            px: 2,
                            py: 0.8,
                            borderRadius: 1,
                            bgcolor: menuAnchor ? 'rgba(56, 189, 248, 0.15)' : 'rgba(255,255,255,0.05)',
                            border: '1px solid #334155',
                            '&:hover': { bgcolor: 'rgba(56, 189, 248, 0.1)', borderColor: '#38bdf8' }
                        }}
                    >
                        {currentPage?.icon}
                        <Typography variant="body1" sx={{ fontWeight: 'bold' }}>
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
                            {menuItems.map((item) => {
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

                    <Box sx={{ flexGrow: 1 }} />

                    {/* Right side - Rig/Well info & Logout */}
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, bgcolor: '#1e293b', px: 2, py: 1, borderRadius: 1 }}>
                            <Box>
                                <Typography variant="body2" sx={{ color: '#94a3b8', lineHeight: 1 }}>Rig</Typography>
                                <Typography variant="subtitle2" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{wellInfo.rig}</Typography>
                            </Box>
                            <Box sx={{ width: '1px', height: '20px', bgcolor: '#334155' }} />
                            <Box>
                                <Typography variant="body2" sx={{ color: '#94a3b8', lineHeight: 1 }}>Well</Typography>
                                <Typography variant="subtitle2" sx={{ color: '#38bdf8', fontWeight: 'bold' }}>{wellInfo.well}</Typography>
                            </Box>
                            <IconButton size="small" onClick={handleEditClick} sx={{ color: '#38bdf8', bgcolor: 'rgba(56, 189, 248, 0.1)', ml: 1, '&:hover': { bgcolor: 'rgba(56, 189, 248, 0.2)' } }}>
                                <Edit2 size={14} />
                            </IconButton>
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
                    p: 3,
                    bgcolor: '#0f172a',
                    minHeight: '100vh',
                    color: 'white'
                }}
            >
                <Toolbar />
                <Outlet />
            </Box>
        </Box>
    );
}
