import React, { useEffect, useState, useCallback } from 'react';
import {
    Box, Paper, Typography, Table, TableBody, TableCell, TableHead, TableRow, Grid,
    Stack, Chip, Select, MenuItem, TextField, Button, Switch, IconButton, Tooltip, Alert,
    Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import { Add, Send, Delete } from '@mui/icons-material';
import { api } from '../api';
import { useAuth } from '../context/AuthContext';
import { PriorityChip, fmtAgo } from './common';

// Alarm-notification config + dispatch log (proposal §6.1 escalation). Channels are
// admin-editable; everyone with portal access sees the recent dispatch log.
// `section` selects what renders: 'channels' (Settings → Notifications), 'log'
// (Alarm Command Centre recent-notifications strip) or 'both' (legacy full panel).
export default function NotificationsPanel({ section = 'both' }) {
    const { can } = useAuth();
    const admin = can('admin');
    const showChannels = section !== 'log';
    const showLog = section !== 'channels';

    const [channels, setChannels] = useState([]);
    const [log, setLog] = useState([]);
    const [logLimit, setLogLimit] = useState(50);
    const [chLoading, setChLoading] = useState(showChannels);
    const [logLoading, setLogLoading] = useState(showLog);
    const [form, setForm] = useState({ type: 'webhook', target: '', min_severity: 'P1' });
    const [msg, setMsg] = useState(null); // { severity, text }
    const [delTarget, setDelTarget] = useState(null);

    const load = useCallback(() => {
        if (showChannels) {
            api.notifyChannels()
                .then((d) => setChannels(Array.isArray(d) ? d : []))
                .catch((e) => { if (e?.response?.status !== 401) setMsg({ severity: 'error', text: e?.response?.data?.error || 'Failed to load notification channels' }); })
                .finally(() => setChLoading(false));
        }
        if (showLog) {
            api.notifications(logLimit)
                .then((d) => setLog(Array.isArray(d) ? d : []))
                .catch((e) => { if (e?.response?.status !== 401) setMsg({ severity: 'error', text: e?.response?.data?.error || 'Failed to load notifications log' }); })
                .finally(() => setLogLoading(false));
        }
    }, [showChannels, showLog, logLimit]);
    useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t); }, [load]);

    const add = async () => {
        if (!form.target) return;
        try {
            await api.addNotifyChannel(form);
            setForm({ type: 'webhook', target: '', min_severity: 'P1' });
            setMsg(null);
            load();
        } catch (e) {
            if (e?.response?.status !== 401) setMsg({ severity: 'error', text: e?.response?.data?.error || 'Failed to add channel' });
        }
    };
    const toggle = async (c) => {
        try { await api.updateNotifyChannel(c.id, { enabled: !c.enabled }); load(); }
        catch (e) { if (e?.response?.status !== 401) setMsg({ severity: 'error', text: e?.response?.data?.error || 'Failed to update channel' }); }
    };
    const test = async (c) => {
        try { const r = await api.testNotifyChannel(c.id); setMsg({ severity: r.ok ? 'info' : 'error', text: r.ok ? `Test sent to ${c.target}` : `Test failed: ${r.error}` }); load(); }
        catch (e) { if (e?.response?.status !== 401) setMsg({ severity: 'error', text: e?.response?.data?.error || 'Test failed' }); }
    };
    // Delete is confirm-gated (mirrors the Settings delete-rig dialog).
    const confirmRemove = async () => {
        if (!delTarget) return;
        try { await api.deleteNotifyChannel(delTarget.id); setDelTarget(null); load(); }
        catch (e) {
            setDelTarget(null);
            if (e?.response?.status !== 401) setMsg({ severity: 'error', text: e?.response?.data?.error || 'Failed to delete channel' });
        }
    };

    const sevColor = { P1: 'error', P2: 'warning', P3: 'info' };

    return (
        <Grid container spacing={2} sx={{ mt: 0.5 }}>
            {msg && (
                <Grid item xs={12}>
                    <Alert severity={msg.severity} onClose={() => setMsg(null)}>{msg.text}</Alert>
                </Grid>
            )}
            {showChannels && (
                <Grid item xs={12} md={showLog ? 6 : 12}>
                    <Paper sx={{ p: 2, height: '100%' }}>
                        <Typography variant="h6" gutterBottom>Notification channels</Typography>
                        <Typography variant="caption" color="text.secondary">
                            Outbound webhook/email alerts on P1 (ESD/lockout/well-control) and escalations. Monitoring-only — alerts about received data; nothing is sent to a rig.
                        </Typography>
                        {admin && (
                            <Stack direction="row" spacing={1} my={1.5} flexWrap="wrap" useFlexGap>
                                <Select size="small" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
                                    <MenuItem value="webhook">webhook</MenuItem>
                                    <MenuItem value="email">email</MenuItem>
                                </Select>
                                <TextField size="small" sx={{ flexGrow: 1, minWidth: 180 }}
                                    placeholder={form.type === 'email' ? 'alerts@ongc.local' : 'https://hooks.example/…'}
                                    value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} />
                                <Select size="small" value={form.min_severity} onChange={(e) => setForm({ ...form, min_severity: e.target.value })}>
                                    <MenuItem value="P1">≥ P1</MenuItem><MenuItem value="P2">≥ P2</MenuItem><MenuItem value="P3">≥ P3</MenuItem>
                                </Select>
                                <Button variant="contained" startIcon={<Add />} onClick={add}>Add</Button>
                            </Stack>
                        )}
                        <Table size="small">
                            <TableHead><TableRow>
                                <TableCell>Type</TableCell><TableCell>Target</TableCell><TableCell>Min</TableCell>
                                <TableCell align="center">On</TableCell>{admin && <TableCell align="right">Actions</TableCell>}
                            </TableRow></TableHead>
                            <TableBody>
                                {channels.map((c) => (
                                    <TableRow key={c.id}>
                                        <TableCell><Chip size="small" variant="outlined" label={c.type} /></TableCell>
                                        <TableCell><Typography variant="caption" sx={{ wordBreak: 'break-all' }}>{c.target}</Typography></TableCell>
                                        <TableCell><PriorityChip priority={c.min_severity} /></TableCell>
                                        <TableCell align="center">
                                            <Switch size="small" checked={!!c.enabled} disabled={!admin} onChange={() => toggle(c)} />
                                        </TableCell>
                                        {admin && <TableCell align="right">
                                            <Tooltip title="Send test"><IconButton size="small" onClick={() => test(c)}><Send fontSize="small" /></IconButton></Tooltip>
                                            <Tooltip title="Delete"><IconButton size="small" color="error" onClick={() => setDelTarget(c)}><Delete fontSize="small" /></IconButton></Tooltip>
                                        </TableCell>}
                                    </TableRow>
                                ))}
                                {chLoading && !channels.length && <TableRow><TableCell colSpan={admin ? 5 : 4} sx={{ color: 'text.secondary' }}>Loading channels…</TableCell></TableRow>}
                                {!chLoading && !channels.length && <TableRow><TableCell colSpan={admin ? 5 : 4} sx={{ color: 'text.secondary' }}>No channels configured.</TableCell></TableRow>}
                            </TableBody>
                        </Table>
                    </Paper>
                </Grid>
            )}
            {showLog && (
                <Grid item xs={12} md={showChannels ? 6 : 12}>
                    <Paper sx={{ p: 2, height: '100%', maxHeight: 420, overflow: 'auto' }}>
                        <Typography variant="h6" gutterBottom>Recent notifications</Typography>
                        <Table size="small">
                            <TableHead><TableRow>
                                <TableCell>When</TableCell><TableCell>Rig</TableCell><TableCell>Sev</TableCell>
                                <TableCell>Kind</TableCell><TableCell>Channel</TableCell><TableCell>Status</TableCell>
                            </TableRow></TableHead>
                            <TableBody>
                                {log.map((n) => (
                                    <TableRow key={n.id}>
                                        <TableCell><Typography variant="caption" color="text.secondary">{fmtAgo(n.ts)}</Typography></TableCell>
                                        <TableCell><Typography variant="caption">{n.rig_id}</Typography></TableCell>
                                        <TableCell><Chip size="small" color={sevColor[n.severity] || 'default'} variant="outlined" label={n.severity} /></TableCell>
                                        <TableCell><Typography variant="caption">{n.kind}</Typography></TableCell>
                                        <TableCell><Typography variant="caption">{n.channel_type}</Typography></TableCell>
                                        <TableCell><Chip size="small" color={n.status === 'sent' ? 'success' : 'error'} variant="outlined" label={n.status} /></TableCell>
                                    </TableRow>
                                ))}
                                {logLoading && !log.length && <TableRow><TableCell colSpan={6} sx={{ color: 'text.secondary' }}>Loading notifications…</TableCell></TableRow>}
                                {!logLoading && !log.length && <TableRow><TableCell colSpan={6} sx={{ color: 'text.secondary' }}>No notifications dispatched yet.</TableCell></TableRow>}
                            </TableBody>
                        </Table>
                        {log.length >= logLimit && (
                            <Button size="small" sx={{ mt: 1 }} onClick={() => setLogLimit((l) => l + 50)}>Load more</Button>
                        )}
                    </Paper>
                </Grid>
            )}

            {/* Delete channel confirm (mirrors Settings delete-rig) */}
            <Dialog open={!!delTarget} onClose={() => setDelTarget(null)} fullWidth maxWidth="xs">
                <DialogTitle>Delete notification channel</DialogTitle>
                <DialogContent>
                    <Typography variant="body2">
                        Delete the <b>{delTarget?.type}</b> channel <code style={{ wordBreak: 'break-all' }}>{delTarget?.target}</code>?
                        Alarm notifications will stop being dispatched to this target. This cannot be undone.
                    </Typography>
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => setDelTarget(null)}>Cancel</Button>
                    <Button variant="contained" color="error" onClick={confirmRemove}>Delete</Button>
                </DialogActions>
            </Dialog>
        </Grid>
    );
}
