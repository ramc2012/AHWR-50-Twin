import React, { useState } from 'react';
import { Grid, Paper, Typography, Box, Button, IconButton, Breadcrumbs, Link, Divider } from '@mui/material';
import {
    Gauge, Activity, Droplets, ShieldAlert, Anchor,
    ChevronLeft, Settings, LayoutDashboard, Database
} from 'lucide-react';

// Import child dashboards
import PctDashboard from './PctDashboard';
import AcsDashboard from './AcsDashboard';
import CwkDashboard from './CwkDashboard';
import HtdDashboard from './HtdDashboard';
import HpuDashboard from './HpuDashboard';
import CatEngineDashboard from './CatEngineDashboard';
import MudPumpDashboard from '../MudPump/MudPumpDashboard';

const EquipmentCard = ({ title, icon: Icon, color, description, onClick }) => (
    <Paper
        onClick={onClick}
        sx={{
            p: 3,
            height: '100%',
            cursor: 'pointer',
            bgcolor: '#1e293b',
            transition: 'all 0.3s ease',
            border: '1px solid #334155',
            '&:hover': {
                transform: 'translateY(-5px)',
                bgcolor: '#334155',
                borderColor: color,
                boxShadow: `0 0 20px ${color}20`
            },
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            textAlign: 'center'
        }}
    >
        <Box sx={{
            width: 60, height: 60, borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            bgcolor: `${color}20`, color: color, mb: 2
        }}>
            <Icon size={32} />
        </Box>
        <Typography variant="h6" sx={{ fontWeight: 'bold', mb: 1 }}>{title}</Typography>
        <Typography variant="body2" sx={{ color: '#94a3b8' }}>{description}</Typography>

        <Box sx={{ mt: 'auto', pt: 3, width: '100%' }}>
            <Button
                variant="outlined"
                fullWidth
                sx={{
                    color: color,
                    borderColor: `${color}50`,
                    '&:hover': { borderColor: color, bgcolor: `${color}10` }
                }}
            >
                OPEN DASHBOARD
            </Button>
        </Box>
    </Paper>
);

export default function EquipmentHub() {
    const [view, setView] = useState('cat-engine'); // Default directly to Cat Engine

    const renderContent = () => {
        switch (view) {
            case 'pct': return <PctDashboard />;
            case 'acs': return <AcsDashboard />;
            case 'cwk': return <CwkDashboard />;
            case 'htd': return <HtdDashboard />;
            case 'hpu': return <HpuDashboard />;
            case 'cat-engine': return <CatEngineDashboard />;
            case 'mud-pump': return <MudPumpDashboard />;
            default: return <CatEngineDashboard />;
        }
    };

    const equipments = [
        { id: 'cat-engine', title: 'CAT ENGINE', icon: Gauge, color: '#38bdf8', desc: 'Propulsion & Power Generation' },
        { id: 'hpu', title: 'HPU SYSTEM', icon: Activity, color: '#4ade80', desc: 'Hydraulic Power Unit Monitoring' },
        { id: 'htd', title: 'HTD DRIVE', icon: Droplets, color: '#a78bfa', desc: 'Top Drive Operations' },
        { id: 'mud-pump', title: 'MUD PUMP', icon: Droplets, color: '#3b82f6', desc: 'Mud Pump Monitoring' },
        { id: 'acs', title: 'ACS SYSTEM', icon: ShieldAlert, color: '#ef4444', desc: 'Automatic Control System' },
        { id: 'cwk', title: 'CATWALK', icon: LayoutDashboard, color: '#fbbf24', desc: 'Pipe Handling & Catwalk' },
        { id: 'pct', title: 'PCT TONG', icon: Anchor, color: '#22d3ee', desc: 'Power Casing Tong' }
    ];



    return (
        <Box sx={{ minHeight: '100%', display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Top Navigation Bar */}
            <Paper
                elevation={0}
                sx={{
                    p: 1,
                    display: 'flex',
                    gap: 1,
                    bgcolor: '#1e293b',
                    borderRadius: 2,
                    border: '1px solid #334155',
                    flexWrap: 'wrap',
                    position: 'sticky',
                    top: 0,
                    zIndex: 100
                }}
            >




                {equipments.map((eq) => {
                    const isActive = view === eq.id;
                    const Icon = eq.icon;
                    return (
                        <Button
                            key={eq.id}
                            variant={isActive ? 'contained' : 'text'}
                            onClick={() => setView(eq.id)}
                            startIcon={<Icon size={18} />}
                            sx={{
                                color: isActive ? '#0f172a' : '#94a3b8',
                                bgcolor: isActive ? eq.color : 'transparent',
                                '&:hover': {
                                    bgcolor: isActive ? eq.color : 'rgba(255,255,255,0.05)',
                                    opacity: 0.9
                                },
                                fontWeight: isActive ? 'bold' : 'medium',
                                px: 2
                            }}
                        >
                            {eq.title.split(' ')[0]} {/* Show first word for brevity on top bar */}
                        </Button>
                    );
                })}
            </Paper>

            <Box sx={{ flexGrow: 1 }}>
                {renderContent()}
            </Box>
        </Box>
    );
}
