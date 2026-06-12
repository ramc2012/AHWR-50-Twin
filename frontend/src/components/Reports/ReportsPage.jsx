import React, { useState, useEffect } from 'react';
import {
    Box, Typography, Paper, Grid, Button, TextField, Table, TableBody,
    TableCell, TableContainer, TableHead, TableRow, Dialog, DialogTitle,
    DialogContent, DialogActions, Snackbar, Alert, Chip
} from '@mui/material';
import { FileText, Printer, Download, Edit2 } from 'lucide-react';
import axios from '../../api';
import { useAuth } from '../../context/AuthContext';
import { formatDuration, formatClock, todayISO } from '../../utils/format';
import { priorityColor } from '../../utils/alarms';

const headSx = { color: '#94a3b8', fontWeight: 'bold', borderColor: '#334155', whiteSpace: 'nowrap' };
const cellSx = { color: 'white', borderColor: '#1e293b' };

const HEADER_FIELDS = [
    { key: 'well', label: 'Well' },
    { key: 'rig', label: 'Rig' },
    { key: 'operator', label: 'Operator' },
    { key: 'contractor', label: 'Contractor' },
    { key: 'jobNo', label: 'Job No' },
    { key: 'field', label: 'Field' },
];

// Build a CSV string client-side (no new dependency) and trigger a download.
function downloadCSV(report, date) {
    const rows = [];
    const esc = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const line = (...cells) => rows.push(cells.map(esc).join(','));

    line('Daily Workover Report', date);
    line('');
    // Header.
    line('Header');
    const h = report.header || {};
    HEADER_FIELDS.forEach((f) => line(f.label, h[f.key] ?? ''));
    line('');
    // Activity breakdown.
    line('Activity Breakdown');
    line('Code', 'Label', 'Duration (H:MM:SS)', 'Productive');
    (report.activitySummary || []).forEach((a) =>
        line(a.code, a.label, formatDuration(a.durationSec), a.productive ? 'Yes' : 'No'));
    line('');
    // Totals.
    const t = report.totals || {};
    line('Totals');
    line('Productive', formatDuration(t.productiveSec));
    line('NPT', formatDuration(t.nptSec));
    line('Total', formatDuration(t.totalSec));
    line('');
    // NPT by reason.
    line('NPT By Reason');
    const npt = report.nptByReason || {};
    Object.entries(npt).forEach(([reason, sec]) => line(reason, formatDuration(sec)));
    line('');
    // Depth.
    const d = report.depth || {};
    line('Depth');
    line('Start', d.start ?? '');
    line('End', d.end ?? '');
    line('Progress', d.progress ?? '');
    line('');
    // Connections.
    const c = report.connections || {};
    line('Connections');
    line('Run', c.run ?? 0);
    line('Pass', c.pass ?? 0);
    line('Fail', c.fail ?? 0);
    line('Joint Counter', c.jointCounter ?? 0);
    line('');
    // Alarms.
    line('Alarms Logged');
    line('Time', 'Label', 'Priority', 'Condition');
    (report.alarms || []).forEach((a) => line(formatClock(a.ts), a.label, a.priority, a.condition));

    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `daily-report-${date}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function SummaryStat({ label, value, color = 'white' }) {
    return (
        <Box sx={{ p: 2, bgcolor: '#0f172a', borderRadius: 1, border: '1px solid #334155', textAlign: 'center' }}>
            <Typography variant="caption" sx={{ color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1 }}>{label}</Typography>
            <Typography variant="h5" sx={{ color, fontWeight: 'bold' }}>{value}</Typography>
        </Box>
    );
}

export default function ReportsPage() {
    const { user } = useAuth();
    const canWrite = user?.role === 'admin' || user?.role === 'operator';

    const [date, setDate] = useState(todayISO());
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(false);
    const [editOpen, setEditOpen] = useState(false);
    const [headerDraft, setHeaderDraft] = useState({});
    const [notification, setNotification] = useState({ open: false, message: '', severity: 'success' });

    const showNote = (message, severity = 'success') => setNotification({ open: true, message, severity });

    const loadReport = (d) => {
        setLoading(true);
        axios.get(`/api/report/daily?date=${d}`)
            .then((res) => setReport(res.data))
            .catch((err) => {
                console.error('Failed to load report:', err);
                showNote('Failed to load report', 'error');
            })
            .finally(() => setLoading(false));
    };

    useEffect(() => { loadReport(date); }, [date]);

    const openEdit = () => {
        const h = report?.header || {};
        const draft = {};
        HEADER_FIELDS.forEach((f) => { draft[f.key] = h[f.key] ?? ''; });
        setHeaderDraft(draft);
        setEditOpen(true);
    };

    const saveHeader = async () => {
        try {
            await axios.put('/api/report/header', headerDraft);
            showNote('Report header saved');
            setEditOpen(false);
            loadReport(date);
        } catch (err) {
            console.error('Save header failed:', err);
            showNote(err.response?.data?.error || 'Failed to save header', 'error');
        }
    };

    const header = report?.header || {};
    const totals = report?.totals || {};
    const depth = report?.depth || {};
    const connections = report?.connections || {};
    const nptByReason = report?.nptByReason || {};

    return (
        <Box className="report-root" sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {/* Print-only stylesheet: hide app chrome and force a light, paper layout. */}
            <style>{`
                @media print {
                    body * { visibility: hidden !important; }
                    .report-root, .report-root * { visibility: visible !important; }
                    .report-root { position: absolute; top: 0; left: 0; width: 100%; padding: 16px; }
                    .report-no-print { display: none !important; }
                    .report-root, .report-root .MuiPaper-root, .report-root .MuiTableCell-root,
                    .report-root .MuiTypography-root { color: #000 !important; }
                    .report-root .MuiPaper-root { background: #fff !important; border: 1px solid #999 !important; box-shadow: none !important; }
                    .report-root .MuiTableCell-root { border-color: #ccc !important; }
                    @page { margin: 12mm; }
                }
            `}</style>

            {/* Controls — excluded from print. */}
            <Box className="report-no-print" sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                <Typography variant="h6" sx={{ fontWeight: 'bold', color: '#38bdf8', display: 'flex', alignItems: 'center', gap: 1 }}>
                    <FileText size={22} /> Daily Workover Report
                </Typography>
                <Box sx={{ flexGrow: 1 }} />
                <TextField
                    type="date"
                    size="small"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    sx={{ bgcolor: '#0f172a', input: { color: 'white' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }}
                />
                {canWrite && (
                    <Button variant="outlined" startIcon={<Edit2 size={16} />} onClick={openEdit}
                        sx={{ color: '#38bdf8', borderColor: '#334155', textTransform: 'none' }}>
                        Edit Header
                    </Button>
                )}
                <Button variant="outlined" startIcon={<Download size={16} />} onClick={() => report && downloadCSV(report, date)} disabled={!report}
                    sx={{ color: '#4ade80', borderColor: '#334155', textTransform: 'none' }}>
                    CSV
                </Button>
                <Button variant="contained" startIcon={<Printer size={16} />} onClick={() => window.print()} disabled={!report}
                    sx={{ bgcolor: '#38bdf8', color: '#0f172a', textTransform: 'none', fontWeight: 'bold', '&:hover': { bgcolor: '#0ea5e9' } }}>
                    Print / PDF
                </Button>
            </Box>

            {!report && !loading && (
                <Paper sx={{ p: 4, bgcolor: '#1e293b', border: '1px solid #334155', textAlign: 'center', color: '#94a3b8' }}>
                    No report available for {date}.
                </Paper>
            )}

            {report && (
                <>
                    {/* Header block */}
                    <Paper sx={{ p: 3, bgcolor: '#1e293b', border: '1px solid #334155' }}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 1 }}>
                            <Typography variant="h5" sx={{ fontWeight: 'bold', color: 'white' }}>
                                Daily Workover Report — {report.date || date}
                            </Typography>
                            <Typography variant="caption" sx={{ color: '#64748b' }}>
                                Generated {report.generatedAt ? formatClock(report.generatedAt) : '--'}
                            </Typography>
                        </Box>
                        <Grid container spacing={2} sx={{ mt: 0.5 }}>
                            {HEADER_FIELDS.map((f) => (
                                <Grid item xs={6} sm={4} md={2} key={f.key}>
                                    <Typography variant="caption" sx={{ color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.5 }}>{f.label}</Typography>
                                    <Typography variant="body1" sx={{ color: 'white', fontWeight: 'bold' }}>{header[f.key] || '--'}</Typography>
                                </Grid>
                            ))}
                        </Grid>
                    </Paper>

                    {/* Totals + Depth */}
                    <Grid container spacing={2}>
                        <Grid item xs={12} md={8}>
                            <Paper sx={{ p: 3, bgcolor: '#1e293b', border: '1px solid #334155', height: '100%' }}>
                                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8', mb: 2 }}>Time Summary</Typography>
                                <Grid container spacing={2}>
                                    <Grid item xs={4}><SummaryStat label="Productive" value={formatDuration(totals.productiveSec)} color="#4ade80" /></Grid>
                                    <Grid item xs={4}><SummaryStat label="NPT" value={formatDuration(totals.nptSec)} color="#ef4444" /></Grid>
                                    <Grid item xs={4}><SummaryStat label="Total" value={formatDuration(totals.totalSec)} color="#38bdf8" /></Grid>
                                </Grid>
                                {Object.keys(nptByReason).length > 0 && (
                                    <Box sx={{ mt: 2 }}>
                                        <Typography variant="caption" sx={{ color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1 }}>NPT by Reason</Typography>
                                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 1 }}>
                                            {Object.entries(nptByReason).map(([reason, sec]) => (
                                                <Box key={reason} sx={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #334155', py: 0.5 }}>
                                                    <Typography variant="body2" sx={{ color: 'white' }}>{reason}</Typography>
                                                    <Typography variant="body2" sx={{ color: '#ef4444', fontWeight: 'bold' }}>{formatDuration(sec)}</Typography>
                                                </Box>
                                            ))}
                                        </Box>
                                    </Box>
                                )}
                            </Paper>
                        </Grid>
                        <Grid item xs={12} md={4}>
                            <Paper sx={{ p: 3, bgcolor: '#1e293b', border: '1px solid #334155', height: '100%' }}>
                                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8', mb: 2 }}>Depth Progress</Typography>
                                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                    <Row label="Start depth" value={depth.start != null ? `${depth.start} m` : '--'} />
                                    <Row label="End depth" value={depth.end != null ? `${depth.end} m` : '--'} />
                                    <Row label="Progress" value={depth.progress != null ? `${depth.progress} m` : '--'} color="#4ade80" />
                                </Box>
                                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8', mt: 3, mb: 1 }}>Connections</Typography>
                                <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap' }}>
                                    <Chip label={`Run ${connections.run ?? 0}`} size="small" sx={{ bgcolor: '#0f172a', color: '#94a3b8', border: '1px solid #334155' }} />
                                    <Chip label={`Pass ${connections.pass ?? 0}`} size="small" sx={{ bgcolor: 'rgba(74,222,128,0.15)', color: '#4ade80' }} />
                                    <Chip label={`Fail ${connections.fail ?? 0}`} size="small" sx={{ bgcolor: 'rgba(239,68,68,0.15)', color: '#ef4444' }} />
                                    <Chip label={`Joint ${connections.jointCounter ?? 0}`} size="small" sx={{ bgcolor: 'rgba(56,189,248,0.15)', color: '#38bdf8' }} />
                                </Box>
                            </Paper>
                        </Grid>
                    </Grid>

                    {/* Activity breakdown */}
                    <Paper sx={{ bgcolor: '#1e293b', border: '1px solid #334155' }}>
                        <Box sx={{ p: 2 }}>
                            <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8' }}>Activity Time Breakdown</Typography>
                        </Box>
                        <TableContainer>
                            <Table size="small">
                                <TableHead>
                                    <TableRow>
                                        <TableCell sx={headSx}>Code</TableCell>
                                        <TableCell sx={headSx}>Label</TableCell>
                                        <TableCell sx={headSx}>Type</TableCell>
                                        <TableCell sx={headSx} align="right">Duration</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {(report.activitySummary || []).map((a, i) => {
                                        const c = a.productive ? '#4ade80' : '#f59e0b';
                                        return (
                                            <TableRow key={`${a.code}-${i}`} hover>
                                                <TableCell sx={cellSx}><span style={{ color: c, fontWeight: 'bold' }}>{a.code}</span></TableCell>
                                                <TableCell sx={cellSx}>{a.label}</TableCell>
                                                <TableCell sx={cellSx}>{a.productive ? 'Productive' : 'Non-productive'}</TableCell>
                                                <TableCell sx={cellSx} align="right">{formatDuration(a.durationSec)}</TableCell>
                                            </TableRow>
                                        );
                                    })}
                                    {(report.activitySummary || []).length === 0 && (
                                        <TableRow><TableCell colSpan={4} align="center" sx={{ color: '#94a3b8', py: 3, borderColor: '#1e293b' }}>No activity recorded.</TableCell></TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </Paper>

                    {/* Alarms logged */}
                    <Paper sx={{ bgcolor: '#1e293b', border: '1px solid #334155' }}>
                        <Box sx={{ p: 2 }}>
                            <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: '#38bdf8' }}>Alarms Logged</Typography>
                        </Box>
                        <TableContainer>
                            <Table size="small">
                                <TableHead>
                                    <TableRow>
                                        <TableCell sx={headSx}>Time</TableCell>
                                        <TableCell sx={headSx}>Label</TableCell>
                                        <TableCell sx={headSx}>Priority</TableCell>
                                        <TableCell sx={headSx}>Condition</TableCell>
                                    </TableRow>
                                </TableHead>
                                <TableBody>
                                    {(report.alarms || []).map((a, i) => {
                                        const c = priorityColor(a.priority);
                                        return (
                                            <TableRow key={`${a.ts}-${i}`} hover>
                                                <TableCell sx={cellSx}>{formatClock(a.ts)}</TableCell>
                                                <TableCell sx={cellSx}>{a.label}</TableCell>
                                                <TableCell sx={cellSx}>
                                                    <Chip label={a.priority} size="small" sx={{ bgcolor: c, color: '#0f172a', fontWeight: 'bold', height: 20 }} />
                                                </TableCell>
                                                <TableCell sx={cellSx}>{a.condition}</TableCell>
                                            </TableRow>
                                        );
                                    })}
                                    {(report.alarms || []).length === 0 && (
                                        <TableRow><TableCell colSpan={4} align="center" sx={{ color: '#94a3b8', py: 3, borderColor: '#1e293b' }}>No alarms logged.</TableCell></TableRow>
                                    )}
                                </TableBody>
                            </Table>
                        </TableContainer>
                    </Paper>
                </>
            )}

            {/* Edit header dialog */}
            <Dialog open={editOpen} onClose={() => setEditOpen(false)} PaperProps={{ sx: { bgcolor: '#1e293b', color: 'white', minWidth: 420 } }}>
                <DialogTitle>Edit Report Header</DialogTitle>
                <DialogContent>
                    <Grid container spacing={2} sx={{ mt: 0.5 }}>
                        {HEADER_FIELDS.map((f) => (
                            <Grid item xs={12} sm={6} key={f.key}>
                                <TextField
                                    label={f.label}
                                    fullWidth
                                    size="small"
                                    value={headerDraft[f.key] ?? ''}
                                    onChange={(e) => setHeaderDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                                    sx={{ bgcolor: '#0f172a', input: { color: 'white' }, label: { color: '#94a3b8' }, '.MuiOutlinedInput-notchedOutline': { borderColor: '#334155' } }}
                                />
                            </Grid>
                        ))}
                    </Grid>
                </DialogContent>
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={() => setEditOpen(false)} sx={{ color: '#94a3b8' }}>Cancel</Button>
                    <Button onClick={saveHeader} variant="contained" sx={{ bgcolor: '#38bdf8', color: '#0f172a', '&:hover': { bgcolor: '#0ea5e9' } }}>Save</Button>
                </DialogActions>
            </Dialog>

            <Snackbar open={notification.open} autoHideDuration={4000} onClose={() => setNotification({ ...notification, open: false })}>
                <Alert severity={notification.severity} variant="filled">{notification.message}</Alert>
            </Snackbar>
        </Box>
    );
}

function Row({ label, value, color = 'white' }) {
    return (
        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
            <Typography variant="body2" sx={{ color: '#94a3b8' }}>{label}</Typography>
            <Typography variant="body2" sx={{ color, fontWeight: 'bold' }}>{value}</Typography>
        </Box>
    );
}
