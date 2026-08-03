import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
    Box, Typography, Paper, Grid, Button, TextField, Chip, Table, TableBody,
    TableCell, TableContainer, TableHead, TableRow, Divider, CircularProgress,
    useTheme
} from '@mui/material';
import {
    BrainCircuit, Sparkles, RefreshCw, Send, Lightbulb, TrendingUp, TrendingDown,
    Minus, AlertTriangle
} from 'lucide-react';
import axios from '../../api';

// Live advisor snapshot (advisories / earlyWarnings / signals / llm) is polled;
// the LLM guidance is loaded once on mount + on explicit refresh because the
// local-model call is slow. Monitoring-only — nothing here writes to the rig/PLC.
const POLL_MS = 4000;

// Advisory severity -> MUI palette group. critical=error, warning=warning,
// watch=info, info=default(text.secondary).
const SEVERITY_GROUP = {
    critical: 'error',
    warning: 'warning',
    watch: 'info',
    info: 'default',
};

function fmtNum(n, digits = 2) {
    if (n == null || Number.isNaN(Number(n))) return '—';
    const v = Number(n);
    // Keep integers clean; otherwise fixed precision.
    return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('en-US', { hour12: false });
}

// Resolve a palette color from a severity group name.
function severityColor(theme, group) {
    if (!group || group === 'default') return theme.palette.text.secondary;
    return theme.palette[group]?.main || theme.palette.text.secondary;
}

function TrendGlyph({ trend, theme }) {
    if (trend === 'up') return <TrendingUp size={16} color={theme.palette.error.main} aria-label="up" />;
    if (trend === 'down') return <TrendingDown size={16} color={theme.palette.info.main} aria-label="down" />;
    return <Minus size={16} color={theme.palette.text.secondary} aria-label="flat" />;
}

function LlmStatusChip({ llm, theme }) {
    let label;
    let color;
    if (!llm || !llm.enabled) {
        label = 'Rule-based guidance';
        color = theme.palette.text.secondary;
    } else if (llm.reachable === false) {
        label = `Model unreachable (${llm.model || 'local'})`;
        color = theme.palette.warning.main;
    } else {
        label = `Local model: ${llm.model || 'local'}`;
        color = theme.palette.success.main;
    }
    return (
        <Chip
            icon={<Sparkles size={14} />}
            label={label}
            size="small"
            sx={{
                bgcolor: `${color}22`,
                color,
                fontWeight: 'bold',
                border: `1px solid ${color}`,
                '& .MuiChip-icon': { color },
            }}
        />
    );
}

function AdvisoryCard({ adv, theme }) {
    const group = SEVERITY_GROUP[adv.severity] || 'default';
    const color = severityColor(theme, group);
    const hasValue = adv.value != null || adv.baseline != null;
    return (
        <Paper
            sx={{
                p: 1.75,
                bgcolor: theme.palette.background.paper,
                borderLeft: `4px solid ${color}`,
                border: `1px solid ${theme.palette.divider}`,
                borderLeftColor: color,
            }}
        >
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Chip
                    label={(adv.severity || 'info').toUpperCase()}
                    size="small"
                    sx={{ bgcolor: `${color}22`, color, fontWeight: 'bold', height: 20 }}
                />
                <Typography sx={{ fontWeight: 'bold', color: theme.palette.text.primary }}>
                    {adv.title}
                </Typography>
                {adv.signal && (
                    <Chip label={adv.signal} size="small" variant="outlined"
                        sx={{ color: theme.palette.text.secondary, borderColor: theme.palette.divider, height: 20 }} />
                )}
                <Box sx={{ flexGrow: 1 }} />
                <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>{fmtTime(adv.ts)}</Typography>
            </Box>
            {adv.detail && (
                <Typography variant="body2" sx={{ color: theme.palette.text.secondary, mt: 0.75 }}>
                    {adv.detail}
                </Typography>
            )}
            {hasValue && (
                <Box sx={{ display: 'flex', gap: 2, mt: 0.75, flexWrap: 'wrap' }}>
                    <Typography variant="body2" sx={{ color: theme.palette.text.primary }}>
                        Value: <b style={{ color }}>{fmtNum(adv.value)}{adv.unit ? ` ${adv.unit}` : ''}</b>
                    </Typography>
                    {adv.baseline != null && (
                        <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                            Baseline: {fmtNum(adv.baseline)}{adv.unit ? ` ${adv.unit}` : ''}
                        </Typography>
                    )}
                </Box>
            )}
            {adv.suggestion && (
                <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.75, mt: 1, p: 1, bgcolor: theme.palette.background.default, borderRadius: 1, border: `1px dashed ${theme.palette.divider}` }}>
                    <Lightbulb size={15} color={theme.palette.primary.main} style={{ flexShrink: 0, marginTop: 2 }} />
                    <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                        {adv.suggestion}
                    </Typography>
                </Box>
            )}
        </Paper>
    );
}

