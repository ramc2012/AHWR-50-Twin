import React, { useState } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import {
    Box, Paper, TextField, Button, Typography, Alert, Stack, Chip,
} from '@mui/material';
import { useAuth } from '../context/AuthContext';

export default function Login() {
    const { user, login } = useAuth();
    const nav = useNavigate();
    const [username, setU] = useState('');
    const [password, setP] = useState('');
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);

    if (user) return <Navigate to="/" replace />;

    const submit = async (e) => {
        e.preventDefault();
        setErr(''); setBusy(true);
        try { await login(username, password); nav('/'); }
        catch { setErr('Invalid credentials'); }
        finally { setBusy(false); }
    };

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
                {err && <Alert severity="error" sx={{ mb: 2 }}>{err}</Alert>}
                <TextField fullWidth label="Username" value={username} onChange={(e) => setU(e.target.value)}
                    margin="normal" autoFocus autoComplete="username" />
                <TextField fullWidth label="Password" type="password" value={password} onChange={(e) => setP(e.target.value)}
                    margin="normal" autoComplete="current-password" />
                <Button type="submit" fullWidth variant="contained" size="large" sx={{ mt: 2 }} disabled={busy}>
                    {busy ? 'Signing in…' : 'Sign in'}
                </Button>
                <Stack direction="row" spacing={1} mt={2} justifyContent="center" flexWrap="wrap" useFlexGap>
                    <Chip size="small" variant="outlined" label="admin / admin123" />
                    <Chip size="small" variant="outlined" label="viewer / viewer123" />
                </Stack>
                <Typography variant="caption" color="text.secondary" display="block" textAlign="center" mt={2}>
                    Monitoring-only platform · read-only with respect to rig PLC/control
                </Typography>
            </Paper>
        </Box>
    );
}
