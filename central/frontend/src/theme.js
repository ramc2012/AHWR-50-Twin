import { createTheme } from '@mui/material/styles';

// Ops-centre dark theme for the monitoring video wall + workstations (proposal §5.4).
const theme = createTheme({
    palette: {
        mode: 'dark',
        primary: { main: '#3ea6ff' },
        secondary: { main: '#7c4dff' },
        background: { default: '#0b1220', paper: '#121b2e' },
        success: { main: '#22c55e' },
        warning: { main: '#f59e0b' },
        error: { main: '#ef4444' },
        info: { main: '#38bdf8' },
        divider: 'rgba(255,255,255,0.08)',
    },
    shape: { borderRadius: 10 },
    typography: {
        fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        h6: { fontWeight: 700, letterSpacing: 0.2 },
        subtitle2: { fontWeight: 600 },
    },
    components: {
        MuiPaper: { styleOverrides: { root: { backgroundImage: 'none', border: '1px solid rgba(255,255,255,0.06)' } } },
        MuiCard: { styleOverrides: { root: { backgroundImage: 'none' } } },
        MuiTableCell: { styleOverrides: { root: { borderColor: 'rgba(255,255,255,0.06)' } } },
        MuiChip: { styleOverrides: { root: { fontWeight: 600 } } },
    },
});

// Shared status colour map used across the portal.
// Hues are kept separated (amber degraded vs orange stale) but colour is NOT the
// only channel — see STATUS_MARKER below for the colourblind-safe shape encoding.
export const STATUS_COLOR = {
    online: '#22c55e',
    degraded: '#f59e0b',
    stale: '#f97316',
    offline: '#ef4444',
    pending: '#64748b',
};

// Well lifecycle status palette (UI-41): distinct from the rig-liveness
// STATUS_COLOR above — keyed by lifecycle stage, not link health.
export const WELL_STATUS_COLOR = {
    planned: '#64748b',
    drilling: '#38bdf8',
    completed: '#22d3ee',
    producing: '#22c55e',
    workover: '#f59e0b',
    suspended: '#f97316',
    abandoned: '#ef4444',
};

// Colourblind-safe non-colour channel (UI-37): each status also gets a distinct
// dot/marker SHAPE so it stays readable without hue. `hollow` draws a ring instead
// of a filled disc; `dash` is the SVG dash pattern for Leaflet marker outlines;
// `borderStyle` is the matching CSS border style for HTML dots/legends.
//   online   → solid disc
//   degraded → filled disc with dark dashed notches
//   stale    → hollow ring
//   offline  → hollow dashed ring
//   pending  → filled disc with dark dotted notches
export const STATUS_MARKER = {
    online: { hollow: false, dash: null, borderStyle: 'solid' },
    degraded: { hollow: false, dash: '4 3', borderStyle: 'dashed' },
    stale: { hollow: true, dash: null, borderStyle: 'solid' },
    offline: { hollow: true, dash: '4 3', borderStyle: 'dashed' },
    pending: { hollow: false, dash: '1 4', borderStyle: 'dotted' },
};

// sx recipe for an HTML status dot carrying both the colour AND shape channels.
// Used by tile dots and by the map/tile status legends so they stay consistent.
export const statusDotSx = (status, size = 10) => {
    const c = STATUS_COLOR[status] || STATUS_COLOR.pending;
    const m = STATUS_MARKER[status] || STATUS_MARKER.pending;
    return {
        width: size,
        height: size,
        borderRadius: '50%',
        display: 'inline-block',
        boxSizing: 'border-box',
        flex: '0 0 auto',
        bgcolor: m.hollow ? 'transparent' : c,
        border: m.hollow
            ? `2px ${m.borderStyle} ${c}`
            : (m.borderStyle === 'solid' ? 'none' : `2px ${m.borderStyle} rgba(11,18,32,0.9)`),
    };
};

export default theme;
