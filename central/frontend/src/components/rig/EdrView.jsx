import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Box,
    Button,
    Checkbox,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControl,
    Grid,
    IconButton,
    ListItemText,
    ListSubheader,
    MenuItem,
    Paper,
    Select,
    TextField,
    ToggleButton,
    ToggleButtonGroup,
    Tooltip as MuiTooltip,
    Typography,
    useTheme
} from '@mui/material';
import {
    ChevronsDown,
    ChevronsUp,
    Clock,
    Gauge,
    Plus,
    Radio,
    Ruler,
    Settings,
    SlidersHorizontal,
    Trash2
} from 'lucide-react';
// CENTRAL PORT of the edge EDR (proposal §6.1 rig drill-down): identical hand-rolled
// SVG strip-chart recorder, with the data layer swapped to the central per-rig sources
// — api.rigHistoryMulti (history seed) + useRigData (live point ingestion). READ-ONLY.
import { api } from '../../api';
import { useRigData } from '../../context/RigDataContext';
import edrCatalog from '../../edrMetrics.json';

/*
 * EdrView — reusable, self-contained strip-chart Electronic Drilling Recorder.
 *
 * Rendering is a hand-rolled SVG strip renderer (no recharts) so we control the
 * strip look exactly: shared vertical index axis (time OR depth), multiple pens
 * per strip each on its OWN horizontal [min,max] scale + color, light gridlines,
 * a thin current-value marker, and a FIXED-HEIGHT bottom "variables" block whose
 * content adaptively compacts so every strip's block is the same height and the
 * blocks line up on a shared baseline regardless of pen count.
 *
 * Data plumbing reuses the shared authenticated axios (/api/history seed +
 * /api/rig/latest) and the shared socket (`rig_data`) — no new instances.
 */

// ---------------------------------------------------------------------------
// Catalog helpers
// ---------------------------------------------------------------------------

const METRIC_OPTIONS = edrCatalog.categories.flatMap(category => (
    category.fields.map(field => ({
        id: `${category.id}.${field.id}`,
        label: field.label,
        unit: field.unit || '',
        precision: field.precision ?? 1,
        defaultMin: field.defaultMin ?? 0,
        defaultMax: field.defaultMax ?? 1,
        categoryId: category.id,
        categoryLabel: category.label
    }))
));
const METRIC_LOOKUP = new Map(METRIC_OPTIONS.map(o => [o.id, o]));
const ALL_METRIC_IDS = METRIC_OPTIONS.map(o => o.id);

const COLOR_RE = /^#[0-9a-f]{6}$/i;
const PEN_COLORS = ['#38bdf8', '#fbbf24', '#4ade80', '#f472b6', '#a78bfa', '#fb7185', '#22d3ee', '#f97316'];
const MAX_PENS = 3;
const MAX_READOUTS = 6;
const DEPTH_INDEX_METRIC = 'drilling.hole_depth';
const DEPTH_BIN_M = 0.5;

// Always-on left-band depth readouts (full mode only).
const HOLE_DEPTH_METRIC = 'drilling.hole_depth';
const BIT_DEPTH_METRIC = 'drilling.bit_depth';

const channelLabel = (id) => METRIC_LOOKUP.get(id)?.label || id.replace(/[._]/g, ' ');
const channelUnit = (id) => METRIC_LOOKUP.get(id)?.unit || '';
const channelPrecision = (id) => METRIC_LOOKUP.get(id)?.precision ?? 1;
const channelCategory = (id) => METRIC_LOOKUP.get(id)?.categoryLabel || '';

const fmtValue = (value, precision) => {
    if (!Number.isFinite(Number(value))) return '--';
    return Number(value).toFixed(precision);
};

// Trim trailing zeros for compact scale text (0…500 not 0.0…500.0).
const fmtScale = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return '--';
    return String(Math.round(n * 100) / 100);
};

// Compact age text for the freshness badge (e.g. "23s", "2m 05s").
const fmtAge = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};

const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
});

// Data-freshness thresholds driving the LIVE / STALE / OFFLINE badge.
const STALE_AFTER_MS = 15 * 1000;
const OFFLINE_AFTER_MS = 60 * 1000;

// ---------------------------------------------------------------------------
// Time window presets
// ---------------------------------------------------------------------------

const TIME_WINDOWS = [
    { label: '5m', ms: 5 * 60 * 1000, range: '-5m' },
    { label: '15m', ms: 15 * 60 * 1000, range: '-15m' },
    { label: '30m', ms: 30 * 60 * 1000, range: '-30m' },
    { label: '1H', ms: 60 * 60 * 1000, range: '-1h' },
    { label: '2H', ms: 2 * 60 * 60 * 1000, range: '-2h' },
    { label: '4H', ms: 4 * 60 * 60 * 1000, range: '-4h' }
];
const DEPTH_SPANS = [
    { label: '25m', m: 25 },
    { label: '50m', m: 50 },
    { label: '100m', m: 100 },
    { label: '250m', m: 250 },
    { label: '500m', m: 500 }
];

// ---------------------------------------------------------------------------
// Config normalization / persistence
// ---------------------------------------------------------------------------

const normalizePen = (pen, fallbackColorIndex) => {
    const src = pen && typeof pen === 'object' ? pen : {};
    const channelId = METRIC_LOOKUP.has(src.channelId) ? src.channelId : ALL_METRIC_IDS[0];
    const meta = METRIC_LOOKUP.get(channelId);
    let min = Number.isFinite(Number(src.min)) ? Number(src.min) : (meta?.defaultMin ?? 0);
    let max = Number.isFinite(Number(src.max)) ? Number(src.max) : (meta?.defaultMax ?? 1);
    if (max <= min) max = min + 1;
    return {
        channelId,
        min,
        max,
        color: COLOR_RE.test(src.color || '') ? src.color : PEN_COLORS[fallbackColorIndex % PEN_COLORS.length],
        enabled: src.enabled !== false
    };
};

const normalizeStrips = (strips) => {
    if (!Array.isArray(strips)) return [];
    return strips.map((strip, si) => ({
        title: typeof strip?.title === 'string' && strip.title ? strip.title : `Track ${si + 1}`,
        pens: (Array.isArray(strip?.pens) ? strip.pens : [])
            .slice(0, MAX_PENS)
            .map((pen, pi) => normalizePen(pen, si + pi))
    }));
};

// Keep only known channels, dedupe, cap to MAX_READOUTS.
const normalizeReadouts = (ids) => {
    if (!Array.isArray(ids)) return [];
    const seen = new Set();
    const out = [];
    ids.forEach(id => {
        if (METRIC_LOOKUP.has(id) && !seen.has(id)) {
            seen.add(id);
            out.push(id);
        }
    });
    return out.slice(0, MAX_READOUTS);
};

const loadPersisted = (storageKey, defaultStrips, defaultReadouts) => {
    const fallback = {
        strips: normalizeStrips(defaultStrips),
        indexMode: 'time',
        readouts: normalizeReadouts(defaultReadouts)
    };
    if (!storageKey) return fallback;
    try {
        const raw = localStorage.getItem(storageKey);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        const strips = normalizeStrips(parsed?.strips);
        // Only adopt a persisted readout list if the key has one saved; otherwise
        // fall back to the prop default (covers first run after this feature ships).
        const readouts = Array.isArray(parsed?.readouts)
            ? normalizeReadouts(parsed.readouts)
            : fallback.readouts;
        return {
            strips: strips.length ? strips : fallback.strips,
            indexMode: parsed?.indexMode === 'depth' ? 'depth' : 'time',
            readouts
        };
    } catch (e) {
        return fallback;
    }
};

// ---------------------------------------------------------------------------
// Channel select (grouped by category)
// ---------------------------------------------------------------------------

function ChannelSelect({ value, onChange, channels, sx }) {
    const allowed = channels && channels.length
        ? new Set(channels)
        : null;
    const groups = edrCatalog.categories
        .map(cat => ({
            cat,
            fields: cat.fields.filter(f => !allowed || allowed.has(`${cat.id}.${f.id}`))
        }))
        .filter(g => g.fields.length);
    return (
        <Select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            size="small"
            MenuProps={{ PaperProps: { sx: { maxHeight: 360 } } }}
            sx={sx}
        >
            {groups.flatMap(({ cat, fields }) => [
                <ListSubheader key={`h-${cat.id}`} sx={{ fontWeight: 800, lineHeight: '30px', fontSize: '0.72rem', letterSpacing: 0.4 }}>
                    {cat.label.toUpperCase()}
                </ListSubheader>,
                ...fields.map(f => (
                    <MenuItem key={`${cat.id}.${f.id}`} value={`${cat.id}.${f.id}`} sx={{ fontSize: '0.82rem' }}>
                        {f.label}{f.unit ? ` (${f.unit})` : ''}
                    </MenuItem>
                ))
            ])}
        </Select>
    );
}

// ---------------------------------------------------------------------------
// Readouts config (multi-select from the catalog, grouped by category)
// ---------------------------------------------------------------------------

