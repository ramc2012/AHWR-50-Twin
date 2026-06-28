import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
    Box, Typography, Paper, Button, Table, TableBody, TableCell, TableContainer,
    TableHead, TableRow, TextField, Select, MenuItem, Checkbox, IconButton,
    Snackbar, Alert, Tooltip, Autocomplete, Chip, useTheme
} from '@mui/material';
import { Save, Plus, Trash2, RotateCcw } from 'lucide-react';
import axios from '../../api';
import { socket } from '../../socket';
import { priorityColor } from '../../utils/alarms';

// Per-parameter alarm settings editor (admin only). Each row is one alarm rule.
// The Tag field is a searchable picker over the FULL parameter catalog (every
// raw telemetry tag + derived/computed KPI), so an alarm can be set on any
// parameter at the operator's discretion. The catalog is auto-derived on the
// backend from the variables registry + the live payload, so newly added
// inputs/KPIs appear here automatically.

const numStr = (v) => (v == null ? '' : String(v));
const normalize = (c) => ({
    key: c.key,
    dataKey: c.dataKey ?? '',
    label: c.label ?? '',
    unit: c.unit ?? '',
    hi: numStr(c.hi), hiHi: numStr(c.hiHi), lo: numStr(c.lo), loLo: numStr(c.loLo),
    deadband: numStr(c.deadband), onDelaySec: numStr(c.onDelaySec),
    priority: c.priority || 'P3',
    enabled: c.enabled !== false,
});

const LIMIT_COLS = [
    { key: 'hi', label: 'Hi' },
    { key: 'hiHi', label: 'HiHi' },
    { key: 'lo', label: 'Lo' },
    { key: 'loLo', label: 'LoLo' },
    { key: 'deadband', label: 'Deadband' },
    { key: 'onDelaySec', label: 'On-delay s' },
];

// Flatten the live rig_data payload to { dataKey: numericValue } for live hints.
const flattenNumeric = (obj, prefix, out) => {
    for (const [k, v] of Object.entries(obj || {})) {
        if (prefix === '' && (k === '_meta' || k === '_alarmMap' || k === '_alarms')) continue;
        const path = prefix ? `${prefix}.${k}` : k;
        if (v != null && typeof v === 'object' && !Array.isArray(v)) flattenNumeric(v, path, out);
        else if (typeof v === 'number' && Number.isFinite(v)) out[path] = v;
        else if (typeof v === 'boolean') out[path] = v ? 1 : 0;
    }
    return out;
};

const fmtVal = (v) => {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const n = Number(v);
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
};

