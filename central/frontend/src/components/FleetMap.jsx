import React, { useCallback, useMemo } from 'react';
import { Box, GlobalStyles, Paper, Stack, Typography } from '@mui/material';
import { useNavigate } from 'react-router-dom';
import { MapContainer, TileLayer, CircleMarker, Tooltip } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { STATUS_COLOR, STATUS_MARKER, statusDotSx } from '../theme';

// Interactive pan/zoom fleet map (Leaflet) over India — pan-ONGC. Each rig is a
// status-coloured marker; clicking it opens the rig drill-down.
//
// Tiles default to CARTO dark (matches the ops theme). DATA RESIDENCY: a production
// ONGC deployment (zero internet egress) should point VITE_MAP_TILE_URL at an
// INTERNAL/offline tile server; the map, markers and pan/zoom work regardless of
// whether the basemap tiles load.
const TILE_URL = import.meta.env.VITE_MAP_TILE_URL
    || 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTR = import.meta.env.VITE_MAP_TILE_ATTR
    || '&copy; OpenStreetMap contributors &copy; CARTO';

// One rig marker: status colour + SHAPE (hollow/dash) so status survives colourblind
// viewing (UI-37), with a pulsing red ring underneath when the rig's highest active
// alarm is P1/P2 (UI-36). Memoised so fleet deltas re-render only changed markers.
const RigMarker = React.memo(function RigMarker({ rig, lat, lon, onOpen }) {
    const status = rig.status || 'pending';
    const color = STATUS_COLOR[status] || STATUS_COLOR.pending;
    const m = STATUS_MARKER[status] || STATUS_MARKER.pending;
    const alarmSev = rig.alarm?.highest;
    const alarmHot = alarmSev === 'P1' || alarmSev === 'P2';
    const handlers = useMemo(() => ({ click: () => onOpen(rig.rigId) }), [onOpen, rig.rigId]);

    return (
        <>
            {alarmHot && (
                <CircleMarker
                    center={[lat, lon]}
                    radius={15}
                    interactive={false}
                    pathOptions={{ color: '#ef4444', weight: 2, fill: false, className: 'fleetmap-alarm-ring' }}
                />
            )}
            <CircleMarker
                center={[lat, lon]}
                radius={9}
                pathOptions={{
                    color: m.hollow ? color : 'rgba(11,18,32,0.9)',
                    weight: m.hollow ? 3 : 1.5,
                    dashArray: m.dash || undefined,
                    fillColor: color,
                    fillOpacity: m.hollow ? 0.15 : 0.95,
                }}
                eventHandlers={handlers}
            >
                <Tooltip direction="top" offset={[0, -8]}>
                    <strong>{rig.name}</strong> · {rig.assetUnit || rig.field || '—'}<br />
                    {String(status).toUpperCase()}
                    {alarmSev ? ` · ${alarmSev} ALARM` : ''}
                    {rig.activeActivity ? ` · ${rig.activeActivity}` : ''}
                </Tooltip>
            </CircleMarker>
        </>
    );
});

export default function FleetMap({ rigs = [] }) {
    const nav = useNavigate();
    const openRig = useCallback((id) => nav(`/rigs/${id}`), [nav]);

    // Valid points, with co-located rigs fanned out slightly around their shared
    // position so overlapping markers stay individually visible/clickable (UI-36).
    const pts = useMemo(() => {
        const raw = rigs
            .filter((r) => Number.isFinite(Number(r.latitude)) && Number.isFinite(Number(r.longitude)))
            .map((r) => ({ rig: r, lat: Number(r.latitude), lon: Number(r.longitude) }));
        const groups = new Map();
        raw.forEach((p) => {
            const key = `${p.lat.toFixed(3)},${p.lon.toFixed(3)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(p);
        });
        groups.forEach((g) => {
            if (g.length < 2) return;
            g.forEach((p, i) => {
                const a = (2 * Math.PI * i) / g.length;
                p.lat += 0.3 * Math.sin(a);
                p.lon += 0.3 * Math.cos(a);
            });
        });
        return raw;
    }, [rigs]);

    return (
        <Paper sx={{ height: '100%', width: '100%', overflow: 'hidden', position: 'relative' }}>
            {/* Pulse animation for P1/P2 alarm rings (SVG stroke, so plain CSS keyframes). */}
            <GlobalStyles styles={{
                '@keyframes fleetmapAlarmPulse': {
                    '0%': { strokeOpacity: 0.9, strokeWidth: 2 },
                    '50%': { strokeOpacity: 0.15, strokeWidth: 7 },
                    '100%': { strokeOpacity: 0.9, strokeWidth: 2 },
                },
                '.fleetmap-alarm-ring': { animation: 'fleetmapAlarmPulse 1.5s ease-in-out infinite' },
            }} />

            {/* Title overlay (top-right so it never collides with the Leaflet zoom control). */}
            <Box sx={{ position: 'absolute', top: 8, right: 8, zIndex: 500, pointerEvents: 'none',
                bgcolor: 'rgba(11,18,32,0.72)', px: 1, py: 0.4, borderRadius: 1, border: '1px solid rgba(255,255,255,0.08)' }}>
                <Typography variant="caption" sx={{ fontWeight: 800, letterSpacing: 0.5, color: 'text.secondary' }}>
                    FLEET MAP · PAN-ONGC
                </Typography>
            </Box>

            <MapContainer
                center={[22.5, 80]}
                zoom={5}
                minZoom={3}
                scrollWheelZoom
                worldCopyJump
                style={{ height: '100%', width: '100%', background: '#0b1220' }}
            >
                <TileLayer url={TILE_URL} attribution={TILE_ATTR} subdomains="abcd" />
                {pts.map((p) => (
                    <RigMarker key={p.rig.rigId} rig={p.rig} lat={p.lat} lon={p.lon} onOpen={openRig} />
                ))}
            </MapContainer>

            {/* Status legend overlay — swatches mirror the marker SHAPE encoding (UI-37). */}
            <Box sx={{ position: 'absolute', bottom: 8, left: 8, zIndex: 500,
                bgcolor: 'rgba(11,18,32,0.78)', px: 1, py: 0.5, borderRadius: 1, border: '1px solid rgba(255,255,255,0.08)' }}>
                <Stack direction="row" spacing={1.2} flexWrap="wrap" useFlexGap>
                    {Object.keys(STATUS_COLOR).map((k) => (
                        <Stack key={k} direction="row" spacing={0.5} alignItems="center">
                            <Box component="span" sx={statusDotSx(k, 10)} />
                            <Typography variant="caption" color="text.secondary" textTransform="capitalize">{k}</Typography>
                        </Stack>
                    ))}
                </Stack>
            </Box>
        </Paper>
    );
}
