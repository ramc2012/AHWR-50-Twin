import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
    Alert,
    Box,
    Button,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControl,
    Grid,
    IconButton,
    ListSubheader,
    MenuItem,
    Paper,
    Select,
    Snackbar,
    TextField,
    Tooltip as MuiTooltip,
    Typography
} from '@mui/material';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { ChevronDown, ChevronUp, ChevronsDown, ChevronsUp, Clock, Download, History, Printer, RotateCcw, Save, Settings, Trash2 } from 'lucide-react';
import axios from '../../api';
import { socket } from '../../socket';
import { useAuth } from '../../context/AuthContext';
import edrCatalog from '../../../../shared/edrMetrics.json';

const AVAILABLE_METRICS = Object.fromEntries(
    edrCatalog.categories.map(category => [category.id, category.fields.map(field => field.id)])
);

const METRIC_OPTIONS = edrCatalog.categories.flatMap(category => (
    category.fields.map(field => ({
        ...field,
        value: `${category.id}.${field.id}`,
        category: category.id,
        categoryLabel: category.label,
        shortLabel: field.label
    }))
));
const METRIC_LOOKUP = new Map(METRIC_OPTIONS.map(option => [option.value, option]));
const METRIC_VALUES = new Set(METRIC_OPTIONS.map(option => option.value));

const PEN_COLORS = ['#38bdf8', '#fbbf24', '#4ade80', '#f472b6', '#a78bfa', '#fb7185', '#22d3ee', '#f97316'];
const STRIP_OPTIONS = [1, 2, 3, 4, 5, 6];
const PEN_OPTIONS = [1, 2, 3, 4];
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const EDR_SYNC_ID = 'ahwr-edr-time-cursor';
const CURSOR_STEPS_PER_PERIOD = 60;

const DEFAULT_EDR_CONFIG = edrCatalog.defaultLayout;
const DEPTH_LOG_TEMPLATE = {
    id: 'depth-log',
    title: 'Depth Log',
    isDepthLog: true,
    pens: [
        { id: 'depth-bit', metric: 'drilling.bit_depth', min: 0, max: 3000, color: '#38bdf8' },
        { id: 'depth-hole', metric: 'drilling.hole_depth', min: 0, max: 3000, color: '#fbbf24' }
    ]
};

const menuProps = {
    PaperProps: {
        sx: {
            bgcolor: '#0f172a',
            color: '#e5e7eb',
            border: '1px solid #334155',
            maxHeight: 360
        }
    }
};

const formFieldSx = {
    '& .MuiInputBase-root': { color: '#e5e7eb', bgcolor: '#0f172a' },
    '& .MuiInputLabel-root': { color: '#94a3b8' },
    '& .MuiOutlinedInput-notchedOutline': { borderColor: '#334155' },
    '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: '#64748b' },
    '& .MuiSvgIcon-root': { color: '#94a3b8' }
};

const selectSx = {
    color: '#e5e7eb',
    bgcolor: '#0f172a',
    '& .MuiOutlinedInput-notchedOutline': { borderColor: '#334155' },
    '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: '#64748b' },
    '& .MuiSvgIcon-root': { color: '#94a3b8' }
};

const edrEdgeButtonSx = {
    width: 36,
    height: 36,
    color: '#e5e7eb',
    bgcolor: 'rgba(15,23,42,0.92)',
    border: '1px solid #334155',
    '&:hover': { bgcolor: '#1e293b', borderColor: '#38bdf8' },
    '&.Mui-disabled': { color: '#475569', borderColor: '#1f2937' }
};

const getRangeMs = (range) => {
    if (range === '-15m') return 15 * 60 * 1000;
    if (range === '-30m') return 30 * 60 * 1000;
    if (range === '-1h') return 60 * 60 * 1000;
    if (range === '-2h') return 2 * 60 * 60 * 1000;
    if (range === '-4h') return 4 * 60 * 60 * 1000;
    if (range === '-12h') return 12 * 60 * 60 * 1000;
    if (range === '-1d') return 24 * 60 * 60 * 1000;
    if (range === '-5d') return 5 * 24 * 60 * 60 * 1000;
    return 15 * 60 * 1000;
};

const toDateTimeLocalValue = (value) => {
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) return '';
    const local = new Date(date.getTime() - (date.getTimezoneOffset() * 60 * 1000));
    return local.toISOString().slice(0, 19);
};

const cloneConfig = (config) => JSON.parse(JSON.stringify(config));

const clampCount = (value, fallback, min, max) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
};

const toNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const getDefaultStrip = (stripIndex) => DEFAULT_EDR_CONFIG.strips[stripIndex % DEFAULT_EDR_CONFIG.strips.length];

const getDefaultPen = (stripIndex, penIndex) => {
    const strip = getDefaultStrip(stripIndex);
    return strip.pens[penIndex % strip.pens.length] || DEFAULT_EDR_CONFIG.strips[0].pens[0];
};

const normalizeLegacyStrips = (config) => {
    if (Array.isArray(config?.strips)) return config.strips;
    if (!Array.isArray(config?.tracks)) return [];
    return config.tracks.map((track, stripIndex) => ({
        id: `strip-${stripIndex + 1}`,
        title: `Strip ${stripIndex + 1}`,
        pens: [track.left, track.right].filter(Boolean)
    }));
};

const normalizePen = (pen, stripIndex, penIndex) => {
    const fallback = getDefaultPen(stripIndex, penIndex);
    const source = pen && typeof pen === 'object' ? pen : {};
    const metric = METRIC_VALUES.has(source.metric) ? source.metric : fallback.metric;
    const meta = METRIC_LOOKUP.get(metric);
    const min = toNumber(source.min, fallback.min ?? meta?.defaultMin ?? 0);
    let max = toNumber(source.max, fallback.max ?? meta?.defaultMax ?? 1);
    if (max <= min) max = min + 1;

    return {
        id: typeof source.id === 'string' && source.id ? source.id : `s${stripIndex + 1}p${penIndex + 1}`,
        metric,
        min,
        max,
        color: COLOR_RE.test(source.color || '') ? source.color : PEN_COLORS[(stripIndex + penIndex) % PEN_COLORS.length]
    };
};