export default function AlarmSettingsTable({ canEdit }) {
    const theme = useTheme();
    const [rows, setRows] = useState([]);
    const [catalog, setCatalog] = useState([]);
    const [liveVals, setLiveVals] = useState({});
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);
    const [toast, setToast] = useState(null);
    const liveRef = useRef({});

    const load = useCallback(() => {
        axios.get('/api/alarms/config')
            .then((r) => { setRows(Array.isArray(r.data) ? r.data.map(normalize) : []); setDirty(false); })
            .catch(() => setToast({ sev: 'error', msg: 'Failed to load alarm settings' }));
    }, []);

    useEffect(() => {
        load();
        // Full parameter catalog (raw + derived KPIs), with a snapshot value.
        axios.get('/api/alarms/catalog')
            .then((r) => {
                const list = Array.isArray(r.data) ? r.data : [];
                setCatalog(list);
                const seed = {}; list.forEach((o) => { if (o.value != null) seed[o.dataKey] = o.value; });
                liveRef.current = { ...seed, ...liveRef.current };
                setLiveVals({ ...liveRef.current });
            })
            .catch(() => {});
        // Keep the live-value hints fresh from the 1 Hz feed (display-throttled).
        const onRig = (d) => { liveRef.current = flattenNumeric(d, '', {}); };
        socket.on('rig_data', onRig);
        const tick = setInterval(() => setLiveVals({ ...liveRef.current }), 2000);
        return () => { socket.off('rig_data', onRig); clearInterval(tick); };
    }, [load]);

    const catMap = useMemo(() => Object.fromEntries(catalog.map((o) => [o.dataKey, o])), [catalog]);
    const valNow = (dk) => (dk in liveVals ? liveVals[dk] : (catMap[dk]?.value ?? null));

    const headSx = { color: theme.palette.text.secondary, fontWeight: 'bold', borderColor: theme.palette.divider, whiteSpace: 'nowrap', fontSize: 12, bgcolor: theme.palette.background.paper };
    const cellSx = { borderColor: theme.palette.divider, py: 0.5 };
    const numInput = { width: 78 };

    const update = (idx, field, value) => {
        setRows((prev) => prev.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));
        setDirty(true);
    };

    // Selecting a catalog tag fills in unit/label when they're still blank.
    const applyCatalog = (idx, opt) => {
        setRows((prev) => prev.map((r, i) => {
            if (i !== idx) return r;
            const next = { ...r, dataKey: opt.dataKey };
            if (!r.label || r.label === 'New Alarm') next.label = opt.label || opt.dataKey;
            if (!r.unit && opt.unit) next.unit = opt.unit;
            return next;
        }));
        setDirty(true);
    };

    const addRow = () => {
        setRows((prev) => [...prev, normalize({ key: `custom_${Date.now()}`, dataKey: '', label: 'New Alarm', priority: 'P3', enabled: true })]);
        setDirty(true);
    };

    const removeRow = (idx) => {
        setRows((prev) => prev.filter((_, i) => i !== idx));
        setDirty(true);
    };

    const save = async () => {
        const missing = rows.find((r) => !String(r.dataKey).trim());
        if (missing) { setToast({ sev: 'warning', msg: `"${missing.label || missing.key}" needs a Tag (dataKey)` }); return; }
        setSaving(true);
        try {
            const { data } = await axios.put('/api/alarms/config', rows);
            if (Array.isArray(data?.config)) setRows(data.config.map(normalize));
            setDirty(false);
            setToast({ sev: 'success', msg: 'Alarm settings saved' });
        } catch (e) {
            setToast({ sev: 'error', msg: e?.response?.data?.error || 'Save failed' });
        } finally {
            setSaving(false);
        }
    };

    const numCell = (idx, r, field) => (
        <TableCell sx={cellSx}>
            <TextField
                value={r[field]}
                onChange={(e) => update(idx, field, e.target.value)}
                disabled={!canEdit}
                size="small" type="number" variant="outlined"
                inputProps={{ step: 'any', style: { padding: '6px 8px', fontSize: 13 } }}
                sx={numInput}
            />
        </TableCell>
    );

    return (
        <Paper sx={{ bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', px: 1.5, py: 1, gap: 1, flexWrap: 'wrap' }}>
                <Box>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main }}>
                        Alarm Settings ({rows.length} configured · {catalog.length} parameters available)
                    </Typography>
                    {!canEdit && (
                        <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                            Read-only — admin role required to edit.
                        </Typography>
                    )}
                </Box>
                {canEdit && (
                    <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                        <Button onClick={addRow} size="small" startIcon={<Plus size={16} />} sx={{ textTransform: 'none' }}>Add</Button>
                        <Button onClick={load} size="small" startIcon={<RotateCcw size={16} />} disabled={!dirty} sx={{ textTransform: 'none', color: theme.palette.text.secondary }}>Revert</Button>
                        <Button onClick={save} variant="contained" size="small" startIcon={<Save size={16} />} disabled={!dirty || saving}
                            sx={{ textTransform: 'none', fontWeight: 'bold' }}>
                            {saving ? 'Saving…' : 'Save changes'}
                        </Button>
                    </Box>
                )}
            </Box>

            <TableContainer sx={{ maxHeight: '68vh' }}>
                <Table size="small" stickyHeader>
                    <TableHead>
                        <TableRow>
                            <TableCell sx={headSx}>On</TableCell>
                            <TableCell sx={headSx}>Label</TableCell>
                            <TableCell sx={headSx}>Tag (parameter)</TableCell>
                            <TableCell sx={headSx} align="right">Now</TableCell>
                            <TableCell sx={headSx}>Unit</TableCell>
                            <TableCell sx={headSx}>Priority</TableCell>
                            {LIMIT_COLS.map((c) => (
                                <TableCell key={c.key} sx={headSx} align="center">{c.label}</TableCell>
                            ))}
                            {canEdit && <TableCell sx={headSx} align="right">—</TableCell>}
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {rows.map((r, idx) => {
                            const opt = catMap[r.dataKey];
                            return (
                                <TableRow key={r.key} hover sx={{ opacity: r.enabled ? 1 : 0.5 }}>
                                    <TableCell sx={cellSx}>
                                        <Checkbox checked={!!r.enabled} disabled={!canEdit} size="small"
                                            onChange={(e) => update(idx, 'enabled', e.target.checked)} />
                                    </TableCell>
                                    <TableCell sx={cellSx}>
                                        <TextField value={r.label} onChange={(e) => update(idx, 'label', e.target.value)} disabled={!canEdit}
                                            size="small" variant="outlined" inputProps={{ style: { padding: '6px 8px', fontSize: 13 } }} sx={{ width: 200 }} />
                                    </TableCell>
                                    <TableCell sx={cellSx}>
                                        <Autocomplete
                                            freeSolo disableClearable
                                            options={catalog}
                                            groupBy={(o) => (o.derived ? 'Derived / KPI' : (o.group || '').toUpperCase())}
                                            getOptionLabel={(o) => (typeof o === 'string' ? o : o.dataKey)}
                                            inputValue={r.dataKey}
                                            disabled={!canEdit}
                                            onInputChange={(e, val, reason) => { if (reason !== 'reset') update(idx, 'dataKey', val); }}
                                            onChange={(e, val) => { if (val && typeof val === 'object') applyCatalog(idx, val); }}
                                            filterOptions={(opts, state) => {
                                                const q = state.inputValue.toLowerCase();
                                                return opts.filter((o) => o.dataKey.toLowerCase().includes(q) || (o.label || '').toLowerCase().includes(q)).slice(0, 60);
                                            }}
                                            renderOption={(props, o) => (
                                                <li {...props} key={o.dataKey} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'baseline' }}>
                                                    <span style={{ minWidth: 0 }}>
                                                        <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{o.dataKey}</span>
                                                        <span style={{ opacity: 0.7, marginLeft: 6 }}>{o.label}</span>
                                                    </span>
                                                    <span style={{ opacity: 0.6, fontSize: 11, whiteSpace: 'nowrap' }}>
                                                        {fmtVal(valNow(o.dataKey))} {o.unit}{o.derived ? ' · KPI' : ''}
                                                    </span>
                                                </li>
                                            )}
                                            renderInput={(params) => (
                                                <TextField {...params} placeholder="search parameter…" size="small" variant="outlined"
                                                    inputProps={{ ...params.inputProps, style: { padding: '2px 4px', fontSize: 13, fontFamily: 'monospace' } }} sx={{ width: 230 }} />
                                            )}
                                        />
                                    </TableCell>
                                    <TableCell sx={cellSx} align="right">
                                        <Typography component="span" sx={{ fontFamily: 'monospace', fontSize: 12, color: theme.palette.text.secondary }}>
                                            {fmtVal(valNow(r.dataKey))}
                                        </Typography>
                                    </TableCell>
                                    <TableCell sx={cellSx}>
                                        <TextField value={r.unit} onChange={(e) => update(idx, 'unit', e.target.value)} disabled={!canEdit}
                                            size="small" variant="outlined" inputProps={{ style: { padding: '6px 8px', fontSize: 13 } }} sx={{ width: 64 }} />
                                    </TableCell>
                                    <TableCell sx={cellSx}>
                                        <Select value={r.priority} onChange={(e) => update(idx, 'priority', e.target.value)} disabled={!canEdit}
                                            size="small" sx={{ width: 76, fontSize: 13, color: priorityColor(r.priority), fontWeight: 'bold' }}>
                                            <MenuItem value="P1" sx={{ color: priorityColor('P1'), fontWeight: 'bold' }}>P1</MenuItem>
                                            <MenuItem value="P2" sx={{ color: priorityColor('P2'), fontWeight: 'bold' }}>P2</MenuItem>
                                            <MenuItem value="P3" sx={{ color: priorityColor('P3'), fontWeight: 'bold' }}>P3</MenuItem>
                                        </Select>
                                    </TableCell>
                                    {LIMIT_COLS.map((col) => (
                                        <React.Fragment key={col.key}>{numCell(idx, r, col.key)}</React.Fragment>
                                    ))}
                                    {canEdit && (
                                        <TableCell sx={cellSx} align="right">
                                            <Tooltip title="Remove alarm">
                                                <IconButton size="small" onClick={() => removeRow(idx)} sx={{ color: theme.palette.text.secondary }}>
                                                    <Trash2 size={15} />
                                                </IconButton>
                                            </Tooltip>
                                        </TableCell>
                                    )}
                                </TableRow>
                            );
                        })}
                        {rows.length === 0 && (
                            <TableRow>
                                <TableCell colSpan={13} align="center" sx={{ color: theme.palette.text.secondary, py: 4, borderColor: theme.palette.divider }}>
                                    No alarm rules configured. Click “Add”, then pick a parameter.
                                </TableCell>
                            </TableRow>
                        )}
                    </TableBody>
                </Table>
            </TableContainer>

            <Box sx={{ px: 1.5, py: 1 }}>
                <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                    The Tag picker lists every parameter in the live feed — raw tags and derived/computed KPIs (marked “KPI”). New
                    inputs/KPIs appear automatically. Leave a limit blank to disable that threshold; deadband suppresses chatter on
                    return-to-normal; on-delay is the seconds a breach must persist before the alarm raises.
                </Typography>
            </Box>

            <Snackbar open={!!toast} autoHideDuration={3500} onClose={() => setToast(null)} anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}>
                {toast ? <Alert severity={toast.sev} variant="filled" onClose={() => setToast(null)}>{toast.msg}</Alert> : undefined}
            </Snackbar>
        </Paper>
    );
}
