import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Paper, TextField, Button, Typography, Alert, Container } from '@mui/material';
import { User, Lock, Activity } from 'lucide-react';
import axios from '../../api';
import { useAuth } from '../../context/AuthContext';

const Login = () => {
    const [credentials, setCredentials] = useState({ username: '', password: '' });
    const [error, setError] = useState('');
    const [loading, setLoading] = useState(false);
    const navigate = useNavigate();
    const { login } = useAuth();
    const [authInfo, setAuthInfo] = useState(null);

    useEffect(() => {
        axios.get('/api/auth/info').then((r) => setAuthInfo(r.data)).catch(() => {});
    }, []);

    const handleChange = (e) => {
        setCredentials({ ...credentials, [e.target.name]: e.target.value });
    };

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');
        setLoading(true);

        try {
            // Use relative path which will be proxied by Vite
            const API_URL = '';
            const res = await axios.post(`${API_URL}/api/login`, credentials);

            if (res.data.success) {
                login(res.data.user, res.data.token);
                navigate('/');
            }
        } catch (err) {
            setError(err.response?.data?.message || 'Failed to login. Please check server connection.');
        } finally {
            setLoading(false);
        }
    };

    return (
        <Box
            sx={{
                width: '100vw',
                height: '100vh',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: '#0f172a',
                backgroundImage: 'radial-gradient(circle at 50% 50%, #1e293b 0%, #0f172a 100%)'
            }}
        >
            <Container maxWidth="xs">
                <Paper
                    elevation={24}
                    sx={{
                        p: 4,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        bgcolor: 'rgba(30, 41, 59, 0.8)',
                        backdropFilter: 'blur(10px)',
                        border: '1px solid rgba(255, 255, 255, 0.1)',
                        borderRadius: 4
                    }}
                >
                    <Box sx={{ mb: 3, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                        <Activity size={48} color="#38bdf8" />
                        <Typography variant="h4" sx={{ mt: 2, fontWeight: 'bold', color: '#fff', letterSpacing: 1 }}>
                            AHWR-50 Twin
                        </Typography>
                        <Typography variant="subtitle2" sx={{ color: '#94a3b8' }}>
                            Digital Twin Access
                        </Typography>
                        {authInfo?.ldapEnabled && (
                            <Typography variant="caption" sx={{ color: '#64748b', mt: 0.5, textAlign: 'center' }}>
                                Windows domain sign-in enabled — use{' '}
                                {authInfo.domain ? `${authInfo.domain}\\username` : 'DOMAIN\\username'}
                            </Typography>
                        )}
                    </Box>

                    {error && (
                        <Alert severity="error" sx={{ width: '100%', mb: 2, bgcolor: 'rgba(239, 68, 68, 0.1)', color: '#fca5a5' }}>
                            {error}
                        </Alert>
                    )}

                    <Box component="form" onSubmit={handleSubmit} sx={{ width: '100%' }}>
                        <TextField
                            margin="normal"
                            required
                            fullWidth
                            id="username"
                            label="User ID"
                            name="username"
                            autoComplete="username"
                            autoFocus
                            value={credentials.username}
                            onChange={handleChange}
                            InputProps={{
                                startAdornment: <User size={20} color="#94a3b8" style={{ marginRight: 10 }} />,
                            }}
                            sx={{
                                '& .MuiOutlinedInput-root': {
                                    color: '#fff',
                                    '& fieldset': { borderColor: '#475569' },
                                    '&:hover fieldset': { borderColor: '#94a3b8' },
                                    '&.Mui-focused fieldset': { borderColor: '#38bdf8' },
                                },
                                '& .MuiInputLabel-root': { color: '#94a3b8' },
                                '& .MuiInputLabel-root.Mui-focused': { color: '#38bdf8' }
                            }}
                        />
                        <TextField
                            margin="normal"
                            required
                            fullWidth
                            name="password"
                            label="Password"
                            type="password"
                            id="password"
                            autoComplete="current-password"
                            value={credentials.password}
                            onChange={handleChange}
                            InputProps={{
                                startAdornment: <Lock size={20} color="#94a3b8" style={{ marginRight: 10 }} />,
                            }}
                            sx={{
                                '& .MuiOutlinedInput-root': {
                                    color: '#fff',
                                    '& fieldset': { borderColor: '#475569' },
                                    '&:hover fieldset': { borderColor: '#94a3b8' },
                                    '&.Mui-focused fieldset': { borderColor: '#38bdf8' },
                                },
                                '& .MuiInputLabel-root': { color: '#94a3b8' },
                                '& .MuiInputLabel-root.Mui-focused': { color: '#38bdf8' }
                            }}
                        />
                        <Button
                            type="submit"
                            fullWidth
                            variant="contained"
                            disabled={loading}
                            sx={{
                                mt: 3,
                                mb: 2,
                                py: 1.5,
                                bgcolor: '#38bdf8',
                                '&:hover': { bgcolor: '#0284c7' },
                                fontWeight: 'bold'
                            }}
                        >
                            {loading ? 'Authenticating...' : 'Sign In'}
                        </Button>
                    </Box>
                </Paper>
            </Container>
        </Box>
    );
};

export default Login;
