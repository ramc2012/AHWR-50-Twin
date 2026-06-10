import React, { useState, useEffect, useRef } from 'react';
import { Box, Typography, Paper, Tooltip } from '@mui/material';
import { Move } from 'lucide-react';

const RigVisualizer = ({ crownsaverOn, floorsaverOn, travellingUp, travellingDown, height = 500 }) => {
    const containerRef = useRef(null);

    // We completely abandon React state for this value to avoid React 18 re-render desyncs 
    // against the 1-second interval Websocket props coming from the parent Dashboard.
    const posRef = useRef(0);
    const boxRef = useRef(null);
    const textRef = useRef(null);

    const lastTimeRef = useRef(performance.now());
    const animFrameRef = useRef(null);

    // Animate the block while travelling
    useEffect(() => {
        const animate = (time) => {
            const deltaMs = time - lastTimeRef.current;
            lastTimeRef.current = time;

            // Set speed: 5.0% per second takes 20 seconds for full travel
            // If you want it to take MORE time (slower), decrease this value (e.g. 0.5)
            // If you want it to take LESS time (faster), increase this value (e.g. 10.0)
            const percentPerSecond = 5.0;
            const step = (percentPerSecond * deltaMs) / 1000;

            // Update the absolute reference, not a state closure
            let next = posRef.current;
            if (travellingUp) next = Math.min(100, next + step);
            if (travellingDown) next = Math.max(0, next - step);
            posRef.current = next;

            // Step fully outside the React Render Cycle
            if (boxRef.current) {
                boxRef.current.style.bottom = `${5 + (next * 0.85)}%`;
            }
            if (textRef.current) {
                textRef.current.innerText = ((next / 100) * 40).toFixed(1);
            }

            animFrameRef.current = requestAnimationFrame(animate);
        };

        if (travellingUp || travellingDown) {
            lastTimeRef.current = performance.now(); // Reset time when movement starts
            animFrameRef.current = requestAnimationFrame(animate);
        }

        return () => {
            if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
        };
    }, [travellingUp, travellingDown]);

    // Initial static value
    const initialPositionMeters = ((posRef.current / 100) * 40).toFixed(1);

    return (
        <Paper
            sx={{
                p: 2,
                bgcolor: '#0f172a',
                color: 'white',
                height: height,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid #1e293b',
                background: 'linear-gradient(180deg, #1e293b 0%, #0f172a 100%)',
                position: 'relative',
                overflow: 'hidden'
            }}
            ref={containerRef}
        >
            <Box sx={{ position: 'relative', width: 220, height: 440 }}>
                {/* SVG Schematic Layer */}
                <svg width="100%" height="100%" viewBox="0 0 220 440" style={{ filter: 'drop-shadow(0 0 5px rgba(0,0,0,0.5))' }}>
                    <defs>
                        <linearGradient id="metal-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                            <stop offset="0%" stopColor="#334155" />
                            <stop offset="50%" stopColor="#475569" />
                            <stop offset="100%" stopColor="#334155" />
                        </linearGradient>
                        <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
                            <path d="M 20 0 L 0 0 0 20" fill="none" stroke="rgba(255,255,255,0.05)" strokeWidth="1" />
                        </pattern>
                    </defs>

                    {/* Background Grid */}
                    <rect width="100%" height="100%" fill="url(#grid)" />

                    {/* --- DERRICK STRUCTURE --- */}
                    {/* Main Legs */}
                    <path d="M 40 420 L 80 40 L 140 40 L 180 420" fill="none" stroke="url(#metal-grad)" strokeWidth="6" strokeLinecap="round" />

                    {/* Cross Bracing (X pattern) */}
                    <g stroke="#475569" strokeWidth="2" opacity="0.6">
                        <line x1="45" y1="360" x2="175" y2="360" />
                        <line x1="55" y1="280" x2="165" y2="280" />
                        <line x1="65" y1="200" x2="155" y2="200" />
                        <line x1="75" y1="120" x2="145" y2="120" />

                        {/* Diagonals */}
                        <line x1="42" y1="420" x2="165" y2="280" />
                        <line x1="178" y1="420" x2="55" y2="280" />

                        <line x1="55" y1="280" x2="145" y2="120" />
                        <line x1="165" y1="280" x2="75" y2="120" />
                    </g>

                    {/* Crown Block Assembly (Top) */}
                    <rect x="70" y="20" width="80" height="20" fill="#334155" stroke="#475569" strokeWidth="1" rx="2" />
                    <circle cx="90" cy="30" r="6" fill="#1e293b" stroke="#64748b" strokeWidth="2" />
                    <circle cx="110" cy="30" r="6" fill="#1e293b" stroke="#64748b" strokeWidth="2" />
                    <circle cx="130" cy="30" r="6" fill="#1e293b" stroke="#64748b" strokeWidth="2" />

                    {/* Guide Rails */}
                    <line x1="100" y1="40" x2="100" y2="420" stroke="#64748b" strokeWidth="2" />
                    <line x1="120" y1="40" x2="120" y2="420" stroke="#64748b" strokeWidth="2" />

                    {/* Floor / Substructure */}
                    <rect x="20" y="420" width="180" height="10" fill="#334155" />
                    <path d="M 20 430 L 10 440 H 210 L 200 430 Z" fill="#1e293b" />
                </svg>

                {/* --- ANIMATED TRAVELLING BLOCK --- */}
                <Box
                    ref={boxRef}
                    sx={{
                        position: 'absolute',
                        left: '50%',
                        bottom: `${5 + (posRef.current * 0.85)}%`,
                        transform: 'translateX(-50%)',
                        width: 40,
                        height: 60,
                        zIndex: 2,
                        transition: 'bottom 0.2s linear'
                    }}
                >
                    {/* Block Icon */}
                    <svg width="40" height="60" viewBox="0 0 40 60">
                        {/* Cables extending up */}
                        <line x1="10" y1="0" x2="10" y2="-400" stroke="#94a3b8" strokeWidth="1" />
                        <line x1="30" y1="0" x2="30" y2="-400" stroke="#94a3b8" strokeWidth="1" />

                        {/* The Block */}
                        <rect x="0" y="0" width="40" height="50" rx="4" fill="#fbbf24" stroke="#d97706" strokeWidth="2" />

                        {/* Sheaves */}
                        <circle cx="20" cy="15" r="8" fill="#1e293b" opacity="0.3" />
                        <circle cx="20" cy="35" r="8" fill="#1e293b" opacity="0.3" />

                        {/* Hook */}
                        <path d="M 15 50 L 18 55 L 22 55 L 25 50" fill="none" stroke="#d97706" strokeWidth="2" />
                        <path d="M 20 55 L 20 60" fill="none" stroke="#d97706" strokeWidth="2" />
                    </svg>
                </Box>


                {/* --- INDICATORS (Overlaid on SVG) --- */}
                {/* Crownomatic Popup */}
                {crownsaverOn && (
                    <Box sx={{
                        position: 'absolute', top: 5, left: '50%', transform: 'translateX(-50%)',
                        bgcolor: 'rgba(239, 68, 68, 0.95)',
                        px: 2, py: 1, borderRadius: 1,
                        border: '2px solid #fca5a5',
                        boxShadow: '0 0 20px rgba(239, 68, 68, 0.6), 0 0 40px rgba(239, 68, 68, 0.3)',
                        zIndex: 10, textAlign: 'center',
                        animation: 'pulseGlow 1s ease-in-out infinite alternate',
                        '@keyframes pulseGlow': {
                            '0%': { opacity: 1, boxShadow: '0 0 10px rgba(239, 68, 68, 0.4)' },
                            '100%': { opacity: 0.85, boxShadow: '0 0 25px rgba(239, 68, 68, 0.8), 0 0 50px rgba(239, 68, 68, 0.4)' }
                        }
                    }}>
                        <Typography variant="caption" sx={{ color: 'white', fontWeight: 'bold', fontSize: 11, letterSpacing: 1, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            ⚠️ CROWNSAVER ON
                        </Typography>
                    </Box>
                )}


                {/* Flooromatic Popup */}
                {floorsaverOn && (
                    <Box sx={{
                        position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)',
                        bgcolor: 'rgba(245, 158, 11, 0.95)',
                        px: 2, py: 1, borderRadius: 1,
                        border: '2px solid #fde68a',
                        boxShadow: '0 0 20px rgba(245, 158, 11, 0.6), 0 0 40px rgba(245, 158, 11, 0.3)',
                        zIndex: 10, textAlign: 'center',
                        animation: 'pulseGlowFloor 1s ease-in-out infinite alternate',
                        '@keyframes pulseGlowFloor': {
                            '0%': { opacity: 1, boxShadow: '0 0 10px rgba(245, 158, 11, 0.4)' },
                            '100%': { opacity: 0.85, boxShadow: '0 0 25px rgba(245, 158, 11, 0.8), 0 0 50px rgba(245, 158, 11, 0.4)' }
                        }
                    }}>
                        <Typography variant="caption" sx={{ color: 'white', fontWeight: 'bold', fontSize: 11, letterSpacing: 1, display: 'flex', alignItems: 'center', gap: 0.5 }}>
                            ⚠️ FLOORSAVER ON
                        </Typography>
                    </Box>
                )}

            </Box>

            {/* Digital Readout */}
            <Box sx={{
                mt: 2,
                px: 2, py: 0.5,
                bgcolor: 'rgba(0,0,0,0.3)',
                borderRadius: 1,
                display: 'flex',
                gap: 1,
                alignItems: 'center',
                border: '1px solid rgba(255,255,255,0.1)'
            }}>
                <Typography variant="caption" sx={{ color: '#94a3b8' }}>BLK POS:</Typography>
                <Typography variant="h6" sx={{ color: '#38bdf8', fontFamily: 'monospace', fontWeight: 'bold', lineHeight: 1 }}>
                    <span ref={textRef}>{initialPositionMeters}</span> <span style={{ fontSize: 12 }}>m</span>
                </Typography>
            </Box>
        </Paper>
    );
};

export default RigVisualizer;
