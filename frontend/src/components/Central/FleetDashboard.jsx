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
    Grid,
    MenuItem,
    Paper,
    Snackbar,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Typography
} from '@mui/material';
import { Plus, RefreshCw, Save, Trash2 } from 'lucide-react';
import axios from '../../api';
import { useAuth } from '../../context/AuthContext';

const POLL_MS = 15000;
const STATUS_COLOR = {
    online: '#22c55e',
    healthy: '#22c55e',
    stale: '#f59e0b',
    buffering: '#38bdf8',
    offline: '#ef4444',
    planned: '#94a3b8',
    'not-configured': '#94a3b8'
};

const fieldSx = {
    bgcolor: '#0f172a',
    input: { color: 'white' },
    label: { color: '#94a3b8' },
    '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' },
    '.MuiSvgIcon-root': { color: '#94a3b8' },
    '.MuiSelect-select': { color: 'white' }
};

const headSx = { color: '#94a3b8', borderColor: '#334155', fontWeight: 900, whiteSpace: 'nowrap' };
const cellSx = { color: '#e5e7eb', borderColor: '#1e293b' };

const blankRig = {
    id: '',
    source: 'remote',
    rigName: '',
    wellName: '',
    assetType: 'Workover Rig',
    basin: '',
    location: '',
    connectionMode: 'site-gateway',
    status: 'planned',
    syncStatus: 'not-configured',
    lastSyncAt: '',
    offlineBufferCount: 0,
    syncLagSec: 0,
    notes: ''
};

const toRoleText = (values) => (Array.isArray(values) ? values.join(', ') : '');
const fromRoleText = (value) => value.split(',').map(item => item.trim()).filter(Boolean);
const fmtLag = (sec) => {
    const n = Number(sec);
    if (!Number.isFinite(n) || n <= 0) return '0s';
    if (n < 60) return `${Math.round(n)}s`;
    if (n < 3600) return `${Math.round(n / 60)}m`;
    return `${Math.round(n / 3600)}h`;
};

function StatusChip({ value }) {
    const label = value || 'unknown';
    return (
        <Chip
            size="small"
            label={label.replace(/-/g, ' ')}
            sx={{
                bgcolor: `${STATUS_COLOR[label] || '#64748b'}22`,
                color: STATUS_COLOR[label] || '#cbd5e1',
                border: `1px solid ${STATUS_COLOR[label] || '#64748b'}`,
                fontWeight: 900,
                textTransform: 'uppercase'
            }}
        />
    );
}

