import React, { useState, useEffect, useCallback } from 'react';
import {
    Box, Typography, Paper, Grid, Button, TextField, Select, MenuItem,
    FormControl, InputLabel, Chip, IconButton, Snackbar, Alert, Collapse,
    Divider, useTheme
} from '@mui/material';
import {
    FileClock, Plus, Trash2, ChevronDown, ChevronUp, Tag, Activity as ActivityIcon,
    Bell
} from 'lucide-react';
import axios from '../../api';
import { todayISO } from '../../utils/format';

// Progress Log: an operator journal where each entry captures the live telemetry
// snapshot at the moment it was recorded, so the advisor can learn from and
// predict against past events. Monitoring/journaling only — nothing writes to the rig.

// Severity -> MUI palette group for the entry color accent.
const SEVERITY_GROUP = {
    critical: 'error',
    warning: 'warning',
    watch: 'info',
    info: 'default',
};

function severityColor(theme, severity) {
    const group = SEVERITY_GROUP[severity];
    if (!group || group === 'default') return theme.palette.text.secondary;
    return theme.palette[group]?.main || theme.palette.text.secondary;
}

function fmtDateTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString('en-US', { hour12: false });
}

function fmtNum(n) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function TelemetryPanel({ snapshot, theme }) {
    if (!snapshot) {
        return (
            <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                No telemetry snapshot was captured for this entry.
            </Typography>
        );
    }
    const sigs = Array.isArray(snapshot.signals) ? snapshot.signals : [];
    const alarms = snapshot.alarms;
    const alarmCount = Array.isArray(alarms) ? alarms.length : (alarms?.count ?? (alarms ? Object.keys(alarms).length : 0));
    return (
        <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1 }}>
                <Typography variant="caption" sx={{ color: theme.palette.text.secondary, textTransform: 'uppercase', letterSpacing: 1 }}>
                    Telemetry at this moment
                </Typography>
                {snapshot.source && (
                    <Chip label={snapshot.source} size="small" variant="outlined"
                        sx={{ color: theme.palette.text.secondary, borderColor: theme.palette.divider, height: 18 }} />
                )}
                {snapshot.ts && (
                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>{fmtDateTime(snapshot.ts)}</Typography>
                )}
            </Box>
            {sigs.length > 0 ? (
                <Grid container spacing={1}>
                    {sigs.map((s, i) => (
                        <Grid item xs={6} sm={4} md={3} key={`${s.label}-${i}`}>
                            <Paper sx={{ p: 1, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                                <Typography variant="caption" sx={{ color: theme.palette.text.secondary, display: 'block', lineHeight: 1.2 }}>
                                    {s.label}
                                </Typography>
                                <Typography variant="body2" sx={{ color: theme.palette.text.primary, fontWeight: 'bold' }}>
                                    {fmtNum(s.value)}{s.unit ? <Typography component="span" variant="caption" sx={{ ml: 0.5, color: theme.palette.text.secondary }}>{s.unit}</Typography> : null}
                                </Typography>
                            </Paper>
                        </Grid>
                    ))}
                </Grid>
            ) : (
                <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>No signal values captured.</Typography>
            )}
            <Box sx={{ display: 'flex', gap: 2, mt: 1.25, flexWrap: 'wrap' }}>
                {snapshot.activity != null && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <ActivityIcon size={14} color={theme.palette.primary.main} />
                        <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                            Activity: <b style={{ color: theme.palette.text.primary }}>{typeof snapshot.activity === 'object' ? (snapshot.activity.code || snapshot.activity.label || JSON.stringify(snapshot.activity)) : snapshot.activity}</b>
                        </Typography>
                    </Box>
                )}
                {alarms != null && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        <Bell size={14} color={alarmCount > 0 ? theme.palette.error.main : theme.palette.text.secondary} />
                        <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                            Alarms: <b style={{ color: alarmCount > 0 ? theme.palette.error.main : theme.palette.text.primary }}>{alarmCount}</b>
                        </Typography>
                    </Box>
                )}
            </Box>
        </Box>
    );
}

