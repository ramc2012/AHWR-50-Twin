import React, { useEffect, useState } from 'react';
import { useNavigate, Navigate, useSearchParams } from 'react-router-dom';
import {
    Box, Paper, TextField, Button, Typography, Alert, Stack, Chip,
} from '@mui/material';
import { useAuth } from '../context/AuthContext';
import { api } from '../api';

export default function Login() {
    const { user, login } = useAuth();
    const nav = useNavigate();
    const [params] = useSearchParams();
    const expired = params.get('expired') === '1';
    const [username, setU] = useState('');
    const [password, setP] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    const [info, setInfo] = useState(null);

    useEffect(() => {
        let alive = true;
        api.authInfo()
            .then((i) => { if (alive) setInfo(i); })
            .catch(() => { if (alive) setInfo(null); });
        return () => { alive = false; };
    }, []);

    if (user) return <Navigate to="/" replace />;

    const submit = async (e) => {
        e.preventDefault();
        setErr(''); setBusy(true);
        try { await login(username, password); nav('/'); }
        catch (ex) {
            const status = ex?.response?.status;
            if (ex?.isTimeout) setErr(ex.friendlyMessage || 'CRMF server not responding — request timed out');
            else if (!ex?.response) setErr('Cannot reach the CRMF server');
            else if (status === 401 || status === 403) setErr('Invalid user ID or password');
            else if (status === 429) setErr('Too many attempts — wait a minute');
            else setErr(ex.response?.data?.error || `Sign-in failed (HTTP ${status})`);
        }
        finally { setBusy(false); }
    };

    const ldapEnabled = !!info?.ldapEnabled;
    const mode = info?.authMode || 'local';
    const showLocal = mode === 'local' || mode === 'both';
    const domain = info?.domain || null;

    return (
        <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center',
            background: 'radial-gradient(1200px 600px at 50% -10%, #18243f, #0b1220)' }}>
            <Paper sx={{ p: 4, width: 380, maxWidth: '92vw' }} component="form" onSubmit={submit}>
                <Stack spacing={1} alignItems="center" mb={2}>
                    <Typography variant="overline" color="primary" sx={{ letterSpacing: 2 }}>ONGC · AHWR FLEET</Typography>
                    <Typography variant="h5" fontWeight={800}>CRMF</Typography>
                    <Typography variant="body2" color="text.secondary" textAlign="center">
                        Centralised Rig Monitoring Facility
                    </Typography>
                </Stack>
                {ldapEnabled && (
                    <Stack spacing={1} alignItems="center" mb={2}>
                        <Chip size="small" color="primary" variant="outlined"
                            label={domain ? `Windows domain (${domain}) or local` : 'Windows domain or local'} />
                        <Typography variant="caption" color="text.secondary" textAlign="center">
                            Use your ONGC domain username and password
                        </Typography>
                    </Stack>
                )}
                {expired && !err && (
                    <Alert severity="warning" sx={{ mb: 2 }}>Your session expired — sign in again</Alert>
                )}
                {err && <Alert severity="error" sx={{ mb: 2 }}>{err}</Alert>}
                <TextField fullWidth label="Username" value={username} onChange={(e) => setU(e.target.value)}
                    margin="normal" autoFocus autoComplete="username" />
                <TextField fullWidth label="Password" type="password" value={password} onChange={(e) => setP(e.target.value)}
                    margin="normal" autoComplete="current-password" />
                <Button type="submit" fullWidth variant="contained" size="large" sx={{ mt: 2 }} disabled={busy}>
                    {busy ? 'Signing in…' : 'Sign in'}
                </Button>
                {/* Default-credentials hint: demo builds only (explicit VITE_DEMO flag),
                    never merely because local auth mode is enabled. */}
                {showLocal && import.meta.env.VITE_DEMO === 'true' && (
                    <Stack direction="row" spacing={1} mt={2} justifyContent="center" flexWrap="wrap" useFlexGap>
                        <Chip size="small" variant="outlined" label="admin / admin123" />
                        <Chip size="small" variant="outlined" label="viewer / viewer123" />
                    </Stack>
                )}
                <Typography variant="caption" color="text.secondary" display="block" textAlign="center" mt={2}>
                    Monitoring-only platform · read-only with respect to rig PLC/control
                </Typography>
            </Paper>
        </Box>
    );
}
