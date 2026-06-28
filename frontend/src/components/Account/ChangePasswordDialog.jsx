import React, { useState } from 'react';
import {
    Dialog, DialogTitle, DialogContent, DialogActions, TextField, Button,
    Box, Typography, Alert, InputAdornment, IconButton, useTheme
} from '@mui/material';
import { Eye, EyeOff, KeyRound } from 'lucide-react';
import axios from '../../api';

// Self-service password change for the logged-in (local) user.
// Posts to /api/me/password — the backend verifies the current password and
// rejects domain (LDAP/AD) accounts (which change their password in the domain).
export default function ChangePasswordDialog({ open, onClose }) {
    const theme = useTheme();
    const [cur, setCur] = useState('');
    const [next, setNext] = useState('');
    const [confirm, setConfirm] = useState('');
    const [show, setShow] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [done, setDone] = useState(false);

    const reset = () => { setCur(''); setNext(''); setConfirm(''); setShow(false); setError(''); setDone(false); setBusy(false); };
    const close = () => { reset(); onClose(); };

    const localError = (() => {
        if (next && next.length < 8) return 'New password must be at least 8 characters.';
        if (next && confirm && next !== confirm) return 'New password and confirmation do not match.';
        if (next && cur && next === cur) return 'New password must be different from the current one.';
        return '';
    })();
    const canSubmit = cur && next && confirm && !localError && !busy;

    const submit = async () => {
        setError('');
        if (!canSubmit) return;
        setBusy(true);
        try {
            await axios.post('/api/me/password', { currentPassword: cur, newPassword: next });
            setDone(true);
            setTimeout(close, 1400);
        } catch (e) {
            setError(e?.response?.data?.error || 'Could not change password.');
            setBusy(false);
        }
    };

    const eyeAdorn = (
        <InputAdornment position="end">
            <IconButton size="small" onClick={() => setShow((s) => !s)} edge="end" aria-label="toggle visibility">
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </IconButton>
        </InputAdornment>
    );

    return (
        <Dialog open={open} onClose={close} maxWidth="xs" fullWidth>
            <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontWeight: 'bold', color: theme.palette.primary.main }}>
                <KeyRound size={18} /> Change Password
            </DialogTitle>
            <DialogContent>
                {done ? (
                    <Alert severity="success" sx={{ mt: 1 }}>Password updated. You can keep working — no need to sign in again.</Alert>
                ) : (
                    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.75, mt: 0.5 }}>
                        <Typography variant="caption" sx={{ color: theme.palette.text.secondary }}>
                            Choose a strong password (min 8 characters). Domain (Active Directory) accounts change their password in Windows.
                        </Typography>
                        <TextField
                            label="Current password" type={show ? 'text' : 'password'} value={cur}
                            onChange={(e) => setCur(e.target.value)} size="small" autoFocus autoComplete="current-password"
                            InputProps={{ endAdornment: eyeAdorn }}
                        />
                        <TextField
                            label="New password" type={show ? 'text' : 'password'} value={next}
                            onChange={(e) => setNext(e.target.value)} size="small" autoComplete="new-password"
                            InputProps={{ endAdornment: eyeAdorn }}
                        />
                        <TextField
                            label="Confirm new password" type={show ? 'text' : 'password'} value={confirm}
                            onChange={(e) => setConfirm(e.target.value)} size="small" autoComplete="new-password"
                            onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) submit(); }}
                            InputProps={{ endAdornment: eyeAdorn }}
                        />
                        {(localError || error) && <Alert severity={error ? 'error' : 'warning'} sx={{ py: 0 }}>{error || localError}</Alert>}
                    </Box>
                )}
            </DialogContent>
            {!done && (
                <DialogActions sx={{ px: 3, pb: 2 }}>
                    <Button onClick={close} sx={{ textTransform: 'none' }}>Cancel</Button>
                    <Button onClick={submit} variant="contained" disabled={!canSubmit} sx={{ textTransform: 'none', fontWeight: 'bold' }}>
                        {busy ? 'Saving…' : 'Update password'}
                    </Button>
                </DialogActions>
            )}
        </Dialog>
    );
}