function LogEntry({ entry, theme, onDelete }) {
    const [open, setOpen] = useState(false);
    const color = severityColor(theme, entry.severity);
    const tags = Array.isArray(entry.tags) ? entry.tags : [];
    return (
        <Paper sx={{ p: 1.75, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, borderLeft: `4px solid ${color}` }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>{fmtDateTime(entry.ts)}</Typography>
                {entry.category && (
                    <Chip label={entry.category} size="small"
                        sx={{ bgcolor: `${theme.palette.primary.main}22`, color: theme.palette.primary.main, fontWeight: 'bold', height: 20 }} />
                )}
                <Chip label={(entry.severity || 'info').toUpperCase()} size="small"
                    sx={{ bgcolor: `${color}22`, color, fontWeight: 'bold', height: 20 }} />
                {entry.type && (
                    <Chip label={entry.type} size="small" variant="outlined"
                        sx={{ color: theme.palette.text.secondary, borderColor: theme.palette.divider, height: 20 }} />
                )}
                <Box sx={{ flexGrow: 1 }} />
                <IconButton size="small" onClick={() => onDelete(entry.id)} title="Delete entry"
                    sx={{ color: theme.palette.error.main, '&:hover': { bgcolor: `${theme.palette.error.main}1a` } }}>
                    <Trash2 size={16} />
                </IconButton>
            </Box>
            <Typography sx={{ fontWeight: 'bold', color: theme.palette.text.primary, mt: 0.5 }}>{entry.title}</Typography>
            {entry.note && (
                <Typography variant="body2" sx={{ color: theme.palette.text.secondary, mt: 0.5, whiteSpace: 'pre-wrap' }}>{entry.note}</Typography>
            )}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 1, flexWrap: 'wrap' }}>
                {entry.author && (
                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>by {entry.author}</Typography>
                )}
                {tags.length > 0 && (
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
                        <Tag size={13} color={theme.palette.text.secondary} />
                        {tags.map((t, i) => (
                            <Chip key={`${t}-${i}`} label={t} size="small" variant="outlined"
                                sx={{ color: theme.palette.text.secondary, borderColor: theme.palette.divider, height: 18 }} />
                        ))}
                    </Box>
                )}
                <Box sx={{ flexGrow: 1 }} />
                <Button
                    size="small"
                    onClick={() => setOpen((o) => !o)}
                    endIcon={open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                    sx={{ color: theme.palette.primary.main, textTransform: 'none' }}
                >
                    Telemetry at this moment
                </Button>
            </Box>
            <Collapse in={open} unmountOnExit>
                <Divider sx={{ borderColor: theme.palette.divider, my: 1.25 }} />
                <TelemetryPanel snapshot={entry.snapshot} theme={theme} />
            </Collapse>
        </Paper>
    );
}

const EMPTY_FORM = { type: 'event', category: '', severity: '', title: '', note: '', tags: '' };