function ReadoutsConfig({ value, onChange, channels, surface, border, text, subText, accent }) {
    const allowed = channels && channels.length ? new Set(channels) : null;
    const groups = edrCatalog.categories
        .map(cat => ({
            cat,
            fields: cat.fields.filter(f => !allowed || allowed.has(`${cat.id}.${f.id}`))
        }))
        .filter(g => g.fields.length);

    const handleChange = (e) => {
        const next = typeof e.target.value === 'string' ? e.target.value.split(',') : e.target.value;
        onChange(normalizeReadouts(next));
    };

    return (
        <FormControl size="small">
            <Select
                multiple
                displayEmpty
                value={value}
                onChange={handleChange}
                MenuProps={{ PaperProps: { sx: { maxHeight: 380, bgcolor: surface, color: text } } }}
                IconComponent={() => null}
                renderValue={() => (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, color: subText }}>
                        <SlidersHorizontal size={15} />
                        <Box component="span" sx={{ fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                            Readouts
                        </Box>
                    </Box>
                )}
                sx={{
                    color: text,
                    bgcolor: surface,
                    '& .MuiSelect-select': { py: 0.45, pl: 1, pr: '10px !important' },
                    '& .MuiOutlinedInput-notchedOutline': { borderColor: border },
                    '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: accent }
                }}
            >
                <ListSubheader sx={{ bgcolor: surface, color: subText, fontWeight: 800, fontSize: '0.66rem', lineHeight: '26px', letterSpacing: 0.4 }}>
                    PICK READOUTS ({value.length}/{MAX_READOUTS})
                </ListSubheader>
                {groups.flatMap(({ cat, fields }) => [
                    <ListSubheader key={`h-${cat.id}`} sx={{ bgcolor: surface, fontWeight: 800, lineHeight: '28px', fontSize: '0.7rem', letterSpacing: 0.4, color: subText }}>
                        {cat.label.toUpperCase()}
                    </ListSubheader>,
                    ...fields.map(f => {
                        const id = `${cat.id}.${f.id}`;
                        const checked = value.includes(id);
                        const atCap = !checked && value.length >= MAX_READOUTS;
                        return (
                            <MenuItem key={id} value={id} disabled={atCap} sx={{ py: 0.25, fontSize: '0.82rem' }}>
                                <Checkbox size="small" checked={checked} sx={{ p: 0.5, mr: 0.5, color: subText, '&.Mui-checked': { color: accent } }} />
                                <ListItemText
                                    primary={`${f.label}${f.unit ? ` (${f.unit})` : ''}`}
                                    primaryTypographyProps={{ sx: { fontSize: '0.82rem' } }}
                                />
                            </MenuItem>
                        );
                    })
                ])}
            </Select>
        </FormControl>
    );
}

// ---------------------------------------------------------------------------
// Big numeric readout tile (top row + left depth band share this look)
// ---------------------------------------------------------------------------

