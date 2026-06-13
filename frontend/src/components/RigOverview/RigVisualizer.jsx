import React, { useEffect, useRef } from 'react';
import { Box, Typography, Paper } from '@mui/material';

const RigVisualizer = ({ blockPosition = 0, slipsIn = false, height = { xs: 520, md: 'clamp(500px, 52vh, 620px)' } }) => {
    // blockPosition is expected to be 0 to 40000 mm.
    // Parse the raw position, fallback to 0
    const rawPos = Number(blockPosition) || 0;

    // The physical movement range in mm
    const minMm = 1400;
    const maxMm = 14000;

    // Clamp value for visual rendering so it doesn't break out of bounds
    const clampedPos = Math.max(minMm, Math.min(maxMm, rawPos));

    // Calculate percentage (0 = bottom, 1 = top)
    const percent = (clampedPos - minMm) / (maxMm - minMm);
    
    // Convert percent to Y coordinate in the SVG viewBox (0 20 220 390)
    // 0% (1400mm) -> blockY = 350 (purple markable area at bottom)
    // 100% (14000mm) -> blockY = 120 (white markable area below red zone)
    const blockY = 350 - (percent * (350 - 120));

    // Saver conditions
    const showCrownSaver = rawPos >= 14700;
    const showBottomSaver = rawPos <= 1100;

    return (
        <Paper
            sx={{
                p: 1.5,
                pt: 1,
                pb: 1,
                bgcolor: 'rgba(15, 23, 42, 0.6)',
                backdropFilter: 'blur(12px)',
                border: '1px solid rgba(56, 189, 248, 0.2)',
                borderRadius: 3,
                boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
                color: 'white',
                height: height,
                minHeight: { xs: 560, md: 560 },
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                position: 'relative',
                overflow: 'hidden',
                transition: 'all 0.2s',
            }}
        >
            {/* Header */}
            <Typography 
                variant="subtitle2" 
                sx={{ 
                    color: '#38bdf8',
                    fontWeight: '800',
                    mb: 0.5,
                    letterSpacing: 1.5,
                    textAlign: 'center',
                    textShadow: '0 0 10px rgba(56, 189, 248, 0.3)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 1
                }}
            >
                ACS
            </Typography>

            <Box
                sx={{
                    position: 'relative',
                    width: 'min(100%, 300px)',
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    minHeight: 0
                }}
            >
                {/* SVG Schematic Layer */}
                <svg width="100%" height="100%" viewBox="10 20 200 390" preserveAspectRatio="xMidYMid meet" style={{ flex: 1, maxHeight: '100%', minHeight: 200 }}>
                    <defs>
                        <linearGradient id="derrick-bg" x1="0%" y1="0%" x2="0%" y2="100%">
                            <stop offset="0%" stopColor="#1e293b" />
                            <stop offset="100%" stopColor="#0f172a" />
                        </linearGradient>
                    </defs>

                    {/* Derrick Silhouette Background */}
                    <polygon points="70,40 150,40 190,400 30,400" fill="url(#derrick-bg)" />
                    <polygon points="70,40 150,40 190,400 30,400" fill="none" stroke="#334155" strokeWidth="4" />

                    {/* Horizontal Bracing Lines */}
                    <line x1="62" y1="120" x2="158" y2="120" stroke="#334155" strokeWidth="2" />
                    <line x1="53" y1="200" x2="167" y2="200" stroke="#334155" strokeWidth="2" />
                    <line x1="44" y1="280" x2="176" y2="280" stroke="#334155" strokeWidth="2" />
                    <line x1="35" y1="360" x2="185" y2="360" stroke="#334155" strokeWidth="2" />

                    {/* Color Zones */}
                    {/* Top Red Zone */}
                    <polygon points="73,40 147,40 140,120 80,120" fill="#ef4444" opacity="0.9" />
                    {/* Top Yellow Zone */}
                    <polygon points="80,120 140,120 135,160 85,160" fill="#f59e0b" opacity="0.9" />
                    {/* Bottom Yellow Zone */}
                    <polygon points="35,360 185,360 188,390 32,390" fill="#f59e0b" opacity="0.9" />

                    {/* Crown Block */}
                    <rect x="70" y="25" width="80" height="15" fill="#334155" stroke="#475569" strokeWidth="2" rx="4" />
                    <circle cx="95" cy="32" r="4" fill="#cbd5e1" />
                    <circle cx="125" cy="32" r="4" fill="#cbd5e1" />

                    {/* Floor Base */}
                    <rect x="10" y="400" width="200" height="8" fill="#1e293b" rx="2" />
                    {/* Static Ropes from Crown down to the floor position (y=350) */}
                    <line x1="95" y1="35" x2="95" y2="350" stroke="#0f172a" strokeWidth="3" />
                    <line x1="125" y1="35" x2="125" y2="350" stroke="#0f172a" strokeWidth="3" />

                    {/* ANIMATED TRAVELLING BLOCK inside main SVG */}
                    <g style={{ transform: `translate(75px, ${blockY}px)`, transition: 'transform 0.5s ease-out' }}>
                        {/* White connecting clips (top) */}
                        <line x1="20" y1="-3" x2="20" y2="3" stroke="#ffffff" strokeWidth="4" />
                        <line x1="50" y1="-3" x2="50" y2="3" stroke="#ffffff" strokeWidth="4" />

                        {/* Traveling Block Box */}
                        <rect x="5" y="0" width="60" height="30" rx="4" fill="#f59e0b" stroke="#b45309" strokeWidth="2" />
                        <rect x="12" y="5" width="46" height="20" rx="2" fill="#d97706" />

                        {/* BLK POS Text ON the block */}
                        <text x="35" y="19" textAnchor="middle" fill="#ffffff" fontSize="9" fontWeight="900" letterSpacing="0.5" style={{ filter: 'drop-shadow(0px 1px 1px rgba(0,0,0,0.8))' }}>
                            {rawPos.toFixed(0)}
                        </text>

                        {/* Link / Hook underneath */}
                        <line x1="25" y1="30" x2="25" y2="45" stroke="#64748b" strokeWidth="2.5" />
                        <line x1="45" y1="30" x2="45" y2="45" stroke="#64748b" strokeWidth="2.5" />
                    </g>
                </svg>

                {/* Popups for Saver Conditions */}
                {showCrownSaver && (
                    <Box sx={{
                        position: 'absolute', top: '15%', left: '50%', transform: 'translateX(-50%)',
                        bgcolor: '#ef4444', color: 'white', px: 2, py: 0.5, borderRadius: 1,
                        fontWeight: 'bold', zIndex: 20, boxShadow: '0 0 10px #ef4444',
                        animation: 'flash 1s infinite alternate',
                        textAlign: 'center', whiteSpace: 'nowrap', lineHeight: 1.2,
                        '@keyframes flash': { '0%': { opacity: 1 }, '100%': { opacity: 0.5 } }
                    }}>
                        CROWN SAVER<br/>ON
                    </Box>
                )}

                {showBottomSaver && (
                    <Box sx={{
                        position: 'absolute', bottom: '15%', left: '50%', transform: 'translateX(-50%)',
                        bgcolor: '#ef4444', color: 'white', px: 2, py: 0.5, borderRadius: 1,
                        fontWeight: 'bold', zIndex: 20, boxShadow: '0 0 10px #ef4444',
                        animation: 'flash 1s infinite alternate',
                        textAlign: 'center', whiteSpace: 'nowrap', lineHeight: 1.2
                    }}>
                        BOTTOM SAVER<br/>ON
                    </Box>
                )}
            </Box>

            {/* SLIPS Indicator at the very bottom */}
            <Box sx={{
                mt: 0.5,
                width: 'min(100%, 300px)', // Match the exact width of the derrick container above
                bgcolor: '#064e3b',
                border: '1px solid #059669',
                borderRadius: 2,
                py: 1,
                px: 3,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                boxSizing: 'border-box'
            }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Box sx={{ 
                        width: 14, 
                        height: 14, 
                        borderRadius: '50%', 
                        bgcolor: slipsIn ? '#34d399' : '#10b981',
                        boxShadow: slipsIn ? '0 0 10px #34d399' : 'none',
                        opacity: slipsIn ? 1 : 0.3,
                        mt: '1px' // optical alignment fix
                    }} />
                    <Typography sx={{ color: '#a7f3d0', fontWeight: 800, letterSpacing: 2, fontSize: '0.85rem', lineHeight: 1 }}>
                        SLIPS
                    </Typography>
                </Box>
                <Typography sx={{ color: '#34d399', fontWeight: 900, letterSpacing: 2, fontSize: '1.2rem', lineHeight: 1 }}>
                    {slipsIn ? 'IN' : 'OUT'}
                </Typography>
            </Box>
        </Paper>
    );
};

export default RigVisualizer;
