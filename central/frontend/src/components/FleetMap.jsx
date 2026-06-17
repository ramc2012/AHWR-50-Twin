import React from 'react';
import { Box, Paper, Typography, Stack } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { STATUS_COLOR } from '../theme';

// Geographic scatter of the fleet over the Ankleshwar Asset (proposal §6.1 fleet map).
export default function FleetMap({ rigs }) {
    const nav = useNavigate();
    const pts = rigs.filter((r) => r.latitude != null && r.longitude != null);
    const W = 100, H = 64, pad = 6;

    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const r of pts) {
        minLat = Math.min(minLat, r.latitude); maxLat = Math.max(maxLat, r.latitude);
        minLon = Math.min(minLon, r.longitude); maxLon = Math.max(maxLon, r.longitude);
    }
    const sx = (lon) => pad + ((lon - minLon) / ((maxLon - minLon) || 1)) * (W - 2 * pad);
    const sy = (lat) => pad + (1 - (lat - minLat) / ((maxLat - minLat) || 1)) * (H - 2 * pad);

    return (
        <Paper sx={{ p: 2, height: '100%' }}>
            <Typography variant="subtitle2" color="text.secondary" gutterBottom>FLEET MAP · ANKLESHWAR ASSET</Typography>
            <Box sx={{ position: 'relative', width: '100%' }}>
                <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', background: 'linear-gradient(160deg,#0e1a30,#0a1322)', borderRadius: 8 }}>
                    {/* subtle grid */}
                    {[...Array(9)].map((_, i) => (
                        <line key={'v' + i} x1={(W / 8) * i} y1={0} x2={(W / 8) * i} y2={H} stroke="rgba(255,255,255,0.04)" strokeWidth={0.2} />
                    ))}
                    {[...Array(6)].map((_, i) => (
                        <line key={'h' + i} x1={0} y1={(H / 5) * i} x2={W} y2={(H / 5) * i} stroke="rgba(255,255,255,0.04)" strokeWidth={0.2} />
                    ))}
                    {pts.map((r) => {
                        const c = STATUS_COLOR[r.status] || '#64748b';
                        const live = r.status === 'online' || r.status === 'degraded';
                        return (
                            <g key={r.rigId} onClick={() => nav(`/rigs/${r.rigId}`)} style={{ cursor: 'pointer' }}>
                                {live && <circle cx={sx(r.longitude)} cy={sy(r.latitude)} r={2.6} fill={c} opacity={0.25}>
                                    <animate attributeName="r" values="2.2;4.2;2.2" dur="2.4s" repeatCount="indefinite" />
                                    <animate attributeName="opacity" values="0.35;0;0.35" dur="2.4s" repeatCount="indefinite" />
                                </circle>}
                                <circle cx={sx(r.longitude)} cy={sy(r.latitude)} r={1.6} fill={c} stroke="#0b1220" strokeWidth={0.3}>
                                    <title>{`${r.name} · ${r.status}${r.activeActivity ? ' · ' + r.activeActivity : ''}${r.alarm?.p1 ? ' · P1' : ''}`}</title>
                                </circle>
                            </g>
                        );
                    })}
                </svg>
            </Box>
            <Stack direction="row" spacing={2} mt={1} flexWrap="wrap" useFlexGap>
                {Object.entries(STATUS_COLOR).map(([k, c]) => (
                    <Stack key={k} direction="row" spacing={0.5} alignItems="center">
                        <Box sx={{ width: 10, height: 10, borderRadius: '50%', bgcolor: c }} />
                        <Typography variant="caption" color="text.secondary" textTransform="capitalize">{k}</Typography>
                    </Stack>
                ))}
            </Stack>
        </Paper>
    );
}
