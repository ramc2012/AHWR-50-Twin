import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
    Box, Paper, Typography, Stack, Grid, Table, TableBody, TableCell, TableHead, TableRow,
    TableContainer, TextField, Button, Dialog, DialogTitle, DialogContent, DialogActions,
    IconButton, Tooltip, Alert, Autocomplete, InputAdornment, Divider, Chip,
} from '@mui/material';
import { Add, DeleteOutline, Save, FiberManualRecord, VpnKey, Autorenew, ContentCopy } from '@mui/icons-material';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { fmtAgo } from './common';

// Pan-ONGC asset units — suggestions for the "Add rig" form (free text still allowed).
const ASSET_UNITS = [
    'Mumbai High', 'Bassein & Satellite', 'Mehsana', 'Ahmedabad', 'Ankleshwar', 'Cambay',
    'Rajahmundry (KG)', 'Karaikal (Cauvery)', 'Assam (Sivasagar)', 'Tripura (Agartala)',
    'Rajasthan (Barmer)', 'Jorhat (Assam)',
];

const ROLE_COLOR = { admin: '#7c4dff', operator: '#38bdf8', viewer: '#64748b' };

const emptyRig = { rigId: '', name: '', assetUnit: '', field: '', latitude: '', longitude: '', deviceToken: '' };

// System-settings field metadata — label, suffix, and what each setting controls.
const SETTING_FIELDS = [
    { key: 'retention_days', label: 'Storage retention', adorn: 'days', help: 'How long telemetry history is kept before TimescaleDB drops old chunks.' },
    { key: 'update_rate_sec', label: 'Update rate', adorn: 'sec', help: 'Target cadence at which edge sites push samples to the central facility.' },
    { key: 'offline_sec', label: 'Offline threshold', adorn: 'sec', help: 'Seconds without a sync before a rig is marked offline on the fleet view.' },
    { key: 'central_latency_target', label: 'Central latency target', adorn: 'sec', help: 'Target end-to-end edge→central ingest latency used for SLA health.' },
];