function EarlyWarningCard({ ew, theme }) {
    const accent = theme.palette.secondary?.main || theme.palette.primary.main;
    const conf = ew.confidence != null ? Math.round(Number(ew.confidence)) : null;
    const basedOn = ew.basedOn || {};
    return (
        <Paper sx={{ p: 1.75, bgcolor: theme.palette.background.paper, border: `1px dashed ${accent}` }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Chip label="PREDICTIVE" size="small" icon={<AlertTriangle size={13} />}
                    sx={{ bgcolor: `${accent}22`, color: accent, fontWeight: 'bold', height: 20, '& .MuiChip-icon': { color: accent } }} />
                <Typography sx={{ fontWeight: 'bold', color: theme.palette.text.primary }}>{ew.title}</Typography>
                <Box sx={{ flexGrow: 1 }} />
                {conf != null && (
                    <Chip label={`${conf}% confidence`} size="small"
                        sx={{ bgcolor: `${accent}22`, color: accent, fontWeight: 'bold', height: 20 }} />
                )}
            </Box>
            {ew.detail && (
                <Typography variant="body2" sx={{ color: theme.palette.text.secondary, mt: 0.75 }}>
                    {ew.detail}
                </Typography>
            )}
            {(basedOn.event || basedOn.date || basedOn.outcome || basedOn.category) && (
                <Typography variant="caption" sx={{ color: theme.palette.text.secondary, display: 'block', mt: 0.75 }}>
                    Based on: {[basedOn.event, basedOn.category, basedOn.outcome].filter(Boolean).join(' · ')}
                    {basedOn.date ? ` (${basedOn.date})` : ''}
                </Typography>
            )}
        </Paper>
    );
}

export default function AdvisorPage() {
    const theme = useTheme();

    const [llm, setLlm] = useState(null);
    const [advisories, setAdvisories] = useState([]);
    const [earlyWarnings, setEarlyWarnings] = useState([]);
    const [signals, setSignals] = useState([]);

    // LLM guidance (loaded once + on refresh).
    const [guidance, setGuidance] = useState(null);
    const [guidanceLoading, setGuidanceLoading] = useState(false);

    // Ask box.
    const [question, setQuestion] = useState('');
    const [answer, setAnswer] = useState(null);
    const [asking, setAsking] = useState(false);

    const mounted = useRef(true);

    // Poll the advisor snapshot (NOT guidance). 401 is handled silently by the
    // api interceptor (it bounces to /login), so we just swallow errors here.
    const loadSnapshot = useCallback(() => {
        axios.get('/api/advisor')
            .then(({ data }) => {
                if (!mounted.current || !data) return;
                setLlm(data.llm || null);
                setAdvisories(Array.isArray(data.advisories) ? data.advisories : []);
                setEarlyWarnings(Array.isArray(data.earlyWarnings) ? data.earlyWarnings : []);
                setSignals(Array.isArray(data.signals) ? data.signals : []);
            })
            .catch((err) => {
                if (err?.response?.status !== 401) console.error('advisor snapshot failed:', err);
            });
    }, []);

    const loadGuidance = useCallback((force = false) => {
        setGuidanceLoading(true);
        axios.get(`/api/advisor/guidance${force ? '?force=true' : ''}`)
            .then(({ data }) => {
                if (mounted.current) setGuidance(data || null);
            })
            .catch((err) => {
                if (err?.response?.status !== 401) console.error('advisor guidance failed:', err);
            })
            .finally(() => {
                if (mounted.current) setGuidanceLoading(false);
            });
    }, []);

    useEffect(() => {
        mounted.current = true;
        loadSnapshot();
        loadGuidance(false);
        const id = setInterval(loadSnapshot, POLL_MS);
        return () => {
            mounted.current = false;
            clearInterval(id);
        };
    }, [loadSnapshot, loadGuidance]);

    const handleAsk = async () => {
        const q = question.trim();
        if (!q || asking) return;
        setAsking(true);
        try {
            const { data } = await axios.post('/api/advisor/ask', { question: q });
            setAnswer(data || null);
        } catch (err) {
            if (err?.response?.status !== 401) {
                setAnswer({ source: 'rules', answer: err.response?.data?.error || 'Failed to get an answer.' });
            }
        } finally {
            setAsking(false);
        }
    };

    const headSx = { color: theme.palette.text.secondary, fontWeight: 'bold', borderColor: theme.palette.divider, whiteSpace: 'nowrap' };
    const cellSx = { color: theme.palette.text.primary, borderColor: theme.palette.divider };
    const fieldSx = {
        bgcolor: theme.palette.background.default,
        '& .MuiInputBase-input': { color: theme.palette.text.primary },
        '& .MuiInputLabel-root': { color: theme.palette.text.secondary },
        '& .MuiOutlinedInput-notchedOutline': { borderColor: theme.palette.divider },
    };

    const guidanceFromLlm = guidance?.source === 'llm';
    const recommendations = Array.isArray(guidance?.recommendations) ? guidance.recommendations : [];

    return (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            {/* Header */}
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                <Box>
                    <Typography variant="h6" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                        <BrainCircuit size={22} /> Operator Advisor
                    </Typography>
                    <Typography variant="body2" sx={{ color: theme.palette.text.secondary, mt: 0.5 }}>
                        Read-only guidance derived from live telemetry and past events — monitoring only; nothing writes to the rig.
                    </Typography>
                </Box>
                <Box sx={{ flexGrow: 1 }} />
                <LlmStatusChip llm={llm} theme={theme} />
            </Box>

            {/* Guidance card */}
            <Paper sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                        <Sparkles size={18} /> Current Guidance
                    </Typography>
                    <Chip
                        label={guidanceFromLlm ? `Local model: ${guidance?.model || 'local'}` : 'Rule-based'}
                        size="small"
                        sx={{
                            bgcolor: guidanceFromLlm ? `${theme.palette.success.main}22` : `${theme.palette.text.secondary}22`,
                            color: guidanceFromLlm ? theme.palette.success.main : theme.palette.text.secondary,
                            fontWeight: 'bold', height: 22,
                            border: `1px solid ${guidanceFromLlm ? theme.palette.success.main : theme.palette.divider}`,
                        }}
                    />
                    <Box sx={{ flexGrow: 1 }} />
                    <Button
                        size="small"
                        variant="outlined"
                        startIcon={guidanceLoading ? <CircularProgress size={14} /> : <RefreshCw size={15} />}
                        onClick={() => loadGuidance(true)}
                        disabled={guidanceLoading}
                        sx={{ color: theme.palette.primary.main, borderColor: theme.palette.divider, textTransform: 'none' }}
                    >
                        {guidanceLoading ? 'Refreshing…' : 'Refresh'}
                    </Button>
                </Box>
                {guidance?.llmError && (
                    <Typography variant="caption" sx={{ color: theme.palette.warning.main, display: 'block', mb: 1 }}>
                        Local model error — fell back to rules: {String(guidance.llmError)}
                    </Typography>
                )}
                <Typography variant="body2" sx={{ color: theme.palette.text.primary, whiteSpace: 'pre-wrap' }}>
                    {guidance?.narrative || (guidanceLoading ? 'Generating guidance…' : 'No guidance available yet.')}
                </Typography>
                {recommendations.length > 0 && (
                    <Box component="ul" sx={{ mt: 1.5, mb: 0, pl: 3, color: theme.palette.text.secondary }}>
                        {recommendations.map((rec, i) => (
                            <Box component="li" key={i} sx={{ mb: 0.5 }}>
                                <Typography variant="body2" sx={{ color: theme.palette.text.primary }}>{rec}</Typography>
                            </Box>
                        ))}
                    </Box>
                )}
            </Paper>

            {/* Ask box */}
            <Paper sx={{ p: 2, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                    <Send size={18} /> Ask the Advisor
                </Typography>
                <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', flexWrap: { xs: 'wrap', sm: 'nowrap' } }}>
                    <TextField
                        fullWidth
                        size="small"
                        placeholder="e.g. Why is the LS margin trending down?"
                        value={question}
                        onChange={(e) => setQuestion(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAsk(); } }}
                        disabled={asking}
                        sx={fieldSx}
                    />
                    <Button
                        variant="contained"
                        onClick={handleAsk}
                        disabled={asking || !question.trim()}
                        startIcon={asking ? <CircularProgress size={14} color="inherit" /> : <Send size={15} />}
                        sx={{ textTransform: 'none', fontWeight: 'bold', whiteSpace: 'nowrap' }}
                    >
                        {asking ? 'Asking…' : 'Ask'}
                    </Button>
                </Box>
                {answer && (
                    <Box sx={{ mt: 1.5, p: 1.5, bgcolor: theme.palette.background.default, borderRadius: 1, border: `1px solid ${theme.palette.divider}` }}>
                        <Chip
                            label={answer.source === 'llm' ? `Local model: ${answer.model || 'local'}` : 'Rule-based'}
                            size="small"
                            sx={{
                                bgcolor: answer.source === 'llm' ? `${theme.palette.success.main}22` : `${theme.palette.text.secondary}22`,
                                color: answer.source === 'llm' ? theme.palette.success.main : theme.palette.text.secondary,
                                fontWeight: 'bold', height: 20, mb: 1,
                            }}
                        />
                        <Typography variant="body2" sx={{ color: theme.palette.text.primary, whiteSpace: 'pre-wrap' }}>
                            {answer.answer}
                        </Typography>
                    </Box>
                )}
            </Paper>

            {/* Advisories + Early warnings */}
            <Grid container spacing={3}>
                <Grid item xs={12} md={7}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                        <AlertTriangle size={18} /> Advisories
                    </Typography>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                        {advisories.map((adv) => (
                            <AdvisoryCard key={adv.id} adv={adv} theme={theme} />
                        ))}
                        {advisories.length === 0 && (
                            <Paper sx={{ p: 3, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, textAlign: 'center' }}>
                                <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                                    No active advisories — process within normal bounds.
                                </Typography>
                            </Paper>
                        )}
                    </Box>
                </Grid>

                <Grid item xs={12} md={5}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
                        <Lightbulb size={18} /> Early Warnings
                    </Typography>
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                        {earlyWarnings.map((ew) => (
                            <EarlyWarningCard key={ew.id} ew={ew} theme={theme} />
                        ))}
                        {earlyWarnings.length === 0 && (
                            <Paper sx={{ p: 3, bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}`, textAlign: 'center' }}>
                                <Typography variant="body2" sx={{ color: theme.palette.text.secondary }}>
                                    No predictive warnings from past events.
                                </Typography>
                            </Paper>
                        )}
                    </Box>
                </Grid>
            </Grid>

            {/* Top signals */}
            <Paper sx={{ bgcolor: theme.palette.background.paper, border: `1px solid ${theme.palette.divider}` }}>
                <Box sx={{ p: 2 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: theme.palette.primary.main, display: 'flex', alignItems: 'center', gap: 1 }}>
                        <TrendingUp size={18} /> Top Signals
                    </Typography>
                    <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                        Live values vs baseline, with a z-score and trend direction.
                    </Typography>
                </Box>
                <Divider sx={{ borderColor: theme.palette.divider }} />
                <TableContainer>
                    <Table size="small">
                        <TableHead>
                            <TableRow>
                                <TableCell sx={headSx}>Signal</TableCell>
                                <TableCell sx={headSx} align="right">Value</TableCell>
                                <TableCell sx={headSx} align="right">Baseline</TableCell>
                                <TableCell sx={headSx} align="right">z</TableCell>
                                <TableCell sx={headSx} align="center">Trend</TableCell>
                            </TableRow>
                        </TableHead>
                        <TableBody>
                            {signals.map((s) => (
                                <TableRow key={s.path} hover>
                                    <TableCell sx={cellSx}>
                                        {s.label || s.path}
                                        {s.label && s.path && (
                                            <Typography component="span" variant="caption" sx={{ ml: 1, color: theme.palette.text.secondary }}>
                                                {s.path}
                                            </Typography>
                                        )}
                                    </TableCell>
                                    <TableCell sx={cellSx} align="right">{fmtNum(s.value)}</TableCell>
                                    <TableCell sx={{ ...cellSx, color: theme.palette.text.secondary }} align="right">{fmtNum(s.baseline)}</TableCell>
                                    <TableCell sx={cellSx} align="right">{fmtNum(s.z, 2)}</TableCell>
                                    <TableCell sx={cellSx} align="center">
                                        <Box sx={{ display: 'inline-flex' }}><TrendGlyph trend={s.trend} theme={theme} /></Box>
                                    </TableCell>
                                </TableRow>
                            ))}
                            {signals.length === 0 && (
                                <TableRow>
                                    <TableCell colSpan={5} align="center" sx={{ color: theme.palette.text.secondary, py: 4, borderColor: theme.palette.divider }}>
                                        Awaiting live signals…
                                    </TableCell>
                                </TableRow>
                            )}
                        </TableBody>
                    </Table>
                </TableContainer>
            </Paper>
        </Box>
    );
}