function ReadoutTile({ id, value, surface, border, text, subText, accent, valueColor, valueSize = '1.45rem', minWidth = 120, showCategory = true }) {
    return (
        <Paper
            elevation={0}
            sx={{
                flex: '1 1 0',
                minWidth,
                bgcolor: surface,
                border: `1px solid ${border}`,
                borderRadius: 1.5,
                px: 1.25,
                py: 0.5,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: 0.1,
                position: 'relative',
                overflow: 'hidden'
            }}
        >
            <Box sx={{ position: 'absolute', left: 0, top: 6, bottom: 6, width: 3, borderRadius: 2, bgcolor: accent, opacity: 0.85 }} />
            <Typography sx={{ color: subText, fontSize: '0.62rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {channelLabel(id)}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5 }}>
                <Typography sx={{ color: valueColor || text, fontSize: valueSize, fontWeight: 900, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>
                    {fmtValue(value, channelPrecision(id))}
                </Typography>
                <Typography sx={{ color: subText, fontSize: '0.72rem', fontWeight: 700 }}>{channelUnit(id)}</Typography>
            </Box>
            {showCategory && (
                <Typography sx={{ color: subText, fontSize: '0.54rem', opacity: 0.75, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {channelCategory(id)}
                </Typography>
            )}
        </Paper>
    );
}

// ---------------------------------------------------------------------------
// Vertical scroll rail (up/down) — placed on BOTH left and right edges
// ---------------------------------------------------------------------------

function ScrollRail({ onUp, onDown, onHoldUp, onHoldDown, onHoldStop, upTip, downTip, downDisabled, text, border, top, bottom }) {
    const btnSx = {
        color: text,
        border: `1px solid ${border}`,
        borderRadius: 1,
        p: 0.35
    };
    // Press-and-hold: start a repeating scroll on pointer-down, stop on up/leave.
    // The onClick still fires for a quick tap = exactly one step.
    const holdProps = (onHold) => ({
        onPointerDown: (e) => { if (e.button === 0) onHold?.(); },
        onPointerUp: onHoldStop,
        onPointerLeave: onHoldStop,
        onPointerCancel: onHoldStop
    });
    return (
        <Box
            sx={{
                flex: '0 0 auto',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                alignItems: 'center',
                mt: `${top}px`,
                mb: `${bottom}px`
            }}
        >
            <MuiTooltip title={upTip} placement="left">
                <span><IconButton size="small" onClick={onUp} {...holdProps(onHoldUp)} sx={btnSx}><ChevronsUp size={16} /></IconButton></span>
            </MuiTooltip>
            <MuiTooltip title={downTip} placement="left">
                <span><IconButton size="small" onClick={onDown} disabled={downDisabled} {...(downDisabled ? {} : holdProps(onHoldDown))} sx={btnSx}><ChevronsDown size={16} /></IconButton></span>
            </MuiTooltip>
        </Box>
    );
}

// ---------------------------------------------------------------------------
// SVG strip chart
// ---------------------------------------------------------------------------

function StripChart({ strip, samples, indexMode, indexDomain, accentColor, gridColor, axisTextColor, surface, border, subText, textColor, compact = false }) {
    const ref = useRef(null);
    const [size, setSize] = useState({ w: 240, h: 260 });
    // Hovered cursor position, in fractional [0..1] of chart height (null = no hover).
    // We keep only this lightweight state and recompute the tooltip contents on
    // render — updates are throttled via requestAnimationFrame in the move handler.
    const [cursorFrac, setCursorFrac] = useState(null);
    const rafRef = useRef(0);
    const pendingFracRef = useRef(null);

    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(entries => {
            const cr = entries[0]?.contentRect;
            if (cr) setSize({ w: Math.max(40, cr.width), h: Math.max(40, cr.height) });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Flush any scheduled rAF on unmount.
    useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);

    const enabledPens = useMemo(() => strip.pens.filter(p => p.enabled), [strip.pens]);
    const { w, h } = size;
    const padX = 6;
    const innerW = Math.max(1, w - padX * 2);

    // Vertical gridlines (5 columns).
    const vLines = [0.25, 0.5, 0.75].map(f => padX + f * innerW);
    // Horizontal gridlines map to the shared index domain.
    const [d0, d1] = indexDomain;
    const span = d1 - d0 || 1;
    const yFor = (idx) => ((idx - d0) / span) * h;

    const hTickCount = Math.max(2, Math.min(8, Math.round(h / 48)));
    const hLines = Array.from({ length: hTickCount + 1 }, (_, i) => (i / hTickCount));

    // --- Hover crosshair / tooltip plumbing ---
    // Pointer Y -> fraction of height, scheduled on rAF so mousemove can't thrash.
    const handleMove = (e) => {
        const el = ref.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        if (!rect.height) return;
        const frac = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
        pendingFracRef.current = frac;
        if (rafRef.current) return;
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = 0;
            setCursorFrac(pendingFracRef.current);
        });
    };
    const handleLeave = () => {
        if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
        pendingFracRef.current = null;
        setCursorFrac(null);
    };

    // Index value under the cursor (timestamp in time mode, depth in depth mode).
    const cursorIndex = cursorFrac == null ? null : d0 + cursorFrac * span;
    const indexKey = indexMode === 'depth' ? 'depth' : 'timestamp';

    // Median spacing between consecutive samples (index units) — used to detect
    // when the cursor sits in a data gap and the "nearest" sample is misleading.
    const medianSpacing = useMemo(() => {
        if (samples.length < 2) return null;
        const gaps = [];
        for (let i = 1; i < samples.length; i += 1) {
            const g = samples[i][indexKey] - samples[i - 1][indexKey];
            if (Number.isFinite(g) && g > 0) gaps.push(g);
        }
        if (!gaps.length) return null;
        gaps.sort((a, b) => a - b);
        return gaps[Math.floor(gaps.length / 2)];
    }, [samples, indexKey]);

    // Nearest sample to the cursor index — samples are sorted by timestamp/depth,
    // so a binary search finds the neighbourhood instead of a full linear scan.
    const nearest = useMemo(() => {
        if (cursorIndex == null || !samples.length) return null;
        let lo = 0;
        let hi = samples.length - 1;
        while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (samples[mid][indexKey] < cursorIndex) lo = mid; else hi = mid;
        }
        const dLo = Math.abs(samples[lo][indexKey] - cursorIndex);
        const dHi = Math.abs(samples[hi][indexKey] - cursorIndex);
        return dLo <= dHi
            ? { sample: samples[lo], dist: dLo }
            : { sample: samples[hi], dist: dHi };
    }, [cursorIndex, samples, indexKey]);

    // Cursor is over a gap (nearest sample far beyond typical spacing): show
    // "no data here" instead of a misleading far-away value.
    const cursorInGap = nearest != null && medianSpacing != null && nearest.dist > medianSpacing * 2;
    const nearestSample = cursorInGap ? null : (nearest ? nearest.sample : null);

    // When the visible window crosses midnight, HH:MM:SS alone is ambiguous —
    // include the date in the tooltip index line.
    const crossesMidnight = indexMode !== 'depth'
        && new Date(d0).toDateString() !== new Date(d1).toDateString();
    const fmtIndex = (v) => {
        if (indexMode === 'depth') return `${fmtScale(v)} m`;
        const t = fmtClock(v);
        return crossesMidnight
            ? `${new Date(v).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${t}`
            : t;
    };

    // Tooltip box geometry — clamp inside the strip and flip side near edges.
    const showTooltip = cursorFrac != null && enabledPens.length > 0 && (nearestSample || cursorInGap);
    const tipRows = nearestSample
        ? enabledPens.map(pen => ({
            color: pen.color,
            name: channelLabel(pen.channelId),
            unit: channelUnit(pen.channelId),
            value: fmtValue(nearestSample.values[pen.channelId], channelPrecision(pen.channelId))
        }))
        : [];

    // Per-pen path strings + current-value marker positions, memoized so hover
    // (crosshair/tooltip state) never re-stringifies the SVG paths. Samples that
    // exceed the pen range are CLAMPED to the rail — those segments go to a
    // separate DASHED "off-scale" path so clamping is visible, not silent.
    const penGeom = useMemo(() => (
        enabledPens.map(pen => {
            const range = pen.max - pen.min || 1;
            const xFor = (raw) => {
                const clamped = Math.max(pen.min, Math.min(pen.max, raw));
                return padX + ((clamped - pen.min) / range) * innerW;
            };
            let dOn = '';
            let dOff = '';
            let prev = null;
            for (let i = 0; i < samples.length; i += 1) {
                const s = samples[i];
                const raw = Number(s.values[pen.channelId]);
                const idx = indexMode === 'depth' ? s.depth : s.timestamp;
                if (!Number.isFinite(raw) || !Number.isFinite(Number(idx))) {
                    prev = null; // break the line over gaps
                    continue;
                }
                const off = raw < pen.min || raw > pen.max;
                const x = xFor(raw).toFixed(1);
                const y = yFor(idx).toFixed(1);
                if (prev) {
                    const seg = `M${prev.x},${prev.y}L${x},${y}`;
                    if (off || prev.off) dOff += seg; else dOn += seg;
                }
                prev = { x, y, off };
            }
            // Current value position for the thin marker (latest sample with a value).
            let marker = null;
            for (let i = samples.length - 1; i >= 0; i -= 1) {
                const raw = Number(samples[i].values[pen.channelId]);
                if (Number.isFinite(raw)) {
                    marker = xFor(raw);
                    break;
                }
            }
            return { pen, dOn, dOff, marker };
        })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    ), [samples, enabledPens, indexMode, d0, d1, w, h]);

    // "Data begins" marker — when the buffer covers only a small fraction of the
    // visible window (e.g. fresh restart), mark where the data starts so the
    // blank region above reads as honest absence, not breakage.
    const dataStartMarker = useMemo(() => {
        if (indexMode === 'depth' || !samples.length) return null;
        const first = samples[0].timestamp;
        const last = samples[samples.length - 1].timestamp;
        if (!Number.isFinite(first) || !Number.isFinite(last)) return null;
        if ((last - first) >= span * 0.2) return null;
        const frac = (first - d0) / span;
        if (frac < 0.03 || frac > 1) return null;
        return { frac, label: new Date(first).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [indexMode, samples, d0, span]);

    // Static chart body (grid + scale labels + pens + markers) memoized as a
    // whole so hover state changes only touch the absolutely-positioned
    // crosshair/tooltip overlays, never the SVG.
    const scaleFont = compact ? 7.5 : 9;
    const svgEl = useMemo(() => (
        <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
            {/* horizontal index gridlines */}
            {hLines.map((f, i) => (
                <line key={`h${i}`} x1={0} x2={w} y1={f * h} y2={f * h} stroke={gridColor} strokeWidth={0.5} />
            ))}
            {/* vertical scale gridlines */}
            {vLines.map((x, i) => (
                <line key={`v${i}`} x1={x} x2={x} y1={0} y2={h} stroke={gridColor} strokeWidth={0.5} />
            ))}
            {/* per-pen min/mid/max value-scale labels along the track edge (kept in compact mode) */}
            {penGeom.map(({ pen }, i) => {
                const ty = 8 + i * (scaleFont + 3);
                return (
                    <g key={`s${i}`} style={{ fontSize: `${scaleFont}px`, fontWeight: 700 }} fill={pen.color} opacity={0.85}>
                        <text x={padX + 1} y={ty} textAnchor="start">{fmtScale(pen.min)}</text>
                        <text x={w / 2} y={ty} textAnchor="middle">{fmtScale((pen.min + pen.max) / 2)}</text>
                        <text x={w - padX - 1} y={ty} textAnchor="end">{fmtScale(pen.max)}</text>
                    </g>
                );
            })}
            {/* pens — solid in range, dashed where samples were clamped off-scale */}
            {penGeom.map(({ pen, dOn, dOff }, i) => (
                <g key={`p${i}`}>
                    {dOn ? (
                        <path d={dOn} fill="none" stroke={pen.color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
                    ) : null}
                    {dOff ? (
                        <path d={dOff} fill="none" stroke={pen.color} strokeWidth={1.6} strokeDasharray="3 3" strokeLinejoin="round" strokeLinecap="round" opacity={0.9} vectorEffect="non-scaling-stroke" />
                    ) : null}
                </g>
            ))}
            {/* thin current-value markers */}
            {penGeom.map(({ pen, marker }, i) => (marker == null ? null : (
                <line
                    key={`m${i}`}
                    x1={marker}
                    x2={marker}
                    y1={0}
                    y2={h}
                    stroke={pen.color}
                    strokeWidth={0.75}
                    strokeDasharray="2 3"
                    opacity={0.5}
                    vectorEffect="non-scaling-stroke"
                />
            )))}
        </svg>
        // eslint-disable-next-line react-hooks/exhaustive-deps
    ), [penGeom, w, h, gridColor, scaleFont]);

    return (
        <Box
            ref={ref}
            onPointerMove={handleMove}
            onPointerLeave={handleLeave}
            sx={{ position: 'relative', width: '100%', height: '100%' }}
        >
            {svgEl}
            {/* "data begins" marker — subtle line + label at the start of the buffer */}
            {dataStartMarker && (
                <Box sx={{ position: 'absolute', left: 0, right: 0, top: `${dataStartMarker.frac * 100}%`, pointerEvents: 'none', zIndex: 2 }}>
                    <Box sx={{ borderTop: `1px dashed ${subText}`, opacity: 0.55 }} />
                    <Typography sx={{ color: subText, fontSize: '0.56rem', fontWeight: 700, opacity: 0.85, px: 0.5, whiteSpace: 'nowrap' }}>
                        data begins at {dataStartMarker.label}
                    </Typography>
                </Box>
            )}
            {/* hover crosshair — absolutely-positioned overlay (thin horizontal
                cursor line) so hover never re-renders the memoized SVG */}
            {cursorFrac != null && (
                <Box
                    sx={{
                        position: 'absolute',
                        left: 0,
                        right: 0,
                        top: `${cursorFrac * 100}%`,
                        borderTop: `1px solid ${accentColor}`,
                        opacity: 0.85,
                        pointerEvents: 'none',
                        zIndex: 4
                    }}
                />
            )}
            {/* hover tooltip — index value + per-pen color/name/value at nearest sample */}
            {showTooltip && (
                <Box
                    sx={{
                        position: 'absolute',
                        left: cursorFrac > 0.5 ? 4 : 'auto',
                        right: cursorFrac > 0.5 ? 'auto' : 4,
                        // place near the cursor but keep the box on-screen vertically
                        top: `${Math.max(2, Math.min(82, cursorFrac * 100))}%`,
                        zIndex: 5,
                        pointerEvents: 'none',
                        bgcolor: surface,
                        border: `1px solid ${border}`,
                        borderRadius: 1,
                        boxShadow: 3,
                        px: 0.85,
                        py: 0.6,
                        maxWidth: '92%',
                        minWidth: 0
                    }}
                >
                    <Typography sx={{ color: subText, fontSize: '0.6rem', fontWeight: 800, letterSpacing: 0.3, mb: 0.35, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                        {fmtIndex(cursorIndex)}
                    </Typography>
                    {cursorInGap && (
                        <Typography sx={{ color: subText, fontSize: '0.62rem', fontStyle: 'italic', whiteSpace: 'nowrap' }}>
                            no data here
                        </Typography>
                    )}
                    {tipRows.map((r, i) => (
                        <Box key={i} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, lineHeight: 1.25 }}>
                            <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: r.color, flex: '0 0 auto' }} />
                            <Typography component="span" sx={{ color: textColor, fontSize: '0.62rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 110 }}>
                                {r.name}
                            </Typography>
                            <Typography component="span" sx={{ color: r.color, fontSize: '0.66rem', fontWeight: 900, ml: 'auto', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                                {r.value}{r.unit ? <Box component="span" sx={{ color: subText, fontSize: '0.85em', fontWeight: 700, ml: 0.25 }}>{r.unit}</Box> : null}
                            </Typography>
                        </Box>
                    ))}
                </Box>
            )}
            {enabledPens.length === 0 && (
                <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', pointerEvents: 'none' }}>
                    <Typography sx={{ color: axisTextColor, fontSize: '0.7rem', opacity: 0.6 }}>No pens</Typography>
                </Box>
            )}
        </Box>
    );
}

// ---------------------------------------------------------------------------
// Fixed-height bottom "variables" block — the critical requirement.
//
// Always exactly BOTTOM_H tall. Content adapts to pen count so 1 pen is
// comfortable and 3 pens still fit the SAME height. Compaction order as the
// per-row height shrinks: (1) smaller font, (2) drop min…max scale, (3) drop
// NAME (keep unit), (4) keep only the color-coded VALUE.
// ---------------------------------------------------------------------------

function StripVariables({ strip, latest, compact, surface, border, subText }) {
    const BOTTOM_H = compact ? 64 : 96;
    const enabledPens = strip.pens.filter(p => p.enabled);
    const n = Math.max(1, enabledPens.length);
    const rowH = BOTTOM_H / Math.max(n, compact ? 2 : 1); // reserve at least 2 slots in compact

    // Compaction thresholds keyed off available per-row height.
    const fontValue = rowH >= 40 ? '1.15rem' : rowH >= 30 ? '0.98rem' : rowH >= 22 ? '0.86rem' : '0.78rem';
    const fontMeta = rowH >= 30 ? '0.62rem' : '0.58rem';
    const showScale = rowH >= 30;     // (2) drop scale first
    const showName = rowH >= 24;      // (3) then name (keep unit)

    return (
        <Box
            sx={{
                flex: `0 0 ${BOTTOM_H}px`,
                height: BOTTOM_H,
                mt: 0.5,
                bgcolor: surface,
                border: `1px solid ${border}`,
                borderRadius: 1,
                px: 0.75,
                py: 0.5,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-evenly',
                overflow: 'hidden'
            }}
        >
            {enabledPens.length === 0 ? (
                <Typography sx={{ color: subText, fontSize: '0.7rem', textAlign: 'center', alignSelf: 'center' }}>—</Typography>
            ) : enabledPens.map((pen, i) => {
                const unit = channelUnit(pen.channelId);
                const value = latest?.[pen.channelId];
                // Current value outside the pen's [min,max] — the trace is clamped
                // to the rail, so flag the readout as off-scale.
                const num = Number(value);
                const offScale = Number.isFinite(num) && (num < pen.min || num > pen.max);
                // Full-detail tooltip so a compacted row (unit-only / value-only) is
                // still identifiable on hover: Name (unit) · min…max · current value.
                const tipTitle = `${channelLabel(pen.channelId)}${unit ? ` (${unit})` : ''} · ${fmtScale(pen.min)}…${fmtScale(pen.max)} · ${fmtValue(value, channelPrecision(pen.channelId))}${unit ? ` ${unit}` : ''}${offScale ? ' · OFF-SCALE (trace clamped)' : ''}`;
                return (
                    <MuiTooltip key={i} title={tipTitle} placement="top" arrow>
                    <Box
                        sx={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 0.6,
                            minWidth: 0,
                            lineHeight: 1.05,
                            cursor: 'default'
                        }}
                    >
                        <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: pen.color, flex: '0 0 auto' }} />
                        <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
                            <Typography
                                component="div"
                                sx={{
                                    color: subText,
                                    fontSize: fontMeta,
                                    fontWeight: 700,
                                    textTransform: 'uppercase',
                                    letterSpacing: 0.2,
                                    whiteSpace: 'nowrap',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis'
                                }}
                            >
                                {/* compaction (3): drop NAME, keep unit */}
                                {showName
                                    ? `${channelLabel(pen.channelId)}${unit ? ` (${unit})` : ''}`
                                    : (unit || channelLabel(pen.channelId))}
                                {/* compaction (2): drop min…max scale first */}
                                {showScale && (
                                    <Box component="span" sx={{ opacity: 0.7, ml: 0.5 }}>
                                        · {fmtScale(pen.min)}…{fmtScale(pen.max)}
                                    </Box>
                                )}
                            </Typography>
                        </Box>
                        <Typography
                            sx={{
                                color: pen.color,
                                fontSize: fontValue,
                                fontWeight: 900,
                                fontVariantNumeric: 'tabular-nums',
                                whiteSpace: 'nowrap',
                                flex: '0 0 auto'
                            }}
                        >
                            {fmtValue(value, channelPrecision(pen.channelId))}
                            {/* compaction (4): when name+unit are dropped from the meta line, keep unit beside the value */}
                            {!showName && unit ? (
                                <Box component="span" sx={{ fontSize: '0.6em', ml: 0.3, color: subText, fontWeight: 700 }}>{unit}</Box>
                            ) : null}
                            {/* off-scale flag: current value is beyond the pen range (trace clamped) */}
                            {offScale ? (
                                <Box component="span" sx={{ fontSize: '0.5em', ml: 0.4, px: 0.35, py: 0.1, borderRadius: 0.5, border: '1px solid #f59e0b', color: '#f59e0b', fontWeight: 800, letterSpacing: 0.4, verticalAlign: 'middle', whiteSpace: 'nowrap' }}>
                                    OFF-SCALE
                                </Box>
                            ) : null}
                        </Typography>
                    </Box>
                    </MuiTooltip>
                );
            })}
        </Box>
    );
}

// ---------------------------------------------------------------------------
// Per-strip config dialog
// ---------------------------------------------------------------------------

function StripConfigDialog({ open, onClose, strip, stripIndex, onSave, channels, surface, border, text, subText }) {
    const [draft, setDraft] = useState(strip);
    useEffect(() => { if (open) setDraft(JSON.parse(JSON.stringify(strip))); }, [open, strip]);

    const updatePen = (pi, patch) => {
        setDraft(prev => ({
            ...prev,
            pens: prev.pens.map((p, i) => (i === pi ? { ...p, ...patch } : p))
        }));
    };
    const onChannel = (pi, channelId) => {
        const meta = METRIC_LOOKUP.get(channelId);
        updatePen(pi, {
            channelId,
            min: meta?.defaultMin ?? 0,
            max: meta?.defaultMax ?? 1
        });
    };
    const addPen = () => {
        setDraft(prev => ({
            ...prev,
            pens: [...prev.pens, normalizePen({ channelId: (channels && channels[0]) || ALL_METRIC_IDS[0] }, prev.pens.length)]
        }));
    };
    const removePen = (pi) => {
        setDraft(prev => ({ ...prev, pens: prev.pens.filter((_, i) => i !== pi) }));
    };

    const fieldSx = { '& .MuiInputBase-root': { color: text }, '& .MuiOutlinedInput-notchedOutline': { borderColor: border } };

    return (
        <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ sx: { bgcolor: surface, color: text, border: `1px solid ${border}` } }}>
            <DialogTitle sx={{ fontWeight: 900, borderBottom: `1px solid ${border}`, fontSize: '1rem' }}>
                Configure “{strip.title}”
            </DialogTitle>
            <DialogContent dividers sx={{ borderColor: border }}>
                <TextField
                    label="Track title"
                    value={draft.title}
                    onChange={(e) => setDraft(prev => ({ ...prev, title: e.target.value }))}
                    size="small"
                    fullWidth
                    sx={{ ...fieldSx, mb: 2 }}
                />
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                    {draft.pens.map((pen, pi) => (
                        <Paper key={pi} sx={{ p: 1.25, bgcolor: 'transparent', border: `1px solid ${border}`, borderRadius: 1 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                <IconButton
                                    size="small"
                                    onClick={() => updatePen(pi, { enabled: !pen.enabled })}
                                    sx={{ color: pen.enabled ? pen.color : subText }}
                                    title={pen.enabled ? 'Pen on' : 'Pen off'}
                                >
                                    <Box sx={{ width: 14, height: 14, borderRadius: '3px', bgcolor: pen.enabled ? pen.color : 'transparent', border: `2px solid ${pen.color}` }} />
                                </IconButton>
                                <FormControl size="small" fullWidth>
                                    <ChannelSelect
                                        value={pen.channelId}
                                        onChange={(v) => onChannel(pi, v)}
                                        channels={channels}
                                        sx={{ color: text, '& .MuiOutlinedInput-notchedOutline': { borderColor: border } }}
                                    />
                                </FormControl>
                                <IconButton size="small" onClick={() => removePen(pi)} sx={{ color: subText }} title="Remove pen">
                                    <Trash2 size={16} />
                                </IconButton>
                            </Box>
                            <Grid container spacing={1}>
                                <Grid item xs={4}>
                                    <TextField
                                        label="Min" type="number" size="small" fullWidth sx={fieldSx}
                                        value={pen.min}
                                        onChange={(e) => updatePen(pi, { min: Number(e.target.value) })}
                                    />
                                </Grid>
                                <Grid item xs={4}>
                                    <TextField
                                        label="Max" type="number" size="small" fullWidth sx={fieldSx}
                                        value={pen.max}
                                        onChange={(e) => updatePen(pi, { max: Number(e.target.value) })}
                                    />
                                </Grid>
                                <Grid item xs={4}>
                                    <TextField
                                        label="Color" type="color" size="small" fullWidth
                                        sx={{ ...fieldSx, '& input': { height: 23, p: '4px' } }}
                                        value={COLOR_RE.test(pen.color) ? pen.color : '#38bdf8'}
                                        onChange={(e) => updatePen(pi, { color: e.target.value })}
                                    />
                                </Grid>
                            </Grid>
                        </Paper>
                    ))}
                </Box>
                <Button
                    startIcon={<Plus size={16} />}
                    onClick={addPen}
                    disabled={draft.pens.length >= MAX_PENS}
                    sx={{ mt: 1.5, color: text, borderColor: border }}
                    variant="outlined"
                    size="small"
                >
                    Add pen ({draft.pens.length}/{MAX_PENS})
                </Button>
            </DialogContent>
            <DialogActions sx={{ borderTop: `1px solid ${border}`, p: 1.5 }}>
                <Button onClick={onClose} sx={{ color: subText }}>Cancel</Button>
                <Button
                    variant="contained"
                    onClick={() => { onSave(stripIndex, normalizeStrips([draft])[0]); onClose(); }}
                >
                    Apply
                </Button>
            </DialogActions>
        </Dialog>
    );
}

// ---------------------------------------------------------------------------
// EdrView main
// ---------------------------------------------------------------------------

export default function EdrView({
    rigId,
    mode = 'full',
    storageKey,
    defaultStrips = [],
    rightReadouts = [],
    channels = null,
    window: replayWindow = null
}) {
    const theme = useTheme();
    const isCompact = mode === 'compact';
    // OFFLINE REPLAY mode: when a fixed window {fromMs,toMs,label} is supplied we seed
    // from a FIXED RANGE (api.rigHistoryRange) instead of the rolling history, do NOT
    // ingest live updates, and pin the index domain to [fromMs,toMs] (an EDR replaying a
    // PAST well run). When null, behaviour is EXACTLY the live path as before.
    const offline = !!(replayWindow && Number.isFinite(Number(replayWindow.fromMs)) && Number.isFinite(Number(replayWindow.toMs)));
    const winFromMs = offline ? Number(replayWindow.fromMs) : null;
    const winToMs = offline ? Number(replayWindow.toMs) : null;
    const winLabel = replayWindow?.label;
    // Central live payload (edge `rig_data` shape) for this rig — polled by RigDataProvider.
    const { data: liveData } = useRigData();

    // Theme-derived tokens (work across all 4 themes).
    const isDark = theme.palette.mode === 'dark';
    const panelBg = theme.palette.background.paper;
    const chartBg = isDark ? 'rgba(0,0,0,0.55)' : 'rgba(15,23,42,0.04)';
    const border = isDark ? 'rgba(148,163,184,0.28)' : 'rgba(15,23,42,0.18)';
    const gridColor = isDark ? 'rgba(148,163,184,0.18)' : 'rgba(15,23,42,0.12)';
    const text = theme.palette.text.primary;
    const subText = theme.palette.text.secondary || (isDark ? '#94a3b8' : '#475569');
    const accent = theme.palette.primary.main;

    const initial = useMemo(() => loadPersisted(storageKey, defaultStrips, rightReadouts), [storageKey]); // eslint-disable-line react-hooks/exhaustive-deps
    const [strips, setStrips] = useState(initial.strips);
    const [indexMode, setIndexMode] = useState(initial.indexMode);
    // Configurable TOP readouts (full mode). Defaults to the rightReadouts prop.
    const [readouts, setReadouts] = useState(initial.readouts);

    const [timeWinIdx, setTimeWinIdx] = useState(isCompact ? 0 : 1);
    const [depthSpanIdx, setDepthSpanIdx] = useState(2);
    const [scrollOffset, setScrollOffset] = useState(0); // ms back in time, or m up in depth
    const [configStrip, setConfigStrip] = useState(null);

    const [data, setData] = useState([]); // [{ timestamp, depth, values:{channelId:value} }]
    const dragRef = useRef(null);

    // History-seed request state (UI-13). Non-blocking: overlays only, so live
    // ingestion keeps painting while the seed is in flight or has failed.
    const [histLoading, setHistLoading] = useState(false);
    const [histError, setHistError] = useState(null);
    const [histEmpty, setHistEmpty] = useState(false);

    // Wall-clock tick (1s). Anchors the live window's bottom edge to NOW (so a
    // visible gap opens when ingestion stops) and drives the freshness badge.
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        if (offline) return undefined;
        const id = setInterval(() => setNowMs(Date.now()), 1000);
        return () => clearInterval(id);
    }, [offline]);

    // Persist strip config + index mode + readout selection (same storageKey).
    useEffect(() => {
        if (!storageKey) return;
        try {
            localStorage.setItem(storageKey, JSON.stringify({ strips, indexMode, readouts }));
        } catch (e) { /* best effort */ }
    }, [storageKey, strips, indexMode, readouts]);

    // Set of channels we need to fetch (all pens + readouts + depth band).
    const neededChannels = useMemo(() => {
        const set = new Set([HOLE_DEPTH_METRIC, BIT_DEPTH_METRIC]);
        strips.forEach(s => s.pens.forEach(p => set.add(p.channelId)));
        if (!isCompact) readouts.forEach(id => set.add(id));
        return Array.from(set);
    }, [strips, readouts, isCompact]);

    const timeWindowMs = TIME_WINDOWS[timeWinIdx]?.ms ?? TIME_WINDOWS[0].ms;
    const timeRange = TIME_WINDOWS[timeWinIdx]?.range ?? '-15m';

    // ---- History seed ----
    // Shared row->sample mapper for both the rolling (live) and fixed-range (offline) seeds.
    const rowsToSamples = useCallback((rows) => (
        (Array.isArray(rows) ? rows : []).map(row => {
            const values = {};
            neededChannels.forEach(id => { values[id] = row[id]; });
            return {
                timestamp: Number(row.t),
                depth: Number(row[DEPTH_INDEX_METRIC] ?? row['drilling.bit_depth']),
                values
            };
        }).filter(r => Number.isFinite(r.timestamp))
    ), [neededChannels]);

    const historyReq = useRef(0);
    const fetchHistory = useCallback(async () => {
        if (!rigId) return;
        const reqId = ++historyReq.current;
        setHistLoading(true);
        setHistError(null);
        try {
            // Central history is per-rig + bucketed; rows are [{ t:epochms, "<metric>":v }].
            // OFFLINE: seed from the FIXED [fromMs,toMs] range (range mode); LIVE: rolling minutes.
            const res = offline
                ? await api.rigHistoryRange(rigId, neededChannels, winFromMs, winToMs)
                : await api.rigHistoryMulti(rigId, neededChannels, Math.max(1, Math.round(timeWindowMs / 60000)));
            if (reqId !== historyReq.current) return;
            // Re-seed is the ONLY place we sort — live ingest relies on this order.
            const seeded = rowsToSamples(res?.rows).sort((a, b) => a.timestamp - b.timestamp);
            setData(seeded);
            setHistLoading(false);
            setHistEmpty(seeded.length === 0);
        } catch (err) {
            if (reqId !== historyReq.current) return;
            console.error('EdrView: failed to load history', err);
            setHistLoading(false);
            setHistError(err?.message || 'Failed to load recorded data');
        }
    }, [rowsToSamples, neededChannels, timeWindowMs, rigId, offline, winFromMs, winToMs]);

    // ---- Live point ingestion (shared socket) ----
    const ingest = useCallback((payload) => {
        const tsStr = payload?._meta?.ts;
        const ts = tsStr ? new Date(tsStr).getTime() : Date.now();
        const values = {};
        Object.keys(payload || {}).forEach(measurement => {
            const block = payload[measurement];
            if (block && typeof block === 'object') {
                Object.keys(block).forEach(field => {
                    values[`${measurement}.${field}`] = block[field];
                });
            }
        });
        const depth = Number(values[DEPTH_INDEX_METRIC] ?? values['drilling.bit_depth']);
        // Cap the retained buffer to the SELECTED window + headroom for scrollback;
        // widening the window triggers a history re-seed, so nothing is lost.
        const cutoff = ts - (timeWindowMs * 2 + 60 * 1000);
        setData(prev => {
            const point = { timestamp: ts, depth, values };
            const last = prev.length ? prev[prev.length - 1] : null;
            if (!last || ts >= last.timestamp) {
                // FAST PATH (the normal case — timestamps arrive in order):
                // append, or replace the tail when it lands in the same second,
                // then front-prune expired points. No Map rebuild, no full sort.
                let next;
                if (last && Math.floor(ts / 1000) === Math.floor(last.timestamp / 1000)) {
                    next = prev.slice(0, -1);
                    next.push(point);
                } else {
                    next = prev.concat(point);
                }
                let firstKeep = 0;
                while (firstKeep < next.length && (next[firstKeep].timestamp || 0) < cutoff) firstKeep += 1;
                return firstKeep ? next.slice(firstKeep) : next;
            }
            // SLOW PATH (rare out-of-order point): dedupe-by-second + full sort.
            const bySecond = new Map();
            prev.concat(point).forEach(p => {
                bySecond.set(Math.floor((p.timestamp || 0) / 1000), p); // keep latest within a second
            });
            return Array.from(bySecond.values())
                .sort((a, b) => a.timestamp - b.timestamp)
                .filter(p => (p.timestamp || 0) >= cutoff);
        });
    }, [timeWindowMs]);

    // History seed whenever the metric set / time window changes.
    useEffect(() => { fetchHistory(); }, [fetchHistory]);

    // Live point ingestion: the central RigDataProvider polls /api/rigs/:id/live (the
    // edge `rig_data` nested shape with _meta.ts), so feed each new payload to ingest().
    // OFFLINE replay: skip entirely so the fixed-range seed is never polluted by live points.
    useEffect(() => {
        if (offline) return;
        if (liveData && Object.keys(liveData).length) ingest(liveData);
    }, [offline, liveData, ingest]);

    // Reset scroll when switching index modes/windows, or when the OFFLINE replay range
    // changes (snap back to the recorded END so a new range starts at its latest data).
    useEffect(() => { setScrollOffset(0); }, [indexMode, timeWinIdx, depthSpanIdx, offline, winFromMs, winToMs]);

    // ---- Compute index domain + samples for the SVG ----
    const sorted = data; // already time-sorted

    const maxDepth = useMemo(() => sorted.reduce((m, p) => (
        Number.isFinite(p.depth) ? Math.max(m, p.depth) : m
    ), 0), [sorted]);

    const { indexDomain, samples } = useMemo(() => {
        if (indexMode === 'depth') {
            // Bin samples into depth buckets; keep last sample per bin.
            const bins = new Map();
            sorted.forEach(p => {
                if (!Number.isFinite(p.depth)) return;
                const key = Math.round(p.depth / DEPTH_BIN_M);
                bins.set(key, { depth: key * DEPTH_BIN_M, timestamp: p.timestamp, values: p.values });
            });
            const binned = Array.from(bins.values()).sort((a, b) => a.depth - b.depth);
            const span = DEPTH_SPANS[depthSpanIdx]?.m ?? 100;
            // Bottom of window = deepest minus scroll; depth increases downward.
            const bottom = Math.max(span, maxDepth - scrollOffset);
            const top = bottom - span;
            return { indexDomain: [top, bottom], samples: binned };
        }
        // Time mode: newest at the BOTTOM.
        // OFFLINE replay anchors the bottom of the visible window to the recorded end
        // (toMs) so scrollOffset walks back inside the FIXED [fromMs,toMs] range; clamp
        // so the window can't run past the recorded start. LIVE anchors to the WALL
        // CLOCK (nowMs, ticking every second) — NOT the last sample — so a visible
        // gap opens at the bottom edge when ingestion stops instead of the axis freezing.
        const anchor = offline ? winToMs : nowMs;
        let bottom = anchor - scrollOffset;
        if (offline) {
            // Don't scroll the top edge before the recorded start.
            const minBottom = winFromMs + timeWindowMs;
            if (bottom < minBottom) bottom = minBottom;
            if (bottom > winToMs) bottom = winToMs;
        }
        const top = bottom - timeWindowMs;
        return { indexDomain: [top, bottom], samples: sorted };
    }, [indexMode, sorted, depthSpanIdx, maxDepth, scrollOffset, timeWindowMs, offline, winFromMs, winToMs, nowMs]);

    const latestValues = useMemo(() => (sorted.length ? sorted[sorted.length - 1].values : {}), [sorted]);

    // ---- Data freshness (drives the LIVE / STALE / OFFLINE badge + stale overlay) ----
    // Newest of: the live payload's own _meta.ts and the newest buffered sample.
    const lastDataTs = useMemo(() => {
        const metaTs = liveData?._meta?.ts ? new Date(liveData._meta.ts).getTime() : NaN;
        const sampleTs = sorted.length ? sorted[sorted.length - 1].timestamp : NaN;
        const best = Math.max(
            Number.isFinite(metaTs) ? metaTs : -Infinity,
            Number.isFinite(sampleTs) ? sampleTs : -Infinity
        );
        return Number.isFinite(best) && best > 0 ? best : null;
    }, [liveData, sorted]);
    const dataAgeMs = lastDataTs == null ? null : Math.max(0, nowMs - lastDataTs);
    const freshness = offline
        ? 'replay'
        : (dataAgeMs == null || dataAgeMs >= OFFLINE_AFTER_MS)
            ? 'offline'
            : dataAgeMs >= STALE_AFTER_MS ? 'stale' : 'live';
    const freshColor = freshness === 'live' ? '#22c55e' : freshness === 'stale' ? '#f59e0b' : '#ef4444';
    const freshLabel = freshness === 'live'
        ? 'LIVE'
        : freshness === 'stale' ? `STALE · ${fmtAge(dataAgeMs)}` : 'OFFLINE';
    const showStaleOverlay = !offline && freshness !== 'live' && lastDataTs != null;

    // ---- Index axis ticks ----
    const axisTicks = useMemo(() => {
        const [a, b] = indexDomain;
        const count = 6;
        // When the visible window crosses midnight, HH:MM:SS alone is ambiguous —
        // add a small date line to each tick.
        const crossesMidnight = indexMode !== 'depth'
            && new Date(a).toDateString() !== new Date(b).toDateString();
        return Array.from({ length: count + 1 }, (_, i) => {
            const frac = i / count;
            const v = a + frac * (b - a);
            if (indexMode === 'depth') return { frac, label: `${Math.round(v)}`, dateLabel: null };
            return {
                frac,
                label: new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
                dateLabel: crossesMidnight
                    ? new Date(v).toLocaleDateString([], { month: 'short', day: 'numeric' })
                    : null
            };
        });
    }, [indexDomain, indexMode]);

    // ---- Scroll handlers ----
    // One "page" of the visible window; a single rail click moves a half-window.
    const windowLen = indexMode === 'depth'
        ? (DEPTH_SPANS[depthSpanIdx]?.m ?? 100)
        : timeWindowMs;
    const scrollStep = windowLen * 0.5;            // single rail click = half window
    // Smaller increments for continuous (wheel / press-and-hold) scrolling so the
    // motion is smooth rather than jumpy.
    const wheelStep = windowLen * 0.12;            // per wheel notch
    const holdStep = windowLen * 0.06;             // per rAF tick while a button is held

    // Clamp helper: offset can never go below 0 — that is the live edge (or, offline,
    // the recorded END at toMs), so we never scroll into the future. OFFLINE also caps
    // the MAX offset at the recorded START so you can't scroll past the recorded ends.
    const maxOffset = useMemo(() => {
        if (!offline) return Infinity;
        if (indexMode === 'depth') return Infinity; // depth bounds itself via maxDepth
        // Walking the bottom edge from toMs back to (fromMs + window) — the earliest the
        // window can sit while still fully inside the recorded range.
        return Math.max(0, (winToMs - winFromMs) - timeWindowMs);
    }, [offline, indexMode, winFromMs, winToMs, timeWindowMs]);
    const clampOffset = useCallback((next) => Math.min(maxOffset, Math.max(0, next)), [maxOffset]);

    const scrollByAmount = useCallback((delta) => {
        // delta > 0 = back into history (older/shallower); < 0 = toward live.
        setScrollOffset(o => clampOffset(o + delta));
    }, [clampOffset]);

    const scrollBack = useCallback(() => scrollByAmount(scrollStep), [scrollByAmount, scrollStep]);   // older / shallower
    const scrollFwd = useCallback(() => scrollByAmount(-scrollStep), [scrollByAmount, scrollStep]);    // newer / deeper

    // --- Mouse-wheel continuous scroll (non-passive so we can preventDefault) ---
    const stripAreaRef = useRef(null);
    const wheelStepRef = useRef(wheelStep);
    wheelStepRef.current = wheelStep;
    useEffect(() => {
        const el = stripAreaRef.current;
        if (!el) return undefined;
        const onWheel = (e) => {
            // Block the page from scrolling while the pointer is over the strips.
            e.preventDefault();
            // wheel up (deltaY < 0) => back into history; wheel down => toward live.
            const dir = e.deltaY < 0 ? 1 : -1;
            setScrollOffset(o => clampOffset(o + dir * wheelStepRef.current));
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [clampOffset]);

    // --- Press-and-hold continuous scroll on the rail buttons ---
    // While held, repeat a small step each animation frame; a plain click still
    // performs exactly one half-window step (handled by the rail's onClick).
    const holdRafRef = useRef(0);
    const heldMovedRef = useRef(false); // did the hold actually scroll continuously?
    const holdStepRef = useRef(holdStep);
    holdStepRef.current = holdStep;
    const startHold = useCallback((dir) => {
        if (holdRafRef.current) return;
        heldMovedRef.current = false;
        let frames = 0;
        const tick = () => {
            frames += 1;
            // brief grace period so a quick click is handled solely by onClick
            if (frames > 12) {
                heldMovedRef.current = true;
                setScrollOffset(o => clampOffset(o + dir * holdStepRef.current));
            }
            holdRafRef.current = requestAnimationFrame(tick);
        };
        holdRafRef.current = requestAnimationFrame(tick);
    }, [clampOffset]);
    const stopHold = useCallback(() => {
        if (holdRafRef.current) { cancelAnimationFrame(holdRafRef.current); holdRafRef.current = 0; }
    }, []);
    useEffect(() => () => { if (holdRafRef.current) cancelAnimationFrame(holdRafRef.current); }, []);

    // Rail click = one step, BUT swallow the click that ends a press-and-hold so
    // releasing after a continuous scroll doesn't tack on an extra half-window jump.
    const clickBack = useCallback(() => {
        if (heldMovedRef.current) { heldMovedRef.current = false; return; }
        scrollBack();
    }, [scrollBack]);
    const clickFwd = useCallback(() => {
        if (heldMovedRef.current) { heldMovedRef.current = false; return; }
        scrollFwd();
    }, [scrollFwd]);

    // Drag on the axis to scroll.
    const onAxisPointerDown = (e) => {
        dragRef.current = { y: e.clientY, offset: scrollOffset };
        e.currentTarget.setPointerCapture?.(e.pointerId);
    };
    const onAxisPointerMove = (e) => {
        if (!dragRef.current) return;
        const dy = e.clientY - dragRef.current.y;
        const el = e.currentTarget;
        const pxH = el.clientHeight || 1;
        const [a, b] = indexDomain;
        const perPx = (b - a) / pxH;
        // dragging DOWN reveals older data (increase offset)
        const next = dragRef.current.offset + dy * perPx;
        setScrollOffset(clampOffset(next));
    };
    const onAxisPointerUp = () => { dragRef.current = null; };

    const updateStrip = useCallback((index, nextStrip) => {
        setStrips(prev => prev.map((s, i) => (i === index ? nextStrip : s)));
    }, []);

    // "At the bottom edge" — the live edge when live, or the recorded END (toMs) offline.
    const liveAtBottom = scrollOffset <= (indexMode === 'depth' ? 0.01 : 1000);
    const jumpToLive = useCallback(() => setScrollOffset(0), []);

    // OFFLINE chip label: caller-supplied label, else the recorded from→to date range.
    const offlineLabel = useMemo(() => {
        if (!offline) return '';
        if (winLabel) return winLabel;
        const fmt = (ms) => new Date(ms).toLocaleString([], {
            month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
        });
        return `${fmt(winFromMs)} – ${fmt(winToMs)}`;
    }, [offline, winLabel, winFromMs, winToMs]);

    // ---------------- Render ----------------

    const axisWidth = isCompact ? 44 : 56;
    const bottomH = isCompact ? 64 : 96;          // fixed variables-block height
    const headerH = isCompact ? 22 : 26;          // per-strip header row height
    // Top/bottom offsets so the index axis, scroll rails and left depth band line
    // up with the chart area: top offset = strip header height, bottom = variables block.
    const railTop = headerH + 4;
    const railBottom = bottomH + 4;
    const showLeftDepth = !isCompact;
    const showTopReadouts = !isCompact && readouts.length > 0;

    const holeDepthVal = latestValues?.[HOLE_DEPTH_METRIC];
    const bitDepthVal = latestValues?.[BIT_DEPTH_METRIC];

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {/* Toolbar */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.75 }}>
                <ToggleButtonGroup
                    size="small"
                    exclusive
                    value={indexMode}
                    onChange={(_, v) => v && setIndexMode(v)}
                    sx={{
                        '& .MuiToggleButton-root': { color: subText, borderColor: border, px: 1.25, py: 0.4, textTransform: 'none', fontWeight: 800 },
                        '& .Mui-selected': { color: `${accent} !important`, bgcolor: `${accent}22 !important` }
                    }}
                >
                    <ToggleButton value="time"><Clock size={15} style={{ marginRight: 6 }} /> Time</ToggleButton>
                    <ToggleButton value="depth"><Ruler size={15} style={{ marginRight: 6 }} /> Depth</ToggleButton>
                </ToggleButtonGroup>

                <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                    {(indexMode === 'time' ? TIME_WINDOWS : DEPTH_SPANS).map((opt, i) => {
                        const active = indexMode === 'time' ? i === timeWinIdx : i === depthSpanIdx;
                        return (
                            <Button
                                key={opt.label}
                                size="small"
                                onClick={() => (indexMode === 'time' ? setTimeWinIdx(i) : setDepthSpanIdx(i))}
                                sx={{
                                    minWidth: 36, px: 0.75, textTransform: 'none', fontWeight: 800,
                                    color: active ? theme.palette.getContrastText(accent) : subText,
                                    bgcolor: active ? accent : 'transparent',
                                    border: `1px solid ${border}`,
                                    '&:hover': { bgcolor: active ? accent : `${accent}18` }
                                }}
                            >
                                {opt.label}
                            </Button>
                        );
                    })}
                </Box>

                <Box sx={{ flex: 1 }} />

                {/* OFFLINE replay chip (fixed range) — replaces the green LIVE indicator. */}
                {offline ? (
                    <MuiTooltip title="Offline replay — fixed recorded range">
                        <Box
                            sx={{
                                display: 'flex', alignItems: 'center', gap: 0.6,
                                px: 1, py: 0.3, borderRadius: 1,
                                border: `1px solid ${border}`, bgcolor: `${accent}14`
                            }}
                        >
                            <Clock size={13} color={accent} />
                            <Typography sx={{ color: accent, fontSize: '0.72rem', fontWeight: 900, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                                OFFLINE
                            </Typography>
                            <Typography sx={{ color: subText, fontSize: '0.7rem', fontWeight: 700, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                                · {offlineLabel}
                            </Typography>
                        </Box>
                    </MuiTooltip>
                ) : (
                    /* Freshness badge (LIVE / STALE + age / OFFLINE) + jump-to-live affordance. */
                    liveAtBottom ? (
                        <MuiTooltip title={lastDataTs ? `Last data ${fmtClock(lastDataTs)}` : 'No data received yet'}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                                <Radio size={13} color={freshColor} />
                                <Typography sx={{ color: freshColor, fontSize: '0.72rem', fontWeight: 900, letterSpacing: 0.5, fontVariantNumeric: 'tabular-nums' }}>
                                    {freshLabel}
                                </Typography>
                            </Box>
                        </MuiTooltip>
                    ) : (
                        <MuiTooltip title="Jump to live">
                            <Button
                                size="small"
                                onClick={jumpToLive}
                                startIcon={<Radio size={13} />}
                                sx={{
                                    textTransform: 'none', fontWeight: 800, py: 0.2, px: 1,
                                    color: subText, border: `1px solid ${border}`,
                                    '&:hover': { color: '#22c55e', borderColor: '#22c55e' }
                                }}
                            >
                                {indexMode === 'depth'
                                    ? `${Math.round(indexDomain[0])}–${Math.round(indexDomain[1])} m · live`
                                    : 'Scrolled back · live'}
                            </Button>
                        </MuiTooltip>
                    )
                )}
            </Box>

            {/* Top band (full mode): left depth tiles spacer + configurable readout row. */}
            {showTopReadouts && (
                <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 0.75, mb: 0.75 }}>
                    {showLeftDepth && (
                        <Box sx={{ flex: `0 0 ${axisWidth + 168}px`, display: 'flex', alignItems: 'center', gap: 0.6, pl: 0.5 }}>
                            <Gauge size={16} color={subText} />
                            <Typography sx={{ color: subText, fontSize: '0.66rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                                Depth
                            </Typography>
                        </Box>
                    )}
                    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'stretch', gap: 0.75, overflowX: 'auto' }}>
                        {readouts.map((id) => (
                            <ReadoutTile
                                key={id}
                                id={id}
                                value={latestValues?.[id]}
                                surface={panelBg}
                                border={border}
                                text={text}
                                subText={subText}
                                accent={accent}
                            />
                        ))}
                    </Box>
                    <Box sx={{ flex: '0 0 auto', display: 'flex', alignItems: 'center' }}>
                        <ReadoutsConfig
                            value={readouts}
                            onChange={setReadouts}
                            channels={channels}
                            surface={panelBg}
                            border={border}
                            text={text}
                            subText={subText}
                            accent={accent}
                        />
                    </Box>
                </Box>
            )}
            {/* When no readouts selected, still expose the config control (full mode). */}
            {!isCompact && readouts.length === 0 && (
                <Box sx={{ display: 'flex', justifyContent: 'flex-end', mb: 1 }}>
                    <ReadoutsConfig
                        value={readouts}
                        onChange={setReadouts}
                        channels={channels}
                        surface={panelBg}
                        border={border}
                        text={text}
                        subText={subText}
                        accent={accent}
                    />
                </Box>
            )}

            {/* Strip area */}
            <Box ref={stripAreaRef} sx={{ flex: '1 1 auto', minHeight: 0, display: 'flex', gap: 0.75 }}>
                {/* Left depth band (full mode): HOLE DEPTH + BIT DEPTH, always shown. */}
                {showLeftDepth && (
                    <Box
                        sx={{
                            flex: '0 0 168px',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 0.75,
                            mt: `${railTop}px`,
                            mb: `${railBottom}px`
                        }}
                    >
                        <ReadoutTile
                            id={HOLE_DEPTH_METRIC}
                            value={holeDepthVal}
                            surface={panelBg}
                            border={border}
                            text={text}
                            subText={subText}
                            accent="#22d3ee"
                            valueColor={text}
                            valueSize="2.2rem"
                            minWidth={0}
                            showCategory={false}
                        />
                        <ReadoutTile
                            id={BIT_DEPTH_METRIC}
                            value={bitDepthVal}
                            surface={panelBg}
                            border={border}
                            text={text}
                            subText={subText}
                            accent="#fbbf24"
                            valueColor={text}
                            valueSize="2.2rem"
                            minWidth={0}
                            showCategory={false}
                        />
                    </Box>
                )}

                {/* LEFT scroll rail */}
                <ScrollRail
                    onUp={clickBack}
                    onDown={clickFwd}
                    onHoldUp={() => startHold(1)}
                    onHoldDown={() => startHold(-1)}
                    onHoldStop={stopHold}
                    upTip={indexMode === 'depth' ? 'Shallower' : 'Older'}
                    downTip={indexMode === 'depth' ? 'Deeper' : 'Newer'}
                    downDisabled={liveAtBottom}
                    text={text}
                    border={border}
                    top={railTop}
                    bottom={railBottom}
                />

                {/* Shared index axis */}
                <Box
                    onPointerDown={onAxisPointerDown}
                    onPointerMove={onAxisPointerMove}
                    onPointerUp={onAxisPointerUp}
                    onPointerLeave={onAxisPointerUp}
                    sx={{
                        flex: `0 0 ${axisWidth}px`,
                        bgcolor: panelBg,
                        border: `1px solid ${border}`,
                        borderRadius: 1,
                        position: 'relative',
                        cursor: 'ns-resize',
                        userSelect: 'none',
                        touchAction: 'none',
                        // align with the chart area: skip the strip header at the top
                        // and the fixed variables block at the bottom.
                        mt: `${railTop}px`,
                        mb: `${railBottom}px`
                    }}
                >
                    <Typography sx={{ position: 'absolute', top: 4, left: 0, right: 0, textAlign: 'center', fontSize: '0.6rem', fontWeight: 800, color: subText, textTransform: 'uppercase' }}>
                        {indexMode === 'depth' ? 'm' : 'time'}
                    </Typography>
                    {axisTicks.map((t, i) => (
                        <Box key={i} sx={{ position: 'absolute', left: 0, right: 0, top: `${t.frac * 100}%`, transform: 'translateY(-50%)', px: 0.25 }}>
                            {t.dateLabel && (
                                <Typography sx={{ fontSize: isCompact ? '0.48rem' : '0.52rem', color: subText, textAlign: 'center', opacity: 0.85, whiteSpace: 'nowrap', lineHeight: 1.1 }}>
                                    {t.dateLabel}
                                </Typography>
                            )}
                            <Typography sx={{ fontSize: isCompact ? '0.55rem' : '0.62rem', color: subText, textAlign: 'center', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                                {t.label}
                            </Typography>
                        </Box>
                    ))}
                </Box>

                {/* Strips */}
                <Box sx={{ flex: 1, minWidth: 0, display: 'flex', gap: 0.75, position: 'relative' }}>
                    {strips.map((strip, si) => (
                        <Box key={si} sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                            {/* header */}
                            <Box sx={{ height: headerH, display: 'flex', alignItems: 'center', gap: 0.5, mb: '4px' }}>
                                <Typography sx={{ flex: 1, minWidth: 0, color: text, fontSize: isCompact ? '0.66rem' : '0.74rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {strip.title}
                                </Typography>
                                <IconButton size="small" onClick={() => setConfigStrip(si)} sx={{ color: subText, p: 0.25 }} title="Configure track">
                                    <Settings size={isCompact ? 13 : 15} />
                                </IconButton>
                            </Box>
                            {/* chart */}
                            <Box sx={{ flex: '1 1 auto', minHeight: 0, bgcolor: chartBg, border: `1px solid ${border}`, borderRadius: 1, overflow: 'hidden' }}>
                                <StripChart
                                    strip={strip}
                                    samples={samples}
                                    indexMode={indexMode}
                                    indexDomain={indexDomain}
                                    accentColor={accent}
                                    gridColor={gridColor}
                                    axisTextColor={subText}
                                    surface={panelBg}
                                    border={border}
                                    subText={subText}
                                    textColor={text}
                                />
                            </Box>
                            {/* fixed-height variables block */}
                            <StripVariables
                                strip={strip}
                                latest={latestValues}
                                compact={isCompact}
                                surface={panelBg}
                                border={border}
                                subText={subText}
                            />
                        </Box>
                    ))}

                    {/* Stale-data overlay (UI-02): ingestion stopped — say since WHEN,
                        pinned near the live (bottom) edge where the gap opens. */}
                    {showStaleOverlay && (
                        <Box
                            sx={{
                                position: 'absolute',
                                left: 0,
                                right: 0,
                                bottom: `${railBottom + 10}px`,
                                display: 'flex',
                                justifyContent: 'center',
                                pointerEvents: 'none',
                                zIndex: 6
                            }}
                        >
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6, px: 1.25, py: 0.4, borderRadius: 1, bgcolor: panelBg, border: `1px solid ${freshColor}`, boxShadow: 3 }}>
                                <Radio size={13} color={freshColor} />
                                <Typography sx={{ color: freshColor, fontSize: '0.7rem', fontWeight: 800, letterSpacing: 0.3, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                                    no data since {fmtClock(lastDataTs)}
                                </Typography>
                            </Box>
                        </Box>
                    )}

                    {/* History-seed states (UI-13) — non-blocking overlays over the chart
                        area only, so live ingestion keeps painting underneath. */}
                    {histLoading && (
                        <Box
                            sx={{
                                position: 'absolute',
                                left: 0,
                                right: 0,
                                top: `${railTop + 8}px`,
                                display: 'flex',
                                justifyContent: 'center',
                                pointerEvents: 'none',
                                zIndex: 6
                            }}
                        >
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1.25, py: 0.4, borderRadius: 1, bgcolor: panelBg, border: `1px solid ${border}`, boxShadow: 2 }}>
                                <CircularProgress size={13} thickness={5} sx={{ color: accent }} />
                                <Typography sx={{ color: subText, fontSize: '0.68rem', fontWeight: 700, whiteSpace: 'nowrap' }}>
                                    Loading recorded data…
                                </Typography>
                            </Box>
                        </Box>
                    )}
                    {!histLoading && histError && (
                        <Box
                            sx={{
                                position: 'absolute',
                                left: 0,
                                right: 0,
                                top: `${railTop + 8}px`,
                                display: 'flex',
                                justifyContent: 'center',
                                pointerEvents: 'none',
                                zIndex: 6
                            }}
                        >
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.25, py: 0.4, borderRadius: 1, bgcolor: panelBg, border: '1px solid #ef4444', boxShadow: 2, pointerEvents: 'auto' }}>
                                <Typography sx={{ color: '#ef4444', fontSize: '0.68rem', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 320 }}>
                                    History failed: {histError}
                                </Typography>
                                <Button
                                    size="small"
                                    onClick={fetchHistory}
                                    sx={{ textTransform: 'none', fontWeight: 800, py: 0, px: 1, minWidth: 0, color: text, border: `1px solid ${border}` }}
                                >
                                    Retry
                                </Button>
                            </Box>
                        </Box>
                    )}
                    {!histLoading && !histError && histEmpty && sorted.length === 0 && (
                        <Box
                            sx={{
                                position: 'absolute',
                                inset: 0,
                                display: 'grid',
                                placeItems: 'center',
                                pointerEvents: 'none',
                                zIndex: 6
                            }}
                        >
                            <Typography sx={{ color: subText, fontSize: '0.74rem', fontWeight: 700, opacity: 0.8 }}>
                                No recorded data in this window
                            </Typography>
                        </Box>
                    )}
                </Box>

                {/* RIGHT scroll rail (mirror of the left) — full mode only; compact keeps a single control. */}
                {!isCompact && (
                    <ScrollRail
                        onUp={clickBack}
                        onDown={clickFwd}
                        onHoldUp={() => startHold(1)}
                        onHoldDown={() => startHold(-1)}
                        onHoldStop={stopHold}
                        upTip={indexMode === 'depth' ? 'Shallower' : 'Older'}
                        downTip={indexMode === 'depth' ? 'Deeper' : 'Newer'}
                        downDisabled={liveAtBottom}
                        text={text}
                        border={border}
                        top={railTop}
                        bottom={railBottom}
                    />
                )}
            </Box>

            {/* Per-strip config dialog */}
            {configStrip != null && (
                <StripConfigDialog
                    open={configStrip != null}
                    onClose={() => setConfigStrip(null)}
                    strip={strips[configStrip]}
                    stripIndex={configStrip}
                    onSave={updateStrip}
                    channels={channels}
                    surface={panelBg}
                    border={border}
                    text={text}
                    subText={subText}
                />
            )}
        </Box>
    );
}