export default function Settings() {
    const { can } = useAuth();
    const isAdmin = can('admin');

    // ---- Fleet configuration ----------------------------------------------------
    const [rigs, setRigs] = useState([]);
    const [rigsLoading, setRigsLoading] = useState(true);
    const [addOpen, setAddOpen] = useState(false);
    const [draft, setDraft] = useState(emptyRig);
    const [savingRig, setSavingRig] = useState(false);
    const [delTarget, setDelTarget] = useState(null);

    // ---- Per-rig device token (edge sync credential) ----------------------------
    // reveal: { rig, token } shown once after create/rotate. rotateTarget: rig pending confirm.
    const [reveal, setReveal] = useState(null);
    const [rotateTarget, setRotateTarget] = useState(null);
    const [rotating, setRotating] = useState(false);
    const [copied, setCopied] = useState(false);

    // ---- System settings --------------------------------------------------------
    const [settings, setSettings] = useState(null);
    const [settingsDraft, setSettingsDraft] = useState({});
    const [savingSettings, setSavingSettings] = useState(false);
    const [settingsMsg, setSettingsMsg] = useState('');

    // ---- Presence ---------------------------------------------------------------
    const [presence, setPresence] = useState([]);

    const [err, setErr] = useState('');

    const loadRigs = useCallback(() => {
        api.rigsConfig()
            .then((d) => setRigs(Array.isArray(d) ? d : []))
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load rigs'); })
            .finally(() => setRigsLoading(false));
    }, []);

    const loadSettings = useCallback(() => {
        api.settings()
            .then((s) => { setSettings(s); setSettingsDraft(s || {}); })
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load settings'); });
    }, []);

    const loadPresence = useCallback(() => {
        api.presence()
            .then((p) => setPresence(Array.isArray(p) ? p : []))
            .catch((e) => { if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to load presence'); });
    }, []);

    useEffect(() => { loadRigs(); loadSettings(); }, [loadRigs, loadSettings]);

    // Presence: ping our own liveness, then poll the roster every ~10s.
    const presenceRef = useRef(loadPresence);
    presenceRef.current = loadPresence;
    useEffect(() => {
        api.pingPresence().catch(() => {});
        presenceRef.current();
        const t = setInterval(() => { presenceRef.current(); }, 10000);
        return () => clearInterval(t);
    }, []);

    const addRig = async () => {
        if (!draft.rigId || !draft.name) return;
        setSavingRig(true); setErr('');
        try {
            const created = await api.addRig({
                rigId: draft.rigId.trim(),
                name: draft.name.trim(),
                assetUnit: draft.assetUnit?.trim() || undefined,
                field: draft.field?.trim() || undefined,
                latitude: draft.latitude === '' ? undefined : Number(draft.latitude),
                longitude: draft.longitude === '' ? undefined : Number(draft.longitude),
                deviceToken: draft.deviceToken?.trim() || undefined,
            });
            setAddOpen(false);
            setDraft(emptyRig);
            loadRigs();
            // The device_token is the per-rig edge sync credential, returned exactly once.
            if (created?.device_token) {
                setReveal({ rig: { rig_id: created.rig_id || draft.rigId.trim(), name: created.name || draft.name.trim() }, token: created.device_token });
            }
        } catch (e) {
            if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to add rig');
        } finally {
            setSavingRig(false);
        }
    };

    // Rotate the per-rig device token (invalidates the old one on the edge). Reveals the
    // fresh token once in the same copyable dialog. Admin-only, confirm-gated.
    const rotateRig = async () => {
        if (!rotateTarget) return;
        setRotating(true); setErr('');
        try {
            const res = await api.rotateRigToken(rotateTarget.rig_id);
            setRotateTarget(null);
            loadRigs();
            if (res?.device_token) setReveal({ rig: rotateTarget, token: res.device_token });
        } catch (e) {
            if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to rotate token');
            setRotateTarget(null);
        } finally {
            setRotating(false);
        }
    };

    const copyToken = async () => {
        if (!reveal?.token) return;
        try {
            await navigator.clipboard.writeText(reveal.token);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch { /* clipboard unavailable — the token is selectable in the field */ }
    };

    const deleteRig = async () => {
        if (!delTarget) return;
        setErr('');
        try {
            await api.deleteRig(delTarget.rig_id);
            setDelTarget(null);
            loadRigs();
        } catch (e) {
            if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to delete rig');
            setDelTarget(null);
        }
    };

    const saveSettings = async () => {
        setSavingSettings(true); setErr(''); setSettingsMsg('');
        try {
            // Send only changed numeric fields.
            const patch = {};
            for (const f of SETTING_FIELDS) {
                const v = settingsDraft[f.key];
                if (v !== '' && v != null && Number(v) !== Number(settings?.[f.key])) patch[f.key] = Number(v);
            }
            if (!Object.keys(patch).length) { setSettingsMsg('No changes to save.'); return; }
            const updated = await api.setSettings(patch);
            setSettings(updated); setSettingsDraft(updated || {});
            setSettingsMsg('Settings saved.');
        } catch (e) {
            if (e?.response?.status !== 401) setErr(e?.response?.data?.error || 'Failed to save settings');
        } finally {
            setSavingSettings(false);
        }
    };

    return (
        <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <Typography variant="h5" fontWeight={800} mb={2}>Settings</Typography>
            {!isAdmin && (
                <Alert severity="info" sx={{ mb: 2 }}>
                    Read-only view. Sign in as an <b>admin</b> to manage the fleet registry and system settings.
                    Monitoring-only — the central facility never writes to a rig.
                </Alert>
            )}
            {err && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setErr('')}>{err}</Alert>}

            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', pr: 0.5 }}>
                <Stack spacing={2}>

                    {/* 1) FLEET CONFIGURATION ------------------------------------------------ */}
                    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column' }}>
                        <Stack direction="row" alignItems="center" spacing={2} mb={1}>
                            <Box sx={{ flexGrow: 1 }}>
                                <Typography variant="h6">Fleet configuration</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    Rig master registry. Adding a rig registers it for edge sync; deleting cascades its telemetry. Audit-logged.
                                </Typography>
                            </Box>
                            {isAdmin && <Button variant="contained" startIcon={<Add />} onClick={() => { setDraft(emptyRig); setAddOpen(true); }}>Add rig</Button>}
                        </Stack>
                        <TableContainer sx={{ maxHeight: 360, overflow: 'auto' }}>
                            <Table size="small" stickyHeader>
                                <TableHead><TableRow>
                                    <TableCell>Rig ID</TableCell><TableCell>Name</TableCell><TableCell>Asset unit</TableCell>
                                    <TableCell>Field</TableCell><TableCell align="right">Latitude</TableCell>
                                    <TableCell align="right">Longitude</TableCell><TableCell align="center">Token</TableCell>
                                    {isAdmin && <TableCell align="right">Actions</TableCell>}
                                </TableRow></TableHead>
                                <TableBody>
                                    {rigs.map((r) => (
                                        <TableRow key={r.rig_id} hover>
                                            <TableCell><Typography variant="caption" fontFamily="monospace">{r.rig_id}</Typography></TableCell>
                                            <TableCell><Typography variant="body2" fontWeight={700}>{r.name}</Typography></TableCell>
                                            <TableCell>{r.assetUnit || '—'}</TableCell>
                                            <TableCell>{r.field || '—'}</TableCell>
                                            <TableCell align="right">{r.latitude?.toFixed?.(4) ?? '—'}</TableCell>
                                            <TableCell align="right">{r.longitude?.toFixed?.(4) ?? '—'}</TableCell>
                                            <TableCell align="center">
                                                {r.hasToken
                                                    ? <Chip size="small" variant="outlined" color="success" icon={<VpnKey sx={{ fontSize: 14 }} />} label="set" />
                                                    : <Chip size="small" variant="outlined" label="none" />}
                                            </TableCell>
                                            {isAdmin && (
                                                <TableCell align="right">
                                                    <Tooltip title="Rotate device token (invalidates the old edge credential)">
                                                        <IconButton size="small" onClick={() => setRotateTarget(r)}>
                                                            <Autorenew fontSize="small" />
                                                        </IconButton>
                                                    </Tooltip>
                                                    <Tooltip title="Delete rig (cascade)">
                                                        <IconButton size="small" color="error" onClick={() => setDelTarget(r)}>
                                                            <DeleteOutline fontSize="small" />
                                                        </IconButton>
                                                    </Tooltip>
                                                </TableCell>
                                            )}
                                        </TableRow>
                                    ))}
                                    {!rigsLoading && !rigs.length && (
                                        <TableRow><TableCell colSpan={isAdmin ? 8 : 7} align="center" sx={{ py: 5, color: 'text.secondary' }}>No rigs configured.</TableCell></TableRow>
                                    )}
                                    {rigsLoading && !rigs.length && (
                                        <TableRow><TableCell colSpan={isAdmin ? 8 : 7} align="center" sx={{ py: 5, color: 'text.secondary' }}>Loading rigs…</TableCell></TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </Paper>

                    {/* 2) SYSTEM SETTINGS --------------------------------------------------- */}
                    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column' }}>
                        <Stack direction="row" alignItems="center" spacing={2} mb={1}>
                            <Box sx={{ flexGrow: 1 }}>
                                <Typography variant="h6">System settings</Typography>
                                <Typography variant="caption" color="text.secondary">
                                    Global ingest &amp; retention parameters. Saving applies retention and offline thresholds fleet-wide. Audit-logged.
                                </Typography>
                            </Box>
                            {isAdmin && (
                                <Button variant="contained" startIcon={<Save />} onClick={saveSettings}
                                    disabled={savingSettings || !settings}>{savingSettings ? 'Saving…' : 'Save'}</Button>
                            )}
                        </Stack>
                        {settingsMsg && <Alert severity="success" sx={{ mb: 1.5 }} onClose={() => setSettingsMsg('')}>{settingsMsg}</Alert>}
                        <Grid container spacing={2}>
                            {SETTING_FIELDS.map((f) => (
                                <Grid item xs={12} sm={6} md={3} key={f.key}>
                                    <TextField
                                        size="small" fullWidth type="number" label={f.label}
                                        value={settingsDraft[f.key] ?? ''}
                                        disabled={!isAdmin || !settings}
                                        onChange={(e) => setSettingsDraft({ ...settingsDraft, [f.key]: e.target.value })}
                                        helperText={f.help}
                                        InputProps={{ endAdornment: <InputAdornment position="end">{f.adorn}</InputAdornment> }}
                                    />
                                </Grid>
                            ))}
                        </Grid>
                        {!settings && <Typography variant="caption" color="text.secondary" sx={{ mt: 1.5 }}>Loading settings…</Typography>}
                    </Paper>

                    {/* 3) USER LIVENESS ----------------------------------------------------- */}
                    <Paper sx={{ p: 2, display: 'flex', flexDirection: 'column' }}>
                        <Box mb={1}>
                            <Typography variant="h6">Signed-in users</Typography>
                            <Typography variant="caption" color="text.secondary">
                                Live presence across the portal. Refreshes every 10 seconds.
                            </Typography>
                        </Box>
                        <Divider sx={{ mb: 1 }} />
                        <TableContainer sx={{ maxHeight: 320, overflow: 'auto' }}>
                            <Table size="small" stickyHeader>
                                <TableHead><TableRow>
                                    <TableCell align="center">Status</TableCell>
                                    <TableCell>User</TableCell><TableCell>Role</TableCell>
                                    <TableCell>Source</TableCell><TableCell align="right">Last seen</TableCell>
                                </TableRow></TableHead>
                                <TableBody>
                                    {presence.map((u) => (
                                        <TableRow key={u.username} hover>
                                            <TableCell align="center">
                                                <Tooltip title={u.online ? 'Online' : 'Offline'}>
                                                    <FiberManualRecord sx={{ fontSize: 12, color: u.online ? '#22c55e' : '#64748b' }} />
                                                </Tooltip>
                                            </TableCell>
                                            <TableCell>
                                                <Typography variant="body2" fontWeight={700}>{u.display || u.username}</Typography>
                                                <Typography variant="caption" color="text.secondary" fontFamily="monospace">{u.username}</Typography>
                                            </TableCell>
                                            <TableCell>
                                                <Typography variant="caption" sx={{ color: ROLE_COLOR[u.role] || 'text.secondary', fontWeight: 700, textTransform: 'uppercase' }}>{u.role || '—'}</Typography>
                                            </TableCell>
                                            <TableCell>{u.source || '—'}</TableCell>
                                            <TableCell align="right"><Typography variant="caption" color="text.secondary">{fmtAgo(u.lastSeen)}</Typography></TableCell>
                                        </TableRow>
                                    ))}
                                    {!presence.length && (
                                        <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>No active sessions.</TableCell></TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </Paper>

                </Stack>
            </Box>

            {/* Add rig dialog */}
            <Dialog open={addOpen} onClose={() => setAddOpen(false)} fullWidth maxWidth="sm">
                <DialogTitle>Add rig</DialogTitle>
                <DialogContent>
                    <Grid container spacing={2} mt={0}>
                        <Grid item xs={12} sm={6}>
                            <TextField size="small" fullWidth label="Rig ID" value={draft.rigId} autoComplete="off"
                                onChange={(e) => setDraft({ ...draft, rigId: e.target.value })} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField size="small" fullWidth label="Name" value={draft.name}
                                onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <Autocomplete freeSolo options={ASSET_UNITS} value={draft.assetUnit}
                                onInputChange={(_e, v) => setDraft({ ...draft, assetUnit: v })}
                                renderInput={(params) => <TextField {...params} size="small" label="Asset unit" />} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField size="small" fullWidth label="Field" value={draft.field}
                                onChange={(e) => setDraft({ ...draft, field: e.target.value })} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField size="small" fullWidth type="number" label="Latitude" value={draft.latitude}
                                onChange={(e) => setDraft({ ...draft, latitude: e.target.value })} />
                        </Grid>
                        <Grid item xs={12} sm={6}>
                            <TextField size="small" fullWidth type="number" label="Longitude" value={draft.longitude}
                                onChange={(e) => setDraft({ ...draft, longitude: e.target.value })} />
                        </Grid>
                        <Grid item xs={12}>
                            <TextField size="small" fullWidth label="Device token (optional)" value={draft.deviceToken}
                                autoComplete="off" helperText="Edge sync credential. Leave blank to auto-generate on the backend — it is shown once after save."
                                onChange={(e) => setDraft({ ...draft, deviceToken: e.target.value })} />
                        </Grid>
                    </Grid>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setAddOpen(false)}>Cancel</Button>
                    <Button variant="contained" onClick={addRig} disabled={savingRig || !draft.rigId || !draft.name}>{savingRig ? 'Saving…' : 'Add'}</Button>
                </DialogActions>
            </Dialog>

            {/* Delete rig confirm */}
            <Dialog open={!!delTarget} onClose={() => setDelTarget(null)} fullWidth maxWidth="xs">
                <DialogTitle>Delete rig</DialogTitle>
                <DialogContent>
                    <Typography variant="body2">
                        Delete rig <b>{delTarget?.name}</b> (<code>{delTarget?.rig_id}</code>)? This cascades and removes all of its
                        stored telemetry. This cannot be undone.
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDelTarget(null)}>Cancel</Button>
                    <Button variant="contained" color="error" onClick={deleteRig}>Delete</Button>
                </DialogActions>
            </Dialog>

            {/* Rotate token confirm */}
            <Dialog open={!!rotateTarget} onClose={() => !rotating && setRotateTarget(null)} fullWidth maxWidth="xs">
                <DialogTitle>Rotate device token</DialogTitle>
                <DialogContent>
                    <Typography variant="body2">
                        Generate a new device token for <b>{rotateTarget?.name}</b> (<code>{rotateTarget?.rig_id}</code>)?
                        This <b>invalidates the current token</b>; the rig's edge node will stop syncing until
                        the new token is set as <code>DEVICE_TOKEN</code> on it. The new token is shown only once.
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setRotateTarget(null)} disabled={rotating}>Cancel</Button>
                    <Button variant="contained" color="warning" onClick={rotateRig} disabled={rotating}>
                        {rotating ? 'Rotating…' : 'Rotate token'}
                    </Button>
                </DialogActions>
            </Dialog>

            {/* Device token reveal (shown once after create or rotate) */}
            <Dialog open={!!reveal} onClose={() => { setReveal(null); setCopied(false); }} fullWidth maxWidth="sm">
                <DialogTitle>Device token — save it now</DialogTitle>
                <DialogContent>
                    <Alert severity="warning" sx={{ mb: 2 }}>
                        This is the edge sync credential for <b>{reveal?.rig?.name}</b> (<code>{reveal?.rig?.rig_id}</code>).
                        It is shown <b>only once</b>. Save it now and set it as <code>DEVICE_TOKEN</code> on the rig's edge node.
                    </Alert>
                    <TextField
                        size="small" fullWidth label="Device token" value={reveal?.token || ''}
                        InputProps={{
                            readOnly: true,
                            sx: { fontFamily: 'monospace' },
                            endAdornment: (
                                <InputAdornment position="end">
                                    <Tooltip title={copied ? 'Copied' : 'Copy to clipboard'}>
                                        <IconButton size="small" onClick={copyToken}>
                                            <ContentCopy fontSize="small" />
                                        </IconButton>
                                    </Tooltip>
                                </InputAdornment>
                            ),
                        }}
                        onFocus={(e) => e.target.select()}
                    />
                </DialogContent>
                <DialogActions>
                    <Button startIcon={<ContentCopy />} onClick={copyToken}>{copied ? 'Copied' : 'Copy'}</Button>
                    <Button variant="contained" onClick={() => { setReveal(null); setCopied(false); }}>Done</Button>
                </DialogActions>
            </Dialog>
        </Box>
    );
}