export default function ProgressLogPage() {
    const theme = useTheme();

    const [meta, setMeta] = useState({ categories: [], severities: [] });
    const [entries, setEntries] = useState([]);

    // Form state.
    const [form, setForm] = useState(EMPTY_FORM);
    const [submitting, setSubmitting] = useState(false);

    // Filters.
    const [filterCategory, setFilterCategory] = useState('all');
    const [filterDate, setFilterDate] = useState('');

    const [notification, setNotification] = useState({ open: false, message: '', severity: 'success' });
    const showNote = (message, severity = 'success') => setNotification({ open: true, message, severity });

    const loadEntries = useCallback(() => {
        const params = new URLSearchParams();
        if (filterDate) params.set('date', filterDate);
        if (filterCategory && filterCategory !== 'all') params.set('category', filterCategory);
        const qs = params.toString();
        axios.get(`/api/progress-log${qs ? `?${qs}` : ''}`)
            .then(({ data }) => setEntries(Array.isArray(data) ? data : []))
            .catch((err) => {
                if (err?.response?.status !== 401) console.error('progress-log load failed:', err);
            });
    }, [filterDate, filterCategory]);

    // Load meta once; seed form defaults from it.
    useEffect(() => {
        axios.get('/api/progress-log/meta')
            .then(({ data }) => {
                const m = {
                    categories: Array.isArray(data?.categories) ? data.categories : [],
                    severities: Array.isArray(data?.severities) ? data.severities : [],
                };
                setMeta(m);
                setForm((f) => ({
                    ...f,
                    category: f.category || m.categories[0] || '',
                    severity: f.severity || (m.severities.includes('info') ? 'info' : m.severities[0]) || '',
                }));
            })
            .catch((err) => {
                if (err?.response?.status !== 401) console.error('progress-log meta failed:', err);
            });
    }, []);

    // (Re)load entries whenever filters change.
    useEffect(() => {
        loadEntries();
    }, [loadEntries]);

    const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

    const handleSubmit = async () => {
        if (!form.title.trim() || submitting) return;
        setSubmitting(true);
        const payload = {
            type: form.type.trim() || 'event',
            category: form.category,
            severity: form.severity,
            title: form.title.trim(),
            note: form.note.trim(),
        };
        const tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
        if (tags.length) payload.tags = tags;
        try {
            const { data } = await axios.post('/api/progress-log', payload);
            // Prepend the created (telemetry-stamped) entry, respecting active filters.
            const matchesFilters =
                (!filterDate || String(data?.ts || '').startsWith(filterDate)) &&
                (filterCategory === 'all' || data?.category === filterCategory);
            if (data && matchesFilters) {
                setEntries((prev) => [data, ...prev]);
            } else {
                loadEntries();
            }
            // Clear the form but keep the category/severity defaults.
            setForm((f) => ({ ...EMPTY_FORM, category: f.category, severity: f.severity }));
            showNote('Event recorded — telemetry snapshot attached.');
        } catch (err) {
            if (err?.response?.status !== 401) {
                showNote(err.response?.data?.error || 'Failed to record event.', 'error');
            }
        } finally {
            setSubmitting(false);
        }
    };

    const handleDelete = async (id) => {
        try {
            await axios.delete(`/api/progress-log/${id}`);
            setEntries((prev) => prev.filter((e) => e.id !== id));
            showNote('Entry deleted.');
        } catch (err) {
            if (err?.response?.status !== 401) {
                showNote(err.response?.data?.error || 'Failed to delete entry.', 'error');
            }
        }
    };

    const fieldSx = {
        bgcolor: theme.palette.background.default,
        color: theme.palette.text.primary,
        '.MuiSvgIcon-root': { color: theme.palette.text.primary },
        '& .MuiInputBase-input': { color: theme.palette.text.primary },
        '& .MuiInputLabel-root': { color: theme.palette.text.secondary },
        '& .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.divider },
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Header */}
            <Box>
                <Typography variant="h6" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <FileClock size={22} /> Progress Log
                </Typography>
                <Typography variant="body2" sx={{ color: theme.palette.text.secondary, mt: 0.5 }}>
                    An operator journal of notable events. Each entry captures the live telemetry snapshot at the moment it was
                    recorded, so the advisor can learn from and predict against past events. Journaling only — nothing writes to the rig.
                </Typography>
            </Box>

            {/* Record-event form */}
            <Paper sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                    <Plus size={18} /> Record an Event
                </Typography>
                <Grid container spacing={1.5}>
                    <Grid item xs={6} sm={3} md={2}>
                        <TextField label="Type" fullWidth size="small" value={form.type}
                            onChange={(e) => setField('type', e.target.value)} sx={fieldSx} />
                    </Grid>
                    <Grid item xs={6} sm={3} md={3}>
                        <FormControl fullWidth size="small">
                            <InputLabel sx={{ color: theme.palette.text.secondary }}>Category</InputLabel>
                            <Select label="Category" value={form.category}
                                onChange={(e) => setField('category', e.target.value)} sx={fieldSx}>
                                {meta.categories.map((c) => (
                                    <MenuItem key={c} value={c}>{c}</MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                    </Grid>
                    <Grid item xs={6} sm={3} md={2}>
                        <FormControl fullWidth size="small">
                            <InputLabel sx={{ color: theme.palette.text.secondary }}>Severity</InputLabel>
                            <Select label="Severity" value={form.severity}
                                onChange={(e) => setField('severity', e.target.value)} sx={fieldSx}>
                                {meta.severities.map((s) => (
                                    <MenuItem key={s} value={s}>{s}</MenuItem>
                                ))}
                            </Select>
                        </FormControl>
                    </Grid>
                    <Grid item xs={6} sm={3} md={5}>
                        <TextField label="Title" required fullWidth size="small" value={form.title}
                            onChange={(e) => setField('title', e.target.value)} sx={fieldSx} />
                    </Grid>
                    <Grid item xs={12}>
                        <TextField label="Note" fullWidth size="small" multiline minRows={2} value={form.note}
                            onChange={(e) => setField('note', e.target.value)} sx={fieldSx} />
                    </Grid>
                    <Grid item xs={12} sm={8}>
                        <TextField label="Tags (comma-separated)" fullWidth size="small" value={form.tags}
                            onChange={(e) => setField('tags', e.target.value)} sx={fieldSx} />
                    </Grid>
                    <Grid item xs={12} sm={4} sx={{ display: 'flex', alignItems: 'center' }}>
                        <Button
                            variant="contained"
                            onClick={handleSubmit}
                            disabled={submitting || !form.title.trim()}
                            startIcon={<Plus size={16} />}
                            fullWidth
                            sx={{ textTransform: 'none', fontWeight: 'bold' }}
                        >
                            {submitting ? 'Recording…' : 'Record Event'}
                        </Button>
                    </Grid>
                </Grid>
            </Paper>

            {/* Filters */}
            <Paper sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                <Box sx={{ display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Typography variant="subtitle2" sx={{ color: theme.palette.text.secondary, fontWeight: 'bold' }}>Filters</Typography>
                    <FormControl size="small" sx={{ minWidth: 180 }}>
                        <InputLabel sx={{ color: theme.palette.text.secondary }}>Category</InputLabel>
                        <Select label="Category" value={filterCategory}
                            onChange={(e) => setFilterCategory(e.target.value)} sx={fieldSx}>
                            <MenuItem value="all">All categories</MenuItem>
                            {meta.categories.map((c) => (
                                <MenuItem key={c} value={c}>{c}</MenuItem>
                            ))}
                        </Select>
                    </FormControl>
                    <TextField
                        type="date"
                        size="small"
                        label="Date"
                        InputLabelProps={{ shrink: true, sx: { color: theme.palette.text.secondary } }}
                        value={filterDate}
                        onChange={(e) => setFilterDate(e.target.value)}
                        sx={fieldSx}
                    />
                    {(filterDate || filterCategory !== 'all') && (
                        <Button size="small" onClick={() => { setFilterDate(''); setFilterCategory('all'); }}
                            sx={{ color: theme.palette.text.secondary, textTransform: 'none' }}>
                            Clear
                        </Button>
                    )}
                    <Box sx={{ flexGrow: 1 }} />
                    <Button size="small" onClick={() => setFilterDate(todayISO())}
                        sx={{ color: theme.palette.primary.main, textTransform: 'none' }}>
                        Today
                    </Button>
                </Box>
            </Paper>

            {/* Timeline */}
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                {entries.map((entry) => (
                    <LogEntry key={entry.id} entry={entry} theme={theme} onDelete={handleDelete} />
                ))}
                {entries.length === 0 && (
                    <Paper sx={{ p: 4, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, textAlign: 'center' }}>
                        <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                            No log entries{filterDate || filterCategory !== 'all' ? ' match the current filters' : ' yet'}. Record an event above to start the journal.
                        </Typography>
                    </Paper>
                )}
            </Box>

            <Snackbar open={notification.open} autoHideDuration={4000} onClose={() => setNotification({ ...notification, open: false })}>
                <Alert severity={notification.severity} variant="filled">{notification.message}</Alert>
            </Snackbar>
        </Box>
    );
}