export default function FleetDashboard() {
    const { user } = useAuth();
    const isAdmin = user?.role === 'admin';
    const [snapshot, setSnapshot] = useState({ summary: {}, rigs: [], roleMappings: {} });
    const [loading, setLoading] = useState(false);
    const [notice, setNotice] = useState({ open: false, severity: 'success', message: '' });
    const [rigDialogOpen, setRigDialogOpen] = useState(false);
    const [editingRig, setEditingRig] = useState(blankRig);
    const [roleDraft, setRoleDraft] = useState({ admin: '', operator: '', viewer: '' });

    const loadFleet = useCallback(async () => {
        setLoading(true);
        try {
            const res = await axios.get('/api/central/rigs');
            setSnapshot(res.data || { summary: {}, rigs: [], roleMappings: {} });
            setRoleDraft({
                admin: toRoleText(res.data?.roleMappings?.admin),
                operator: toRoleText(res.data?.roleMappings?.operator),
                viewer: toRoleText(res.data?.roleMappings?.viewer)
            });
        } catch (err) {
            console.error('Failed to load fleet:', err);
            setNotice({ open: true, severity: 'error', message: 'Failed to load fleet dashboard.' });
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadFleet();
        const timer = setInterval(loadFleet, POLL_MS);
        return () => clearInterval(timer);
    }, [loadFleet]);

    const summaryCards = useMemo(() => ([
        { label: 'Total Rigs', value: snapshot.summary?.total || 0, color: '#7dd3fc' },
        { label: 'Online', value: snapshot.summary?.online || 0, color: '#22c55e' },
        { label: 'Stale / Offline', value: (snapshot.summary?.stale || 0) + (snapshot.summary?.offline || 0), color: '#f59e0b' },
        { label: 'Offline Buffering', value: snapshot.summary?.buffering || 0, color: '#38bdf8' },
        { label: 'Active Alarms', value: snapshot.summary?.activeAlarms || 0, color: '#ef4444' },
        { label: 'Unacked Alarms', value: snapshot.summary?.unackedAlarms || 0, color: '#fb7185' }
    ]), [snapshot.summary]);

    const saveRegistry = async (rigs = snapshot.rigs, roleMappings = snapshot.roleMappings) => {
        if (!isAdmin) return;
        try {
            const res = await axios.post('/api/central/rigs', { rigs, roleMappings });
            setSnapshot(res.data || snapshot);
            setNotice({ open: true, severity: 'success', message: 'Fleet registry saved.' });
        } catch (err) {
            console.error('Failed to save fleet registry:', err);
            setNotice({ open: true, severity: 'error', message: err.response?.data?.error || 'Failed to save fleet registry.' });
        }
    };

    const openRigDialog = (rig = blankRig) => {
        setEditingRig({ ...blankRig, ...rig, lastSyncAt: rig.lastSyncAt || '' });
        setRigDialogOpen(true);
    };

    const saveRig = () => {
        const id = editingRig.id || editingRig.rigName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const nextRig = { ...editingRig, id: id || `rig-${Date.now().toString(36)}`, source: editingRig.source === 'local' ? 'local' : 'remote' };
        const rigs = [
            ...snapshot.rigs.filter(rig => rig.id !== nextRig.id),
            nextRig
        ];
        saveRegistry(rigs, snapshot.roleMappings);
        setRigDialogOpen(false);
    };

    const deleteRig = (rigId) => {
        if (rigId === 'local') return;
        saveRegistry(snapshot.rigs.filter(rig => rig.id !== rigId), snapshot.roleMappings);
    };

    const saveRoles = async () => {
        const roleMappings = {
            admin: fromRoleText(roleDraft.admin),
            operator: fromRoleText(roleDraft.operator),
            viewer: fromRoleText(roleDraft.viewer)
        };
        try {
            const res = await axios.post('/api/central/role-mapping', { roleMappings });
            setSnapshot(prev => ({ ...prev, roleMappings: res.data.roleMappings || roleMappings }));
            setNotice({ open: true, severity: 'success', message: 'Role mapping saved.' });
        } catch (err) {
            console.error('Failed to save role mapping:', err);
            setNotice({ open: true, severity: 'error', message: 'Failed to save role mapping.' });
        }
    };

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                <Box>
                    <Typography variant="h5" sx={{ fontWeight: 900 }}>Central Fleet Dashboard</Typography>
                    <Typography sx={{ color: '#94a3b8', fontSize: '0.85rem' }}>
                        {snapshot.generatedAt ? `Updated ${new Date(snapshot.generatedAt).toLocaleString()}` : ''}
                    </Typography>
                </Box>
                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                    <Button variant="outlined" startIcon={<RefreshCw size={16} />} onClick={loadFleet} disabled={loading} sx={{ color: '#e5e7eb', borderColor: '#334155' }}>
                        Refresh
                    </Button>
                    {isAdmin && (
                        <Button variant="contained" startIcon={<Plus size={16} />} onClick={() => openRigDialog()} sx={{ bgcolor: '#38bdf8', color: '#0f172a', fontWeight: 900 }}>
                            Add Rig
                        </Button>
                    )}
                </Box>
            </Box>

            <Grid container spacing={1.5}>
                {summaryCards.map(card => (
                    <Grid item xs={6} md={2} key={card.label}>
                        <Paper sx={{ p: 1.5, bgcolor: '#111827', border: '1px solid #334155', borderRadius: 1 }}>
                            <Typography sx={{ color: '#94a3b8', fontSize: '0.75rem', fontWeight: 900, textTransform: 'uppercase' }}>{card.label}</Typography>
                            <Typography sx={{ color: card.color, fontSize: '1.7rem', fontWeight: 900, lineHeight: 1.2 }}>{card.value}</Typography>
                        </Paper>
                    </Grid>
                ))}
            </Grid>

            <TableContainer component={Paper} sx={{ bgcolor: '#111827', border: '1px solid #334155', borderRadius: 1 }}>
                <Table size="small">
                    <TableHead>
                        <TableRow>
                            <TableCell sx={headSx}>Rig / Well</TableCell>
                            <TableCell sx={headSx}>Location</TableCell>
                            <TableCell sx={headSx}>Status</TableCell>
                            <TableCell sx={headSx}>Sync</TableCell>
                            <TableCell sx={headSx}>Buffer</TableCell>
                            <TableCell sx={headSx}>Alarms</TableCell>
                            <TableCell sx={headSx}>Activity</TableCell>
                            {isAdmin && <TableCell sx={headSx} align="right">Actions</TableCell>}
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {(snapshot.rigs || []).map(rig => (
                            <TableRow key={rig.id} hover>
                                <TableCell sx={cellSx}>
                                    <Typography sx={{ fontWeight: 900 }}>{rig.rigName}</Typography>
                                    <Typography sx={{ color: '#94a3b8', fontSize: '0.78rem' }}>{rig.wellName || 'No well assigned'}</Typography>
                                </TableCell>
                                <TableCell sx={cellSx}>
                                    <Typography>{rig.basin || '-'}</Typography>
                                    <Typography sx={{ color: '#94a3b8', fontSize: '0.78rem' }}>{rig.location || '-'}</Typography>
                                </TableCell>
                                <TableCell sx={cellSx}><StatusChip value={rig.status} /></TableCell>
                                <TableCell sx={cellSx}>
                                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, alignItems: 'flex-start' }}>
                                        <StatusChip value={rig.syncStatus} />
                                        <Typography sx={{ color: '#94a3b8', fontSize: '0.75rem' }}>{fmtLag(rig.syncLagSec)} lag</Typography>
                                    </Box>
                                </TableCell>
                                <TableCell sx={cellSx}>
                                    <Typography sx={{ color: Number(rig.offlineBufferCount) > 0 ? '#38bdf8' : '#94a3b8', fontWeight: 900 }}>
                                        {rig.offlineBufferCount || 0}
                                    </Typography>
                                </TableCell>
                                <TableCell sx={cellSx}>
                                    <Typography sx={{ color: (rig.alarmCounts?.active || 0) > 0 ? '#ef4444' : '#22c55e', fontWeight: 900 }}>
                                        {rig.alarmCounts?.active || 0} active
                                    </Typography>
                                    <Typography sx={{ color: '#94a3b8', fontSize: '0.75rem' }}>{rig.alarmCounts?.unack || 0} unack</Typography>
                                </TableCell>
                                <TableCell sx={cellSx}>{rig.currentActivity?.label || '-'}</TableCell>
                                {isAdmin && (
                                    <TableCell sx={cellSx} align="right">
                                        <Button size="small" onClick={() => openRigDialog(rig)} sx={{ color: '#7dd3fc' }}>Edit</Button>
                                        <Button size="small" startIcon={<Trash2 size={14} />} onClick={() => deleteRig(rig.id)} disabled={rig.id === 'local'} sx={{ color: '#fca5a5', '&.Mui-disabled': { color: '#64748b' } }}>
                                            Delete
                                        </Button>
                                    </TableCell>
                                )}
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>

            <Paper sx={{ p: 2, bgcolor: '#111827', border: '1px solid #334155', borderRadius: 1 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, alignItems: 'center', flexWrap: 'wrap', mb: 1.5 }}>
                    <Typography sx={{ fontWeight: 900 }}>Central Role Mapping</Typography>
                    {isAdmin && (
                        <Button variant="outlined" startIcon={<Save size={16} />} onClick={saveRoles} sx={{ color: '#e5e7eb', borderColor: '#334155' }}>
                            Save Roles
                        </Button>
                    )}
                </Box>
                <Grid container spacing={1.5}>
                    {['admin', 'operator', 'viewer'].map(role => (
                        <Grid item xs={12} md={4} key={role}>
                            <TextField
                                label={role.toUpperCase()}
                                value={roleDraft[role] || ''}
                                onChange={(e) => setRoleDraft(prev => ({ ...prev, [role]: e.target.value }))}
                                disabled={!isAdmin}
                                fullWidth
                                multiline
                                minRows={2}
                                sx={fieldSx}
                            />
                        </Grid>
                    ))}
                </Grid>
            </Paper>

            <Dialog open={rigDialogOpen} onClose={() => setRigDialogOpen(false)} maxWidth="md" fullWidth PaperProps={{ sx: { bgcolor: '#111827', color: '#e5e7eb', border: '1px solid #334155' } }}>
                <DialogTitle sx={{ fontWeight: 900 }}>Rig Registry</DialogTitle>
                <DialogContent dividers sx={{ borderColor: '#334155' }}>
                    <Grid container spacing={1.5} sx={{ mt: 0 }}>
                        {[
                            ['id', 'Rig ID'],
                            ['rigName', 'Rig Name'],
                            ['wellName', 'Well Name'],
                            ['assetType', 'Asset Type'],
                            ['basin', 'Basin / Asset'],
                            ['location', 'Location'],
                            ['connectionMode', 'Connection Mode'],
                            ['lastSyncAt', 'Last Sync ISO'],
                            ['offlineBufferCount', 'Offline Buffer Count'],
                            ['syncLagSec', 'Sync Lag Sec'],
                            ['notes', 'Notes']
                        ].map(([key, label]) => (
                            <Grid item xs={12} md={key === 'notes' ? 12 : 6} key={key}>
                                <TextField
                                    label={label}
                                    value={editingRig[key] ?? ''}
                                    onChange={(e) => setEditingRig(prev => ({ ...prev, [key]: e.target.value }))}
                                    disabled={key === 'id' && editingRig.id === 'local'}
                                    fullWidth
                                    multiline={key === 'notes'}
                                    minRows={key === 'notes' ? 2 : undefined}
                                    type={['offlineBufferCount', 'syncLagSec'].includes(key) ? 'number' : 'text'}
                                    sx={fieldSx}
                                />
                            </Grid>
                        ))}
                        <Grid item xs={12} md={6}>
                            <TextField select label="Status" value={editingRig.status || 'planned'} onChange={(e) => setEditingRig(prev => ({ ...prev, status: e.target.value }))} fullWidth sx={fieldSx}>
                                {['online', 'stale', 'offline', 'planned'].map(option => <MenuItem key={option} value={option}>{option}</MenuItem>)}
                            </TextField>
                        </Grid>
                        <Grid item xs={12} md={6}>
                            <TextField select label="Sync Status" value={editingRig.syncStatus || 'not-configured'} onChange={(e) => setEditingRig(prev => ({ ...prev, syncStatus: e.target.value }))} fullWidth sx={fieldSx}>
                                {['healthy', 'stale', 'buffering', 'offline', 'not-configured'].map(option => <MenuItem key={option} value={option}>{option}</MenuItem>)}
                            </TextField>
                        </Grid>
                    </Grid>
                </DialogContent>
                <DialogActions sx={{ borderTop: '1px solid #334155' }}>
                    <Button onClick={() => setRigDialogOpen(false)} sx={{ color: '#94a3b8' }}>Cancel</Button>
                    <Button variant="contained" onClick={saveRig} sx={{ bgcolor: '#38bdf8', color: '#0f172a', fontWeight: 900 }}>Save Rig</Button>
                </DialogActions>
            </Dialog>

            <Snackbar open={notice.open} autoHideDuration={3500} onClose={() => setNotice(prev => ({ ...prev, open: false }))} anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}>
                <Alert severity={notice.severity} variant="filled" onClose={() => setNotice(prev => ({ ...prev, open: false }))}>
                    {notice.message}
                </Alert>
            </Snackbar>
        </Box>
    );
}
