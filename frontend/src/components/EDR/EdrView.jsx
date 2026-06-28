import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Box,
    Button,
    Checkbox,
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
    Trash2,
    ZoomIn,
    ZoomOut
} from 'lucide-react';
import axios from '../../api';
import { socket } from '../../socket';
import edrCatalog from '../../../../shared/edrMetrics.json';

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
        readouts: normalizeReadouts(defaultReadouts),
        timeWinIdx: undefined,
        depthSpanIdx: undefined
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
        const validIdx = (v, len) => (Number.isInteger(v) && v >= 0 && v < len) ? v : undefined;
        return {
            strips: strips.length ? strips : fallback.strips,
            indexMode: parsed?.indexMode === 'depth' ? 'depth' : 'time',
            readouts,
            // Persisted period (time window / depth span) selections.
            timeWinIdx: validIdx(parsed?.timeWinIdx, TIME_WINDOWS.length),
            depthSpanIdx: validIdx(parsed?.depthSpanIdx, DEPTH_SPANS.length)
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

function ReadoutTile({ id, value, surface, border, text, subText, accent, valueColor, valueSize = '1.85rem', minWidth = 132, showCategory = true }) {
    return (
        <Paper
            elevation={0}
            sx={{
                flex: '1 1 0',
                minWidth,
                bgcolor: surface,
                border: `1px solid ${border}`,
                borderRadius: 1.5,
                px: 1.5,
                py: 0.85,
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

function StripChart({ strip, samples, indexMode, indexDomain, accentColor, gridColor, axisTextColor, surface, border, subText, textColor }) {
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

    const enabledPens = strip.pens.filter(p => p.enabled);
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

    // Nearest sample to the cursor index (linear scan — samples are sorted by
    // timestamp/depth; cheap for the ~window-sized buffers we hold).
    const nearestSample = useMemo(() => {
        if (cursorIndex == null || !samples.length) return null;
        const key = indexMode === 'depth' ? 'depth' : 'timestamp';
        let best = null;
        let bestDist = Infinity;
        for (let i = 0; i < samples.length; i += 1) {
            const iv = samples[i][key];
            if (!Number.isFinite(iv)) continue;
            const dist = Math.abs(iv - cursorIndex);
            if (dist < bestDist) { bestDist = dist; best = samples[i]; }
        }
        return best;
    }, [cursorIndex, samples, indexMode]);

    const fmtIndex = (v) => (
        indexMode === 'depth'
            ? `${fmtScale(v)} m`
            : new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    );

    // Tooltip box geometry — clamp inside the strip and flip side near edges.
    const showTooltip = cursorFrac != null && nearestSample && enabledPens.length > 0;
    const tipRows = showTooltip
        ? enabledPens.map(pen => ({
            color: pen.color,
            name: channelLabel(pen.channelId),
            unit: channelUnit(pen.channelId),
            value: fmtValue(nearestSample.values[pen.channelId], channelPrecision(pen.channelId))
        }))
        : [];

    const buildPath = (pen) => {
        const range = pen.max - pen.min || 1;
        let dStr = '';
        let started = false;
        for (let i = 0; i < samples.length; i += 1) {
            const s = samples[i];
            const raw = s.values[pen.channelId];
            const idx = indexMode === 'depth' ? s.depth : s.timestamp;
            if (!Number.isFinite(Number(raw)) || !Number.isFinite(Number(idx))) {
                started = false; // break the line over gaps
                continue;
            }
            const clamped = Math.max(pen.min, Math.min(pen.max, Number(raw)));
            const x = padX + ((clamped - pen.min) / range) * innerW;
            const y = yFor(idx);
            dStr += `${started ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
            started = true;
        }
        return dStr;
    };

    // Current value position for the thin marker (latest sample with a value).
    const markerFor = (pen) => {
        for (let i = samples.length - 1; i >= 0; i -= 1) {
            const raw = samples[i].values[pen.channelId];
            if (Number.isFinite(Number(raw))) {
                const range = pen.max - pen.min || 1;
                const clamped = Math.max(pen.min, Math.min(pen.max, Number(raw)));
                return padX + ((clamped - pen.min) / range) * innerW;
            }
        }
        return null;
    };

    return (
        <Box
            ref={ref}
            onPointerMove={handleMove}
            onPointerLeave={handleLeave}
            sx={{ position: 'relative', width: '100%', height: '100%' }}
        >
            <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
                {/* horizontal index gridlines */}
                {hLines.map((f, i) => (
                    <line key={`h${i}`} x1={0} x2={w} y1={f * h} y2={f * h} stroke={gridColor} strokeWidth={0.5} />
                ))}
                {/* vertical scale gridlines */}
                {vLines.map((x, i) => (
                    <line key={`v${i}`} x1={x} x2={x} y1={0} y2={h} stroke={gridColor} strokeWidth={0.5} />
                ))}
                {/* pens */}
                {enabledPens.map((pen, i) => (
                    <path
                        key={`p${i}`}
                        d={buildPath(pen)}
                        fill="none"
                        stroke={pen.color}
                        strokeWidth={1.6}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        vectorEffect="non-scaling-stroke"
                    />
                ))}
                {/* thin current-value markers */}
                {enabledPens.map((pen, i) => {
                    const mx = markerFor(pen);
                    if (mx == null) return null;
                    return (
                        <line
                            key={`m${i}`}
                            x1={mx}
                            x2={mx}
                            y1={0}
                            y2={h}
                            stroke={pen.color}
                            strokeWidth={0.75}
                            strokeDasharray="2 3"
                            opacity={0.5}
                            vectorEffect="non-scaling-stroke"
                        />
                    );
                })}
                {/* hover crosshair (thin horizontal cursor line at the hovered index) */}
                {cursorFrac != null && (
                    <line
                        x1={0}
                        x2={w}
                        y1={cursorFrac * h}
                        y2={cursorFrac * h}
                        stroke={accentColor}
                        strokeWidth={1}
                        opacity={0.85}
                        pointerEvents="none"
                        vectorEffect="non-scaling-stroke"
                    />
                )}
            </svg>
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
                // Full-detail tooltip so a compacted row (unit-only / value-only) is
                // still identifiable on hover: Name (unit) · min…max · current value.
                const tipTitle = `${channelLabel(pen.channelId)}${unit ? ` (${unit})` : ''} · ${fmtScale(pen.min)}…${fmtScale(pen.max)} · ${fmtValue(value, channelPrecision(pen.channelId))}${unit ? ` ${unit}` : ''}`;
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
                        </Typography>
                    </Box>
                    </MuiTooltip>
                );
            })}
        </Box>
    );
}

// ---------------------------------------------------------------------------
// Depth track — the leftmost EDR column.
//
// Reuses the EXACT same row metrics as a pen strip (header height, chart band,
// fixed bottom-block height) so it is header-aligned and baseline-aligned with
// every other strip. The chart band hosts the shared depth/time axis: the same
// horizontal gridlines the strips draw (same hTickCount formula keyed off the
// measured chart height) plus tick labels sitting ON those gridlines, so a
// viewer reads the index across all strips on the same rows. A thin hole-depth
// trace is drawn in depth mode where the bin data supports it. The fixed bottom
// block holds the live HOLE DEPTH + BIT DEPTH readouts on the shared baseline.
//
// Drag-to-scroll on the chart band mirrors the old standalone axis behaviour.
// ---------------------------------------------------------------------------

function DepthAxisChart({
    indexMode,
    indexDomain,
    axisTicks,
    samples,
    maxDepth,
    gridColor,
    subText,
    accent,
    onPointerDown,
    onPointerMove,
    onPointerUp
}) {
    const ref = useRef(null);
    const [size, setSize] = useState({ w: 60, h: 260 });

    useEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(entries => {
            const cr = entries[0]?.contentRect;
            if (cr) setSize({ w: Math.max(20, cr.width), h: Math.max(40, cr.height) });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    const { w, h } = size;

    // SAME horizontal gridline math as StripChart so labels land on the exact
    // rows the strips draw their gridlines.
    const hTickCount = Math.max(2, Math.min(8, Math.round(h / 48)));
    const hLines = Array.from({ length: hTickCount + 1 }, (_, i) => (i / hTickCount));

    // Thin hole-depth trace (depth mode only — the index IS depth, so the trace
    // is a monotonic diagonal that visually ties depth to the gridlines).
    const [d0, d1] = indexDomain;
    const span = d1 - d0 || 1;
    const depthTracePath = useMemo(() => {
        if (indexMode !== 'depth' || !samples.length) return '';
        // In depth mode the y-position already encodes depth; draw a guide line
        // from the top of the visible window down to the current max depth so the
        // operator sees how much of the window holds real (drilled) hole.
        const yMax = Math.max(0, Math.min(1, (maxDepth - d0) / span)) * h;
        if (yMax <= 0) return '';
        const x = w * 0.5;
        return `M${x.toFixed(1)},0L${x.toFixed(1)},${yMax.toFixed(1)}`;
    }, [indexMode, samples.length, maxDepth, d0, span, h, w]);

    return (
        <Box
            ref={ref}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
            sx={{ position: 'relative', width: '100%', height: '100%', cursor: 'ns-resize', userSelect: 'none', touchAction: 'none' }}
        >
            <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: 'block' }}>
                {/* SAME horizontal gridlines as the strips */}
                {hLines.map((f, i) => (
                    <line key={`h${i}`} x1={0} x2={w} y1={f * h} y2={f * h} stroke={gridColor} strokeWidth={0.5} />
                ))}
                {/* thin hole-depth guide trace (depth mode) */}
                {depthTracePath && (
                    <path
                        d={depthTracePath}
                        fill="none"
                        stroke="#22d3ee"
                        strokeWidth={2}
                        strokeLinecap="round"
                        opacity={0.85}
                        vectorEffect="non-scaling-stroke"
                    />
                )}
            </svg>
            {/* axis unit caption */}
            <Typography sx={{ position: 'absolute', top: 4, left: 0, right: 0, textAlign: 'center', fontSize: '0.6rem', fontWeight: 800, color: subText, textTransform: 'uppercase', pointerEvents: 'none' }}>
                {indexMode === 'depth' ? 'm' : 'time'}
            </Typography>
            {/* tick labels pinned to the gridline fractions (axisTicks share the same domain) */}
            {axisTicks.map((t, i) => (
                <Box key={i} sx={{ position: 'absolute', left: 0, right: 0, top: `${t.frac * 100}%`, transform: 'translateY(-50%)', px: 0.25, pointerEvents: 'none' }}>
                    <Typography sx={{ fontSize: '0.62rem', color: subText, textAlign: 'center', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        {t.label}
                    </Typography>
                </Box>
            ))}
        </Box>
    );
}

function DepthTrack({
    indexMode,
    indexDomain,
    axisTicks,
    samples,
    maxDepth,
    holeDepthVal,
    bitDepthVal,
    headerH,
    bottomH,
    chartBg,
    panelBg,
    border,
    gridColor,
    text,
    subText,
    accent,
    onPointerDown,
    onPointerMove,
    onPointerUp
}) {
    // HOLE / BIT depth as the bottom block, on the SAME baseline + height as the
    // strips' StripVariables block. We mirror StripVariables' geometry (fixed
    // BOTTOM_H, mt: 0.5) exactly rather than hardcoding divergent values.
    const rows = [
        { id: HOLE_DEPTH_METRIC, value: holeDepthVal, color: '#22d3ee' },
        { id: BIT_DEPTH_METRIC, value: bitDepthVal, color: '#fbbf24' }
    ];
    return (
        <Box sx={{ flex: '0 0 132px', minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            {/* header — same height/style as a strip header, titled DEPTH */}
            <Box sx={{ height: headerH, display: 'flex', alignItems: 'center', gap: 0.5, mb: '4px' }}>
                <Gauge size={14} color={subText} style={{ flex: '0 0 auto' }} />
                <Typography sx={{ flex: 1, minWidth: 0, color: text, fontSize: '0.74rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    Depth
                </Typography>
            </Box>
            {/* chart band — same chartTop..chartBottom band as the strips; hosts the depth axis */}
            <Box sx={{ flex: '1 1 auto', minHeight: 0, bgcolor: chartBg, border: `1px solid ${border}`, borderRadius: 1, overflow: 'hidden' }}>
                <DepthAxisChart
                    indexMode={indexMode}
                    indexDomain={indexDomain}
                    axisTicks={axisTicks}
                    samples={samples}
                    maxDepth={maxDepth}
                    gridColor={gridColor}
                    subText={subText}
                    accent={accent}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                />
            </Box>
            {/* fixed-height bottom block — mirrors StripVariables geometry for an exact baseline match */}
            <Box
                sx={{
                    flex: `0 0 ${bottomH}px`,
                    height: bottomH,
                    mt: 0.5,
                    bgcolor: panelBg,
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
                {rows.map((r) => {
                    const unit = channelUnit(r.id);
                    return (
                        <Box key={r.id} sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, lineHeight: 1.05 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
                                <Box sx={{ width: 8, height: 8, borderRadius: '2px', bgcolor: r.color, flex: '0 0 auto' }} />
                                <Typography sx={{ color: subText, fontSize: '0.6rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                    {channelLabel(r.id)}
                                </Typography>
                            </Box>
                            <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.4, pl: 1.4 }}>
                                <Typography sx={{ color: text, fontSize: '1.35rem', fontWeight: 900, lineHeight: 1.05, fontVariantNumeric: 'tabular-nums' }}>
                                    {fmtValue(r.value, channelPrecision(r.id))}
                                </Typography>
                                <Typography sx={{ color: subText, fontSize: '0.66rem', fontWeight: 700 }}>{unit}</Typography>
                            </Box>
                        </Box>
                    );
                })}
            </Box>
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
    mode = 'full',
    storageKey,
    defaultStrips = [],
    rightReadouts = [],
    channels = null
}) {
    const theme = useTheme();
    const isCompact = mode === 'compact';

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

    const [timeWinIdx, setTimeWinIdx] = useState(initial.timeWinIdx ?? (isCompact ? 0 : 1));
    const [depthSpanIdx, setDepthSpanIdx] = useState(initial.depthSpanIdx ?? 2);
    const [scrollOffset, setScrollOffset] = useState(0); // ms back in time, or m up in depth
    const [configStrip, setConfigStrip] = useState(null);

    const [data, setData] = useState([]); // [{ timestamp, depth, values:{channelId:value} }]
    const dragRef = useRef(null);

    // Persist strip config + index mode + readout selection + period selection.
    useEffect(() => {
        if (!storageKey) return;
        try {
            localStorage.setItem(storageKey, JSON.stringify({ strips, indexMode, readouts, timeWinIdx, depthSpanIdx }));
        } catch (e) { /* best effort */ }
    }, [storageKey, strips, indexMode, readouts, timeWinIdx, depthSpanIdx]);

    // Set of channels we need to fetch (all pens + readouts + depth band).
    const neededChannels = useMemo(() => {
        const set = new Set([HOLE_DEPTH_METRIC, BIT_DEPTH_METRIC]);
        strips.forEach(s => s.pens.forEach(p => set.add(p.channelId)));
        if (!isCompact) readouts.forEach(id => set.add(id));
        return Array.from(set);
    }, [strips, readouts, isCompact]);

    const timeWindowMs = TIME_WINDOWS[timeWinIdx]?.ms ?? TIME_WINDOWS[0].ms;
    const timeRange = TIME_WINDOWS[timeWinIdx]?.range ?? '-15m';

    // ---- History seed (time mode) ----
    const historyReq = useRef(0);
    const fetchHistory = useCallback(async () => {
        const reqId = ++historyReq.current;
        try {
            const params = new URLSearchParams();
            params.set('range', timeRange);
            params.set('metrics', neededChannels.join(','));
            const res = await axios.get(`/api/history?${params.toString()}`);
            if (reqId !== historyReq.current) return;
            const rows = Array.isArray(res.data) ? res.data : [];
            setData(rows.map(row => {
                const values = {};
                neededChannels.forEach(id => { values[id] = row[id]; });
                return {
                    timestamp: Number(row.timestamp),
                    depth: Number(row[DEPTH_INDEX_METRIC] ?? row['drilling.bit_depth']),
                    values
                };
            }).filter(r => Number.isFinite(r.timestamp)));
        } catch (err) {
            if (reqId !== historyReq.current) return;
            console.error('EdrView: failed to load history', err);
        }
    }, [neededChannels, timeRange]);

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
        setData(prev => {
            const point = { timestamp: ts, depth, values };
            const merged = [...prev, point];
            const bySecond = new Map();
            merged.forEach(p => {
                const key = Math.floor((p.timestamp || 0) / 1000);
                bySecond.set(key, p); // keep latest within a second
            });
            const sorted = Array.from(bySecond.values()).sort((a, b) => a.timestamp - b.timestamp);
            // Cap buffer to the largest time window + headroom for scrolling.
            const cutoff = ts - (TIME_WINDOWS[TIME_WINDOWS.length - 1].ms * 1.5);
            return sorted.filter(p => (p.timestamp || 0) >= cutoff);
        });
    }, []);

    useEffect(() => {
        fetchHistory();
        axios.get('/api/rig/latest')
            .then(({ data: latest }) => {
                if (latest && Object.keys(latest).length) ingest(latest);
            })
            .catch(() => { /* non-fatal */ });
        const handler = (d) => ingest(d);
        socket.on('rig_data', handler);
        return () => socket.off('rig_data', handler);
    }, [fetchHistory, ingest]);

    // Reset scroll when switching index modes.
    useEffect(() => { setScrollOffset(0); }, [indexMode, timeWinIdx, depthSpanIdx]);

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
        const now = sorted.length ? sorted[sorted.length - 1].timestamp : Date.now();
        const bottom = now - scrollOffset;
        const top = bottom - timeWindowMs;
        return { indexDomain: [top, bottom], samples: sorted };
    }, [indexMode, sorted, depthSpanIdx, maxDepth, scrollOffset, timeWindowMs]);

    const latestValues = useMemo(() => (sorted.length ? sorted[sorted.length - 1].values : {}), [sorted]);

    // ---- Index axis ticks ----
    const axisTicks = useMemo(() => {
        const [a, b] = indexDomain;
        const count = 6;
        return Array.from({ length: count + 1 }, (_, i) => {
            const frac = i / count;
            const v = a + frac * (b - a);
            const label = indexMode === 'depth'
                ? `${Math.round(v)}`
                : new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
            return { frac, label };
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

    // Clamp helper: offset can never go below 0 — that is the live edge, so we
    // never scroll into the future. (Scrolling back is bounded by the buffer.)
    const clampOffset = useCallback((next) => Math.max(0, next), []);

    const scrollByAmount = useCallback((delta) => {
        // delta > 0 = back into history (older/shallower); < 0 = toward live.
        setScrollOffset(o => clampOffset(o + delta));
    }, [clampOffset]);

    const scrollBack = useCallback(() => scrollByAmount(scrollStep), [scrollByAmount, scrollStep]);   // older / shallower
    const scrollFwd = useCallback(() => scrollByAmount(-scrollStep), [scrollByAmount, scrollStep]);    // newer / deeper

    // --- Zoom (change the visible time window / depth span) ---
    const periodLen = indexMode === 'time' ? TIME_WINDOWS.length : DEPTH_SPANS.length;
    const periodIdx = indexMode === 'time' ? timeWinIdx : depthSpanIdx;
    const atMaxZoomIn = periodIdx <= 0;                 // smallest window selected
    const atMaxZoomOut = periodIdx >= periodLen - 1;    // largest window selected
    const zoomBy = useCallback((dir) => {
        // dir -1 = zoom IN (smaller window, more detail); +1 = zoom OUT (larger window).
        if (indexMode === 'time') setTimeWinIdx((i) => Math.max(0, Math.min(TIME_WINDOWS.length - 1, i + dir)));
        else setDepthSpanIdx((i) => Math.max(0, Math.min(DEPTH_SPANS.length - 1, i + dir)));
    }, [indexMode]);

    // --- Mouse-wheel: scroll, or Ctrl/⌘+wheel to zoom (non-passive for preventDefault) ---
    const stripAreaRef = useRef(null);
    const wheelStepRef = useRef(wheelStep);
    wheelStepRef.current = wheelStep;
    const zoomRef = useRef(zoomBy);
    zoomRef.current = zoomBy;
    useEffect(() => {
        const el = stripAreaRef.current;
        if (!el) return undefined;
        const onWheel = (e) => {
            // Block the page from scrolling while the pointer is over the strips.
            e.preventDefault();
            if (e.ctrlKey || e.metaKey) {                 // Ctrl/⌘ + wheel = zoom
                zoomRef.current(e.deltaY < 0 ? -1 : 1);   // wheel up = zoom in
                return;
            }
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
        setScrollOffset(Math.max(0, next));
    };
    const onAxisPointerUp = () => { dragRef.current = null; };

    const updateStrip = useCallback((index, nextStrip) => {
        setStrips(prev => prev.map((s, i) => (i === index ? nextStrip : s)));
    }, []);

    const liveAtBottom = scrollOffset <= (indexMode === 'depth' ? 0.01 : 1000);
    const jumpToLive = useCallback(() => setScrollOffset(0), []);

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
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
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

                {/* Zoom in / out — steps the visible window (also Ctrl/⌘ + wheel) */}
                <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
                    <MuiTooltip title="Zoom out — larger window">
                        <span>
                            <IconButton size="small" onClick={() => zoomBy(1)} disabled={atMaxZoomOut}
                                sx={{ color: subText, border: `1px solid ${border}`, borderRadius: 1, p: 0.4, '&:hover': { color: accent, borderColor: accent } }}>
                                <ZoomOut size={16} />
                            </IconButton>
                        </span>
                    </MuiTooltip>
                    <MuiTooltip title="Zoom in — smaller window">
                        <span>
                            <IconButton size="small" onClick={() => zoomBy(-1)} disabled={atMaxZoomIn}
                                sx={{ color: subText, border: `1px solid ${border}`, borderRadius: 1, p: 0.4, '&:hover': { color: accent, borderColor: accent } }}>
                                <ZoomIn size={16} />
                            </IconButton>
                        </span>
                    </MuiTooltip>
                </Box>

                <Box sx={{ flex: 1 }} />

                {/* LIVE indicator + jump-to-live affordance. Scrolling lives on the side rails. */}
                {liveAtBottom ? (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.6 }}>
                        <Radio size={13} color="#22c55e" />
                        <Typography sx={{ color: '#22c55e', fontSize: '0.72rem', fontWeight: 900, letterSpacing: 0.5 }}>LIVE</Typography>
                    </Box>
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
                )}
            </Box>

            {/* Top band (full mode): left depth tiles spacer + configurable readout row. */}
            {showTopReadouts && (
                <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 0.75, mb: 1 }}>
                    {showLeftDepth && (
                        /* Spacer aligning the top readout row with the strips column:
                           depth track (132) + gap + left scroll rail (~30) + gap. */
                        <Box sx={{ flex: '0 0 176px', display: 'flex', alignItems: 'center', gap: 0.6, pl: 0.5 }}>
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
                {/* Leftmost DEPTH track (full mode): header + depth-axis chart band + HOLE/BIT
                    depth bottom block, all sharing the strips' row metrics so it aligns exactly.
                    The depth/time axis is folded into this track's chart band. */}
                {showLeftDepth ? (
                    <DepthTrack
                        indexMode={indexMode}
                        indexDomain={indexDomain}
                        axisTicks={axisTicks}
                        samples={samples}
                        maxDepth={maxDepth}
                        holeDepthVal={holeDepthVal}
                        bitDepthVal={bitDepthVal}
                        headerH={headerH}
                        bottomH={bottomH}
                        chartBg={chartBg}
                        panelBg={panelBg}
                        border={border}
                        gridColor={gridColor}
                        text={text}
                        subText={subText}
                        accent={accent}
                        onPointerDown={onAxisPointerDown}
                        onPointerMove={onAxisPointerMove}
                        onPointerUp={onAxisPointerUp}
                    />
                ) : (
                    /* Compact mode: keep the slim standalone index axis (no depth track). */
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
                            mt: `${railTop}px`,
                            mb: `${railBottom}px`
                        }}
                    >
                        <Typography sx={{ position: 'absolute', top: 4, left: 0, right: 0, textAlign: 'center', fontSize: '0.6rem', fontWeight: 800, color: subText, textTransform: 'uppercase' }}>
                            {indexMode === 'depth' ? 'm' : 'time'}
                        </Typography>
                        {axisTicks.map((t, i) => (
                            <Box key={i} sx={{ position: 'absolute', left: 0, right: 0, top: `${t.frac * 100}%`, transform: 'translateY(-50%)', px: 0.25 }}>
                                <Typography sx={{ fontSize: '0.55rem', color: subText, textAlign: 'center', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                                    {t.label}
                                </Typography>
                            </Box>
                        ))}
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

                {/* Strips */}
                <Box sx={{ flex: 1, minWidth: 0, display: 'flex', gap: 0.75 }}>
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
