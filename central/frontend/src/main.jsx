import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider, CssBaseline } from '@mui/material';
import theme from './theme';
import { AuthProvider } from './context/AuthContext';
import ErrorBoundary from './components/ErrorBoundary';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <ThemeProvider theme={theme}>
            <CssBaseline />
            {/* Last-resort boundary (audit UI-06): a throw anywhere below lands on a
                styled fallback with a Reload CTA instead of a blank monitoring wall. */}
            <ErrorBoundary label="The monitoring console" reload>
                <BrowserRouter>
                    <AuthProvider>
                        <App />
                    </AuthProvider>
                </BrowserRouter>
            </ErrorBoundary>
        </ThemeProvider>
    </React.StrictMode>
);