const normalizeEdrPreset = (preset, index) => {
    const source = preset && typeof preset === 'object' ? preset : {};
    const configSource = source.config && typeof source.config === 'object' ? source.config : source;
    return {
        id: typeof source.id === 'string' && source.id ? source.id : `preset-${index + 1}`,
        name: typeof source.name === 'string' && source.name ? source.name : `Preset ${index + 1}`,
        createdAt: typeof source.createdAt === 'string' ? source.createdAt : '',
        createdBy: typeof source.createdBy === 'string' ? source.createdBy : '',
        config: normalizeEdrConfig(configSource, { includePresets: false })
    };
};

const normalizeEdrConfig = (config = DEFAULT_EDR_CONFIG, options = { includePresets: true }) => {
    const source = config && typeof config === 'object' ? config : DEFAULT_EDR_CONFIG;
    const sourceStrips = normalizeLegacyStrips(source);
    const stripCount = clampCount(source.stripCount ?? sourceStrips.length, DEFAULT_EDR_CONFIG.stripCount, 1, 6);
    const pensPerStrip = clampCount(source.pensPerStrip, DEFAULT_EDR_CONFIG.pensPerStrip, 1, 4);

    const normalized = {
        stripCount,
        pensPerStrip,
        strips: Array.from({ length: stripCount }, (_, stripIndex) => {
            const fallbackStrip = getDefaultStrip(stripIndex);
            const sourceStrip = sourceStrips[stripIndex] || fallbackStrip;
            return {
                id: typeof sourceStrip.id === 'string' && sourceStrip.id ? sourceStrip.id : `strip-${stripIndex + 1}`,
                title: typeof sourceStrip.title === 'string' && sourceStrip.title ? sourceStrip.title : fallbackStrip.title,
                pens: Array.from({ length: pensPerStrip }, (_, penIndex) => (
                    normalizePen(sourceStrip.pens?.[penIndex], stripIndex, penIndex)
                ))
            };
        })
    };
    if (options.includePresets !== false) {
        normalized.presets = Array.isArray(source.presets)
            ? source.presets.slice(0, 20).map((preset, index) => normalizeEdrPreset(preset, index))
            : [];
    }
    return normalized;
};

const metricLabel = (metric) => {
    const meta = METRIC_LOOKUP.get(metric);
    return meta ? `${meta.categoryLabel} - ${meta.label}` : metric.replace(/[._]/g, ' ');
};
const metricShortLabel = (metric) => METRIC_LOOKUP.get(metric)?.shortLabel || metric.replace(/[._]/g, ' ');
const metricUnit = (metric) => METRIC_LOOKUP.get(metric)?.unit || '';
const metricPrecision = (metric) => METRIC_LOOKUP.get(metric)?.precision ?? 1;

const metricOptions = (keyPrefix = 'metric') => edrCatalog.categories.flatMap(category => [
    <ListSubheader key={`${keyPrefix}-${category.id}`} sx={{ bgcolor: '#101827', color: '#7dd3fc', fontWeight: 800, lineHeight: '32px' }}>
        {category.label.toUpperCase()}
    </ListSubheader>,
    ...category.fields.map(field => (
        <MenuItem key={`${keyPrefix}-${category.id}.${field.id}`} value={`${category.id}.${field.id}`}>
            <Box component="span" sx={{ color: '#64748b', fontSize: '0.7rem', fontWeight: 800, textTransform: 'uppercase', mr: 1 }}>
                {category.label}
            </Box>
            {field.label} {field.unit ? `(${field.unit})` : ''}
        </MenuItem>
    ))
]);

export default function EdrDashboard() {
    const { user } = useAuth();
    const canPersistConfig = user?.role === 'admin';
    const [data, setData] = useState([]);
    const [edrConfig, setEdrConfig] = useState(() => normalizeEdrConfig(DEFAULT_EDR_CONFIG));
    const [draftConfig, setDraftConfig] = useState(() => normalizeEdrConfig(DEFAULT_EDR_CONFIG));
    const [isConfigOpen, setIsConfigOpen] = useState(false);
    const [timeRange, setTimeRange] = useState('-15m');
    const [customRange, setCustomRange] = useState({ start: '', end: '' });
    const [isCustom, setIsCustom] = useState(false);
    const [showCustomDate, setShowCustomDate] = useState(false);
    const [notice, setNotice] = useState({ open: false, severity: 'success', message: '' });
    const [selectedPresetId, setSelectedPresetId] = useState('default');
    const [presetName, setPresetName] = useState('');
    const [auditEvents, setAuditEvents] = useState([]);
    const [cursorTimestamp, setCursorTimestamp] = useState(null);

    const depthLogStrip = useMemo(() => {
        const maxDepth = data.reduce((max, row) => {
            const bitDepth = Number(row['drilling.bit_depth']);
            const holeDepth = Number(row['drilling.hole_depth']);
            return Math.max(
                max,
                Number.isFinite(bitDepth) ? bitDepth : 0,
                Number.isFinite(holeDepth) ? holeDepth : 0
            );
        }, 0);
        const rangeMax = Math.max(3000, Math.ceil((maxDepth + 100) / 500) * 500);
        return {
            ...DEPTH_LOG_TEMPLATE,
            pens: DEPTH_LOG_TEMPLATE.pens.map(pen => ({ ...pen, max: rangeMax }))
        };
    }, [data]);

    const displayedStrips = useMemo(() => [depthLogStrip, ...edrConfig.strips], [depthLogStrip, edrConfig.strips]);

    const configuredMetrics = useMemo(() => {
        const metrics = new Set(['drilling.bit_depth', 'drilling.hole_depth']);
        edrConfig.strips.forEach(strip => {
            strip.pens.forEach(pen => {
                metrics.add(pen.metric);
            });
        });
        return Array.from(metrics);
    }, [edrConfig.strips]);

    const sortedTimestamps = useMemo(() => (
        data
            .map(row => Number(row.timestamp))
            .filter(Number.isFinite)
            .sort((a, b) => a - b)
    ), [data]);

    const selectedPeriodMs = useMemo(() => {
        if (isCustom && customRange.start && customRange.end) {
            const start = new Date(customRange.start).getTime();
            const end = new Date(customRange.end).getTime();
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) return end - start;
        }
        return getRangeMs(timeRange);
    }, [customRange.end, customRange.start, isCustom, timeRange]);

    const selectedTimeDomain = useMemo(() => {
        if (isCustom && customRange.start && customRange.end) {
            const start = new Date(customRange.start).getTime();
            const end = new Date(customRange.end).getTime();
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) return [start, end];
        }

        const latestTimestamp = sortedTimestamps[sortedTimestamps.length - 1];
        const end = Number.isFinite(latestTimestamp) ? latestTimestamp : Date.now();
        return [end - selectedPeriodMs, end];
    }, [customRange.end, customRange.start, isCustom, selectedPeriodMs, sortedTimestamps]);

    const formatTimeTick = useCallback((unixTime) => {
        const date = new Date(unixTime);
        if (!Number.isFinite(date.getTime())) return '';
        if (selectedPeriodMs >= 24 * 60 * 60 * 1000) {
            return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
        }
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }, [selectedPeriodMs]);

    const selectedTimeTicks = useMemo(() => {
        const [start, end] = selectedTimeDomain;
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
        const intervals = 4;
        const step = (end - start) / intervals;
        return Array.from({ length: intervals + 1 }, (_, index) => Math.round(start + (step * index)));
    }, [selectedTimeDomain]);

    const cursorPoint = useMemo(() => {
        if (data.length === 0) return null;
        if (!Number.isFinite(Number(cursorTimestamp))) return data[data.length - 1];
        return data.reduce((closest, row) => {
            const currentDelta = Math.abs(Number(row.timestamp) - Number(cursorTimestamp));
            const closestDelta = Math.abs(Number(closest.timestamp) - Number(cursorTimestamp));
            return currentDelta < closestDelta ? row : closest;
        }, data[0]);
    }, [cursorTimestamp, data]);

    const activeCursorTimestamp = Number.isFinite(Number(cursorTimestamp))
        ? Number(cursorTimestamp)
        : (Number.isFinite(Number(cursorPoint?.timestamp)) ? Number(cursorPoint.timestamp) : null);

    const cursorLabel = activeCursorTimestamp
        ? new Date(activeCursorTimestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
        : '--:--:--';

    const presetOptions = useMemo(() => ([
        { id: 'default', name: 'Default EDR', createdBy: 'system', config: normalizeEdrConfig(DEFAULT_EDR_CONFIG, { includePresets: false }) },
        ...(draftConfig.presets || [])
    ]), [draftConfig.presets]);

    const buildHistoryUrl = useCallback(() => {
        const params = new URLSearchParams();
        if (customRange.start && customRange.end) {
            params.set('start', new Date(customRange.start).toISOString());
            params.set('stop', new Date(customRange.end).toISOString());
        } else {
            params.set('range', timeRange);
        }
        if (configuredMetrics.length) {
            params.set('fields', configuredMetrics.join(','));
        }
        return `/api/history?${params.toString()}`;
    }, [configuredMetrics, customRange.end, customRange.start, timeRange]);

    const fetchHistory = useCallback(async () => {
        try {
            const res = await axios.get(buildHistoryUrl());
            setData(Array.isArray(res.data) ? res.data : []);
        } catch (err) {
            console.error('Failed to fetch history', err);
            setData([]);
        }
    }, [buildHistoryUrl]);

    const loadAuditEvents = useCallback(async () => {
        if (!canPersistConfig) return;
        try {
            const res = await axios.get('/api/dashboard/audit?section=edr&limit=8');
            setAuditEvents(Array.isArray(res.data?.events) ? res.data.events : []);
        } catch (err) {
            console.error('Failed to fetch EDR audit:', err);
        }
    }, [canPersistConfig]);

    const processLivePoint = useCallback((newData) => {
        setData(prev => {
            const serverTsStr = newData?._meta?.ts;
            const ptTime = serverTsStr ? new Date(serverTsStr) : new Date();
            const timestamp = ptTime.getTime();
            const newPoint = {
                name: ptTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
                timestamp: timestamp
            };

            Object.keys(newData || {}).forEach(measurement => {
                if (typeof newData[measurement] === 'object' && newData[measurement] !== null) {
                    Object.keys(newData[measurement]).forEach(field => {
                        newPoint[`${measurement}.${field}`] = newData[measurement][field];
                    });
                }
            });

            configuredMetrics.forEach(metric => {
                if (newPoint[metric] === undefined) newPoint[metric] = null;
            });

            const merged = [...prev, newPoint];
            const uniqueMap = new Map();
            merged.forEach(item => {
                const key = Math.floor((item.timestamp || 0) / 1000);
                if (!uniqueMap.has(key)) uniqueMap.set(key, item);
            });

            const cutoff = timestamp - getRangeMs(timeRange);
            return Array.from(uniqueMap.values())
                .sort((a, b) => a.timestamp - b.timestamp)
                .filter(pt => (pt.timestamp || 0) >= cutoff);
        });
    }, [configuredMetrics, timeRange]);

    useEffect(() => {
        let mounted = true;

        axios.get('/api/dashboard/layout')
            .then(({ data: layout }) => {
                if (!mounted) return;
                const next = normalizeEdrConfig(layout?.edr || DEFAULT_EDR_CONFIG);
                setEdrConfig(next);
                setDraftConfig(next);
            })
            .catch(err => console.error('Failed to fetch EDR layout:', err));

        const handleLayoutUpdate = (layout) => {
            if (!layout?.edr) return;
            const next = normalizeEdrConfig(layout.edr);
            setEdrConfig(next);
            setDraftConfig(next);
        };

        socket.on('dashboard_layout_update', handleLayoutUpdate);
        return () => {
            mounted = false;
            socket.off('dashboard_layout_update', handleLayoutUpdate);
        };
    }, []);

    useEffect(() => {
        if (isCustom) return undefined;

        fetchHistory();

        axios.get('/api/rig/latest')
            .then(({ data: latestPoint }) => {
                if (latestPoint && Object.keys(latestPoint).length > 0) processLivePoint(latestPoint);
            })
            .catch(err => console.error('Failed to fetch latest EDR point:', err));

        const handleSocketData = (newData) => processLivePoint(newData);
        socket.on('rig_data', handleSocketData);
        return () => socket.off('rig_data', handleSocketData);
    }, [fetchHistory, isCustom, processLivePoint]);

    useEffect(() => {
        if (isConfigOpen) loadAuditEvents();
    }, [isConfigOpen, loadAuditEvents]);

    useEffect(() => {
        if (sortedTimestamps.length === 0) {
            setCursorTimestamp(null);
            return;
        }
        setCursorTimestamp(current => {
            const first = sortedTimestamps[0];
            const last = sortedTimestamps[sortedTimestamps.length - 1];
            if (!Number.isFinite(Number(current))) return last;
            if (current < first) return first;
            if (current > last) return last;
            return current;
        });
    }, [sortedTimestamps]);

    useEffect(() => {
        if (!isCustom || !customRange.start || !customRange.end) return;
        fetchHistory();
    }, [customRange.end, customRange.start, fetchHistory, isCustom]);

    const applyCustomRange = () => {
        if (customRange.start && customRange.end) {
            setIsCustom(true);
        }
    };

    const handlePresetClick = (val) => {
        setIsCustom(false);
        setTimeRange(val);
        setCustomRange({ start: '', end: '' });
        setCursorTimestamp(null);
    };

    const getCurrentWindow = () => {
        if (isCustom && customRange.start && customRange.end) {
            const start = new Date(customRange.start).getTime();
            const end = new Date(customRange.end).getTime();
            if (Number.isFinite(start) && Number.isFinite(end) && end > start) return { start, end };
        }
        const end = Date.now();
        return { start: end - selectedPeriodMs, end };
    };

    const pageWindow = (direction) => {
        const period = Math.max(60 * 1000, selectedPeriodMs);
        const { start, end } = getCurrentWindow();
        if (direction > 0) {
            if (!isCustom) return;
            const nextStart = start + period;
            const nextEnd = end + period;
            if (nextEnd >= Date.now()) {
                setIsCustom(false);
                setCustomRange({ start: '', end: '' });
                setCursorTimestamp(null);
                return;
            }
            setCustomRange({ start: toDateTimeLocalValue(nextStart), end: toDateTimeLocalValue(nextEnd) });
            setCursorTimestamp(nextEnd);
            return;
        }
        const nextStart = start - period;
        const nextEnd = end - period;
        setIsCustom(true);
        setCustomRange({ start: toDateTimeLocalValue(nextStart), end: toDateTimeLocalValue(nextEnd) });
        setCursorTimestamp(nextEnd);
    };

    const advanceCursor = (direction) => {
        if (sortedTimestamps.length === 0) return;
        const current = Number.isFinite(Number(cursorTimestamp))
            ? Number(cursorTimestamp)
            : sortedTimestamps[sortedTimestamps.length - 1];
        const step = Math.max(1000, Math.floor(selectedPeriodMs / CURSOR_STEPS_PER_PERIOD));
        const first = sortedTimestamps[0];
        const last = sortedTimestamps[sortedTimestamps.length - 1];
        setCursorTimestamp(Math.max(first, Math.min(last, current + (direction * step))));
    };

    const edrNavigationControls = [
        {
            label: 'Page up EDR period',
            tooltip: 'Page up period',
            icon: <ChevronsUp size={18} />,
            action: () => pageWindow(1),
            disabled: !isCustom
        },
        {
            label: 'Move cursor up',
            tooltip: 'Move cursor up',
            icon: <ChevronUp size={18} />,
            action: () => advanceCursor(1),
            disabled: sortedTimestamps.length === 0
        },
        {
            label: 'Move cursor down',
            tooltip: 'Move cursor down',
            icon: <ChevronDown size={18} />,
            action: () => advanceCursor(-1),
            disabled: sortedTimestamps.length === 0
        },
        {
            label: 'Page down EDR period',
            tooltip: 'Page down period',
            icon: <ChevronsDown size={18} />,
            action: () => pageWindow(-1),
            disabled: false
        }
    ];

    const openConfig = () => {
        setDraftConfig(cloneConfig(edrConfig));
        setSelectedPresetId('default');
        setPresetName('');
        setIsConfigOpen(true);
    };

    const handleDraftCountChange = (field, value) => {
        setDraftConfig(prev => normalizeEdrConfig({ ...prev, [field]: Number(value) }));
    };

    const handleDraftStripChange = (stripIndex, value) => {
        setDraftConfig(prev => ({
            ...prev,
            strips: prev.strips.map((strip, index) => (
                index === stripIndex ? { ...strip, title: value } : strip
            ))
        }));
    };

    const handleDraftPenChange = (stripIndex, penIndex, field, value) => {
        setDraftConfig(prev => ({
            ...prev,
            strips: prev.strips.map((strip, currentStripIndex) => (
                currentStripIndex !== stripIndex ? strip : {
                    ...strip,
                    pens: strip.pens.map((pen, currentPenIndex) => (
                        currentPenIndex === penIndex ? (() => {
                            if (field !== 'metric') return { ...pen, [field]: value };
                            const meta = METRIC_LOOKUP.get(value);
                            return {
                                ...pen,
                                metric: value,
                                min: meta?.defaultMin ?? pen.min,
                                max: meta?.defaultMax ?? pen.max
                            };
                        })() : pen
                    ))
                }
            ))
        }));
    };

    const resetDraftConfig = () => {
        setDraftConfig(prev => ({ ...normalizeEdrConfig(DEFAULT_EDR_CONFIG, { includePresets: false }), presets: prev.presets || [] }));
        setSelectedPresetId('default');
        setPresetName('');
    };

    const applyPreset = (presetId) => {
        const preset = presetOptions.find(option => option.id === presetId);
        if (!preset) return;
        const next = normalizeEdrConfig(preset.config, { includePresets: false });
        setDraftConfig(prev => ({ ...next, presets: prev.presets || [] }));
        setSelectedPresetId(presetId);
        setPresetName(preset.id === 'default' ? '' : preset.name);
    };

    const savePreset = () => {
        const cleanName = presetName.trim() || `${draftConfig.stripCount}x${draftConfig.pensPerStrip} EDR`;
        const id = selectedPresetId && selectedPresetId !== 'default'
            ? selectedPresetId
            : `preset-${Date.now().toString(36)}`;
        const preset = {
            id,
            name: cleanName,
            createdAt: new Date().toISOString(),
            createdBy: user?.username || 'session',
            config: normalizeEdrConfig(draftConfig, { includePresets: false })
        };
        setDraftConfig(prev => ({
            ...prev,
            presets: [...(prev.presets || []).filter(item => item.id !== id), preset]
        }));
        setSelectedPresetId(id);
        setPresetName(cleanName);
    };

    const deletePreset = () => {
        if (!selectedPresetId || selectedPresetId === 'default') return;
        setDraftConfig(prev => ({
            ...prev,
            presets: (prev.presets || []).filter(item => item.id !== selectedPresetId)
        }));
        setSelectedPresetId('default');
        setPresetName('');
    };

    const saveDraftConfig = async () => {
        const next = normalizeEdrConfig(draftConfig);
        setEdrConfig(next);
        setDraftConfig(next);
        setIsConfigOpen(false);

        if (!canPersistConfig) {
            setNotice({
                open: true,
                severity: 'info',
                message: 'Applied for this session. Admin login is required to save globally.'
            });
            return;
        }

        try {
            const res = await axios.post('/api/dashboard/layout', { edr: next });
            const saved = normalizeEdrConfig(res.data?.config?.edr || next);
            setEdrConfig(saved);
            setDraftConfig(saved);
            setNotice({ open: true, severity: 'success', message: 'EDR configuration saved.' });
            loadAuditEvents();
        } catch (err) {
            console.error('Failed to save EDR configuration:', err);
            setNotice({
                open: true,
                severity: 'error',
                message: err.response?.data?.error || 'Failed to save EDR configuration.'
            });
        }
    };

    const escapeCsv = (value) => {
        const text = value == null ? '' : String(value);
        return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };

    const exportCsv = () => {
        const metrics = Array.from(new Set(displayedStrips.flatMap(strip => strip.pens.map(pen => pen.metric))));
        const headers = [
            'Timestamp',
            ...metrics.map(metric => `${metricLabel(metric)}${metricUnit(metric) ? ` (${metricUnit(metric)})` : ''}`)
        ];
        const rows = data.map(row => [
            row.timestamp ? new Date(row.timestamp).toISOString() : row.name,
            ...metrics.map(metric => {
                const value = row[metric];
                return Number.isFinite(Number(value)) ? Number(value).toFixed(metricPrecision(metric)) : '';
            })
        ]);
        const csv = [headers, ...rows].map(row => row.map(escapeCsv).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `edr-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
        setNotice({ open: true, severity: 'success', message: `Exported ${rows.length} EDR rows.` });
    };

    const printEdr = () => {
        window.print();
    };

    const getLatestValue = (metric) => {
        const source = cursorPoint || data[data.length - 1];
        if (!source) return '0.0';
        const latest = source[metric];
        const precision = metricPrecision(metric);
        return Number.isFinite(Number(latest)) ? Number(latest).toFixed(precision) : Number(0).toFixed(precision);
    };

    return (
        <Box sx={{ height: 'calc(100vh - 100px)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 2, alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
                    <Typography variant="h5" sx={{ fontWeight: 'bold' }}>Electronic Drilling Recorder (EDR)</Typography>
                    <Chip
                        size="small"
                        label={`Depth + ${edrConfig.stripCount} strips x ${edrConfig.pensPerStrip} pens`}
                        sx={{ bgcolor: '#172033', color: '#7dd3fc', border: '1px solid #334155', fontWeight: 800 }}
                    />
                    <Chip
                        size="small"
                        label={`Cursor ${cursorLabel}`}
                        sx={{ bgcolor: '#111827', color: '#bef264', border: '1px solid #334155', fontWeight: 800 }}
                    />
                    <Button
                        variant="outlined"
                        size="small"
                        startIcon={<Settings size={16} />}
                        onClick={openConfig}
                        sx={{ color: '#e5e7eb', borderColor: '#334155', bgcolor: '#111827' }}
                    >
                        Configure
                    </Button>
                    <Button
                        variant="outlined"
                        size="small"
                        startIcon={<Download size={16} />}
                        onClick={exportCsv}
                        sx={{ color: '#e5e7eb', borderColor: '#334155', bgcolor: '#111827' }}
                    >
                        Export
                    </Button>
                    <Button
                        variant="outlined"
                        size="small"
                        startIcon={<Printer size={16} />}
                        onClick={printEdr}
                        sx={{ color: '#e5e7eb', borderColor: '#334155', bgcolor: '#111827' }}
                    >
                        Print
                    </Button>
                </Box>

                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Box sx={{ position: 'relative' }}>
                        <MuiTooltip title="Custom range">
                            <Button
                                variant="outlined"
                                onClick={() => setShowCustomDate(!showCustomDate)}
                                sx={{ color: 'white', borderColor: '#334155', height: '100%', bgcolor: '#1e293b', minWidth: '40px', px: 1 }}
                            >
                                <Clock size={20} />
                            </Button>
                        </MuiTooltip>
                        {showCustomDate && (
                            <Paper sx={{ position: 'absolute', top: '100%', right: 0, mt: 1, p: 2, bgcolor: '#0f172a', border: '1px solid #334155', zIndex: 50, width: 'max-content' }}>
                                <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
                                    <Typography sx={{ color: '#94a3b8', fontSize: '0.875rem', fontWeight: 'bold' }}>CUSTOM RANGE</Typography>
                                    <Box
                                        component="input"
                                        type="datetime-local"
                                        value={customRange.start}
                                        onChange={(e) => setCustomRange(prev => ({ ...prev, start: e.target.value }))}
                                        sx={{ bgcolor: 'transparent', color: 'white', border: '1px solid #334155', borderRadius: '4px', p: '4px', colorScheme: 'dark' }}
                                    />
                                    <Box component="span" sx={{ color: '#94a3b8' }}>-</Box>
                                    <Box
                                        component="input"
                                        type="datetime-local"
                                        value={customRange.end}
                                        onChange={(e) => setCustomRange(prev => ({ ...prev, end: e.target.value }))}
                                        sx={{ bgcolor: 'transparent', color: 'white', border: '1px solid #334155', borderRadius: '4px', p: '4px', colorScheme: 'dark' }}
                                    />
                                    <Button variant="contained" size="small" onClick={() => { applyCustomRange(); setShowCustomDate(false); }} sx={{ ml: 1 }}>Go</Button>
                                </Box>
                            </Paper>
                        )}
                    </Box>

                    <Box sx={{ width: '1px', height: '24px', bgcolor: '#334155', mx: 1 }} />

                    {[
                        { label: '15min', val: '-15m' },
                        { label: '30min', val: '-30m' },
                        { label: '1H', val: '-1h' },
                        { label: '2H', val: '-2h' },
                        { label: '4H', val: '-4h' },
                        { label: '12H', val: '-12h' },
                        { label: '1D', val: '-1d' },
                        { label: '5D', val: '-5d' }
                    ].map((opt) => (
                        <Button
                            key={opt.val}
                            variant={!isCustom && timeRange === opt.val ? 'contained' : 'outlined'}
                            aria-pressed={!isCustom && timeRange === opt.val}
                            onClick={() => handlePresetClick(opt.val)}
                            size="small"
                            sx={{
                                bgcolor: !isCustom && timeRange === opt.val ? '#38bdf8' : 'transparent',
                                color: !isCustom && timeRange === opt.val ? '#0f172a' : '#94a3b8',
                                borderColor: '#334155',
                                minWidth: '40px',
                                textTransform: 'none',
                                fontWeight: 800
                            }}
                        >
                            {opt.label}
                        </Button>
                    ))}
                </Box>
            </Box>

            <Box sx={{ flex: '1 1 auto', minHeight: 0, position: 'relative' }}>
                {[
                    {
                        key: 'left',
                        label: 'Left',
                        edgeSx: {
                            left: { xs: 2, md: 0 },
                            transform: { xs: 'none', md: 'translate(-50%, -50%)' }
                        }
                    },
                    {
                        key: 'right',
                        label: 'Right',
                        edgeSx: {
                            right: { xs: 2, md: 0 },
                            transform: { xs: 'none', md: 'translate(50%, -50%)' }
                        }
                    }
                ].map((edge) => (
                    <Box
                        key={edge.key}
                        sx={{
                            position: 'absolute',
                            top: '50%',
                            zIndex: 5,
                            display: 'grid',
                            gap: 0.75,
                            ...edge.edgeSx
                        }}
                    >
                        {edrNavigationControls.map((control) => (
                            <MuiTooltip key={`${edge.key}-${control.label}`} title={control.tooltip}>
                                <span>
                                    <IconButton
                                        aria-label={`${edge.label} ${control.label}`}
                                        onClick={control.action}
                                        disabled={control.disabled}
                                        sx={edrEdgeButtonSx}
                                    >
                                        {control.icon}
                                    </IconButton>
                                </span>
                            </MuiTooltip>
                        ))}
                    </Box>
                ))}

                <Box
                    sx={{
                        height: '100%',
                        minHeight: 0,
                        display: 'grid',
                        gap: 1,
                        gridTemplateColumns: { xs: '1fr', md: `repeat(${displayedStrips.length}, minmax(0, 1fr))` },
                        alignItems: 'stretch',
                        px: { xs: 0, md: 2.5 }
                    }}
                >
                    {displayedStrips.map((strip) => {
                        const isDepthLog = Boolean(strip.isDepthLog);
                        return (
                        <Box key={strip.id} sx={{ minHeight: { xs: 460, md: 0 }, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <Paper sx={{ flex: '1 1 auto', minHeight: 0, bgcolor: 'black', border: '1px solid #334155', position: 'relative', overflow: 'hidden', borderRadius: 1 }}>
                            <Box sx={{ position: 'absolute', top: 8, left: 8, right: 8, zIndex: 1, display: 'flex', justifyContent: 'space-between', gap: 1, alignItems: 'flex-start' }}>
                                <Typography sx={{ color: '#e5e7eb', fontSize: '0.75rem', fontWeight: 900, textTransform: 'uppercase', letterSpacing: 0, bgcolor: 'rgba(15,23,42,0.78)', px: 1, py: 0.5, borderRadius: 1 }}>
                                    {strip.title}
                                </Typography>
                                <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, justifyContent: 'flex-end' }}>
                                    {strip.pens.map(pen => (
                                        <Box key={`${strip.id}-${pen.id}-legend`} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, bgcolor: 'rgba(15,23,42,0.78)', px: 0.75, py: 0.4, borderRadius: 1 }}>
                                            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: pen.color }} />
                                            <Typography sx={{ color: '#cbd5e1', fontSize: '0.65rem', fontWeight: 800, maxWidth: 92, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {metricShortLabel(pen.metric)}
                                            </Typography>
                                        </Box>
                                    ))}
                                </Box>
                            </Box>
                            <ResponsiveContainer width="100%" height="100%">
                                <LineChart
                                    data={data}
                                    layout="vertical"
                                    syncId={EDR_SYNC_ID}
                                    margin={{ top: 48, right: 12, left: isDepthLog ? 0 : 4, bottom: 16 }}
                                >
                                    <CartesianGrid strokeDasharray="3 3" stroke="#243044" horizontal vertical />
                                    <YAxis
                                        dataKey="timestamp"
                                        type="number"
                                        scale="time"
                                        domain={selectedTimeDomain}
                                        ticks={selectedTimeTicks}
                                        tickFormatter={formatTimeTick}
                                        stroke="#94a3b8"
                                        width={isDepthLog ? (selectedPeriodMs >= 24 * 60 * 60 * 1000 ? 104 : 80) : 0}
                                        hide={!isDepthLog}
                                        tick={isDepthLog ? { fontSize: 11, fill: '#22c55e' } : false}
                                        axisLine={isDepthLog}
                                        tickLine={isDepthLog}
                                    />
                                    {strip.pens.map(pen => (
                                        <XAxis
                                            key={`${strip.id}-${pen.id}-axis`}
                                            type="number"
                                            xAxisId={pen.id}
                                            orientation="top"
                                            hide
                                            domain={[pen.min, pen.max]}
                                        />
                                    ))}
                                    <Tooltip
                                        contentStyle={{ backgroundColor: '#1e293b', border: '1px solid #334155', color: 'white' }}
                                        cursor={{ stroke: '#e5e7eb', strokeWidth: 1, strokeDasharray: '4 4' }}
                                        labelFormatter={(label) => new Date(label).toLocaleTimeString()}
                                        formatter={(value, name) => {
                                            const unit = metricUnit(name);
                                            const formatted = Number.isFinite(Number(value))
                                                ? Number(value).toFixed(metricPrecision(name))
                                                : value;
                                            return [`${formatted}${unit ? ` ${unit}` : ''}`, metricLabel(name)];
                                        }}
                                    />
                                    {Number.isFinite(Number(activeCursorTimestamp)) && (
                                        <ReferenceLine
                                            xAxisId={strip.pens[0]?.id}
                                            y={activeCursorTimestamp}
                                            stroke="#f8fafc"
                                            strokeWidth={1.5}
                                            strokeDasharray="4 4"
                                            ifOverflow="extendDomain"
                                        />
                                    )}
                                    {strip.pens.map(pen => (
                                        <Line
                                            key={`${strip.id}-${pen.id}-line`}
                                            type="monotone"
                                            dataKey={pen.metric}
                                            xAxisId={pen.id}
                                            stroke={pen.color}
                                            strokeWidth={2}
                                            dot={false}
                                            connectNulls
                                            isAnimationActive={false}
                                        />
                                    ))}
                                </LineChart>
                            </ResponsiveContainer>
                        </Paper>

                        <Paper sx={{ mt: 1, p: 0.75, bgcolor: '#d6d3d1', borderRadius: 1, border: '2px solid #a8a29e', boxShadow: 'inset 0 2px 4px rgba(255,255,255,0.5)' }}>
                            <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(132px, 1fr))', gap: 0.75 }}>
                                {strip.pens.map(pen => (
                                    <Box key={`${strip.id}-${pen.id}-readout`} sx={{ bgcolor: '#111827', border: '2px solid #78716c', borderRadius: 1, overflow: 'hidden', minWidth: 0 }}>
                                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 0.75, py: 0.5, bgcolor: '#f8fafc' }}>
                                            <Box sx={{ width: 8, height: 24, borderRadius: '4px', bgcolor: pen.color, flex: '0 0 auto' }} />
                                            <Typography sx={{ color: '#111827', fontSize: '0.72rem', fontWeight: 900, textTransform: 'uppercase', lineHeight: 1.1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                {metricShortLabel(pen.metric)}
                                            </Typography>
                                        </Box>
                                        <Box sx={{ px: 1, py: 0.65, textAlign: 'center', boxShadow: 'inset 0 0 10px rgba(0,0,0,1)' }}>
                                            <Typography sx={{ fontSize: '1.25rem', fontWeight: 900, color: '#22c55e', lineHeight: 1 }}>
                                                {getLatestValue(pen.metric)}
                                            </Typography>
                                            <Typography sx={{ color: '#94a3b8', fontSize: '0.62rem', mt: 0.3 }}>
                                                {metricUnit(pen.metric) || 'unitless'} | {pen.min} - {pen.max}
                                            </Typography>
                                        </Box>
                                    </Box>
                                ))}
                            </Box>
                        </Paper>
                        </Box>
                        );
                    })}
                </Box>
            </Box>

            <Dialog
                open={isConfigOpen}
                onClose={() => setIsConfigOpen(false)}
                maxWidth="lg"
                fullWidth
                PaperProps={{ sx: { bgcolor: '#111827', color: '#e5e7eb', border: '1px solid #334155' } }}
            >
                <DialogTitle sx={{ fontWeight: 900, borderBottom: '1px solid #334155' }}>EDR Configuration</DialogTitle>
                <DialogContent dividers sx={{ borderColor: '#334155', bgcolor: '#0b1120' }}>
                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mb: 2, alignItems: 'center' }}>
                        <FormControl size="small" sx={{ minWidth: 220 }}>
                            <Typography sx={{ color: '#94a3b8', fontSize: '0.75rem', fontWeight: 800, mb: 0.5 }}>PRESET</Typography>
                            <Select
                                value={selectedPresetId}
                                onChange={(e) => applyPreset(e.target.value)}
                                MenuProps={menuProps}
                                sx={selectSx}
                            >
                                {presetOptions.map(option => (
                                    <MenuItem key={option.id} value={option.id}>{option.name}</MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                        <TextField
                            label="Preset Name"
                            value={presetName}
                            onChange={(e) => setPresetName(e.target.value)}
                            size="small"
                            sx={{ ...formFieldSx, minWidth: 220 }}
                        />
                        <Button
                            variant="outlined"
                            startIcon={<Save size={16} />}
                            onClick={savePreset}
                            sx={{ color: '#e5e7eb', borderColor: '#334155', alignSelf: 'flex-end' }}
                        >
                            Save Preset
                        </Button>
                        <Button
                            variant="outlined"
                            startIcon={<Trash2 size={16} />}
                            onClick={deletePreset}
                            disabled={selectedPresetId === 'default'}
                            sx={{ color: '#fca5a5', borderColor: '#7f1d1d', alignSelf: 'flex-end', '&.Mui-disabled': { color: '#64748b', borderColor: '#334155' } }}
                        >
                            Delete
                        </Button>
                    </Box>

                    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, mb: 2, alignItems: 'center' }}>
                        <FormControl size="small" sx={{ minWidth: 180 }}>
                            <Typography sx={{ color: '#94a3b8', fontSize: '0.75rem', fontWeight: 800, mb: 0.5 }}>NO. OF STRIPS</Typography>
                            <Select
                                value={draftConfig.stripCount}
                                onChange={(e) => handleDraftCountChange('stripCount', e.target.value)}
                                MenuProps={menuProps}
                                sx={selectSx}
                            >
                                {STRIP_OPTIONS.map(option => <MenuItem key={option} value={option}>{option}</MenuItem>)}
                            </Select>
                        </FormControl>
                        <FormControl size="small" sx={{ minWidth: 180 }}>
                            <Typography sx={{ color: '#94a3b8', fontSize: '0.75rem', fontWeight: 800, mb: 0.5 }}>NO. OF PENS PER STRIP</Typography>
                            <Select
                                value={draftConfig.pensPerStrip}
                                onChange={(e) => handleDraftCountChange('pensPerStrip', e.target.value)}
                                MenuProps={menuProps}
                                sx={selectSx}
                            >
                                {PEN_OPTIONS.map(option => <MenuItem key={option} value={option}>{option}</MenuItem>)}
                            </Select>
                        </FormControl>
                    </Box>

                    <Grid container spacing={2}>
                        {draftConfig.strips.map((strip, stripIndex) => (
                            <Grid item xs={12} md={6} key={strip.id}>
                                <Paper sx={{ bgcolor: '#111827', border: '1px solid #334155', p: 1.5, borderRadius: 1 }}>
                                    <TextField
                                        label={`Strip ${stripIndex + 1}`}
                                        value={strip.title}
                                        onChange={(e) => handleDraftStripChange(stripIndex, e.target.value)}
                                        size="small"
                                        fullWidth
                                        sx={{ ...formFieldSx, mb: 1.5 }}
                                    />
                                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.25 }}>
                                        {strip.pens.map((pen, penIndex) => (
                                            <Paper key={pen.id} sx={{ bgcolor: '#0f172a', border: '1px solid #243044', p: 1.25, borderRadius: 1 }}>
                                                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                                    <Box sx={{ width: 10, height: 28, borderRadius: '4px', bgcolor: pen.color, flex: '0 0 auto' }} />
                                                    <Typography sx={{ color: '#e5e7eb', fontWeight: 900, minWidth: 42 }}>P{penIndex + 1}</Typography>
                                                    <FormControl size="small" fullWidth>
                                                        <Select
                                                            value={pen.metric}
                                                            onChange={(e) => handleDraftPenChange(stripIndex, penIndex, 'metric', e.target.value)}
                                                            MenuProps={menuProps}
                                                            sx={selectSx}
                                                        >
                                                            {metricOptions(`${strip.id}-${pen.id}`)}
                                                        </Select>
                                                    </FormControl>
                                                </Box>
                                                <Grid container spacing={1}>
                                                    <Grid item xs={4}>
                                                        <TextField
                                                            label="Min"
                                                            type="number"
                                                            value={pen.min}
                                                            onChange={(e) => handleDraftPenChange(stripIndex, penIndex, 'min', e.target.value)}
                                                            size="small"
                                                            fullWidth
                                                            sx={formFieldSx}
                                                        />
                                                    </Grid>
                                                    <Grid item xs={4}>
                                                        <TextField
                                                            label="Max"
                                                            type="number"
                                                            value={pen.max}
                                                            onChange={(e) => handleDraftPenChange(stripIndex, penIndex, 'max', e.target.value)}
                                                            size="small"
                                                            fullWidth
                                                            sx={formFieldSx}
                                                        />
                                                    </Grid>
                                                    <Grid item xs={4}>
                                                        <TextField
                                                            label="Color"
                                                            type="color"
                                                            value={COLOR_RE.test(pen.color || '') ? pen.color : '#38bdf8'}
                                                            onChange={(e) => handleDraftPenChange(stripIndex, penIndex, 'color', e.target.value)}
                                                            size="small"
                                                            fullWidth
                                                            sx={{
                                                                ...formFieldSx,
                                                                '& input': { height: 23, p: '4px' }
                                                            }}
                                                        />
                                                    </Grid>
                                                </Grid>
                                            </Paper>
                                        ))}
                                    </Box>
                                </Paper>
                            </Grid>
                        ))}
                    </Grid>

                    {canPersistConfig && (
                        <Paper sx={{ mt: 2, bgcolor: '#111827', border: '1px solid #334155', p: 1.5, borderRadius: 1 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
                                <History size={16} color="#7dd3fc" />
                                <Typography sx={{ color: '#e5e7eb', fontWeight: 900 }}>Version History</Typography>
                            </Box>
                            {auditEvents.length === 0 ? (
                                <Typography sx={{ color: '#64748b', fontSize: '0.8rem' }}>No saved EDR changes yet.</Typography>
                            ) : (
                                <Box sx={{ display: 'grid', gap: 0.75 }}>
                                    {auditEvents.map(event => (
                                        <Box key={event.id} sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '100px 1fr 140px' }, gap: 1, alignItems: 'center', bgcolor: '#0f172a', border: '1px solid #243044', borderRadius: 1, px: 1, py: 0.75 }}>
                                            <Typography sx={{ color: '#7dd3fc', fontWeight: 900, fontSize: '0.78rem' }}>v{event.version}</Typography>
                                            <Typography sx={{ color: '#cbd5e1', fontSize: '0.78rem' }}>
                                                {(event.summary?.edr?.stripCount || '-')} strips x {(event.summary?.edr?.pensPerStrip || '-')} pens by {event.by || 'unknown'}
                                            </Typography>
                                            <Typography sx={{ color: '#64748b', fontSize: '0.72rem', textAlign: { xs: 'left', md: 'right' } }}>
                                                {event.ts ? new Date(event.ts).toLocaleString() : ''}
                                            </Typography>
                                        </Box>
                                    ))}
                                </Box>
                            )}
                        </Paper>
                    )}
                </DialogContent>
                <DialogActions sx={{ borderTop: '1px solid #334155', p: 1.5, bgcolor: '#111827' }}>
                    <Button
                        variant="outlined"
                        startIcon={<RotateCcw size={16} />}
                        onClick={resetDraftConfig}
                        sx={{ color: '#e5e7eb', borderColor: '#334155' }}
                    >
                        Reset
                    </Button>
                    <Box sx={{ flex: 1 }} />
                    {!canPersistConfig && (
                        <Chip size="small" label="Session only" sx={{ bgcolor: '#1e293b', color: '#fbbf24', border: '1px solid #334155', mr: 1 }} />
                    )}
                    <Button onClick={() => setIsConfigOpen(false)} sx={{ color: '#94a3b8' }}>Cancel</Button>
                    <Button
                        variant="contained"
                        startIcon={<Save size={16} />}
                        onClick={saveDraftConfig}
                        sx={{ bgcolor: '#38bdf8', color: '#0f172a', fontWeight: 900 }}
                    >
                        {canPersistConfig ? 'Save' : 'Apply'}
                    </Button>
                </DialogActions>
            </Dialog>

            <Snackbar
                open={notice.open}
                autoHideDuration={3500}
                onClose={() => setNotice(prev => ({ ...prev, open: false }))}
                anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            >
                <Alert severity={notice.severity} variant="filled" onClose={() => setNotice(prev => ({ ...prev, open: false }))}>
                    {notice.message}
                </Alert>
            </Snackbar>
        </Box>
    );
}
