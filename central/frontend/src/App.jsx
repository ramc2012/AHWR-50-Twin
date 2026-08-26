import React, { Suspense, lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Box, CircularProgress } from '@mui/material';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Login from './components/Login';
import FleetOverview from './components/FleetOverview';

// Route-level code splitting (UI-15): every route except Login and the fleet
// landing page loads on demand, so the heavy views (recharts, EDR) stay out of
// the entry chunk. Login + FleetOverview remain eager — they are the first paint.
const RigDetail = lazy(() => import('./components/RigDetail'));
const Wells = lazy(() => import('./components/Wells'));
const WellDetail = lazy(() => import('./components/WellDetail'));
const AlarmCommandCentre = lazy(() => import('./components/AlarmCommandCentre'));
const DataQuality = lazy(() => import('./components/DataQuality'));
const WorkoverPerformance = lazy(() => import('./components/WorkoverPerformance'));
const Governance = lazy(() => import('./components/Governance'));
const Reports = lazy(() => import('./components/Reports'));
const ConfigRegistry = lazy(() => import('./components/ConfigRegistry'));
const Maintenance = lazy(() => import('./components/Maintenance'));
const Users = lazy(() => import('./components/Users'));
const Settings = lazy(() => import('./components/Settings'));

function RouteFallback() {
    return (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress size={28} />
        </Box>
    );
}

// Per-route Suspense so the Layout shell (nav, alarm strip) stays mounted while
// a lazy chunk loads — only the outlet area shows the spinner.
const lazyEl = (el) => <Suspense fallback={<RouteFallback />}>{el}</Suspense>;

function Protected({ children }) {
    const { user } = useAuth();
    if (!user) return <Navigate to="/login" replace />;
    return children;
}

// Role-gated route wrapper: redirect to the fleet overview if the user lacks the role.
function RequireRole({ role, children }) {
    const { can } = useAuth();
    if (!can(role)) return <Navigate to="/" replace />;
    return children;
}

export default function App() {
    return (
        <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<Protected><Layout /></Protected>}>
                <Route index element={<FleetOverview />} />
                <Route path="rigs/:id" element={lazyEl(<RigDetail />)} />
                <Route path="wells" element={lazyEl(<Wells />)} />
                <Route path="wells/:id" element={lazyEl(<WellDetail />)} />
                <Route path="alarms" element={lazyEl(<AlarmCommandCentre />)} />
                <Route path="data-quality" element={lazyEl(<DataQuality />)} />
                <Route path="workover" element={lazyEl(<WorkoverPerformance />)} />
                <Route path="maintenance" element={lazyEl(<Maintenance />)} />
                <Route path="governance" element={lazyEl(<Governance />)} />
                <Route path="reports" element={lazyEl(<Reports />)} />
                <Route path="registry" element={lazyEl(<ConfigRegistry />)} />
                <Route path="users" element={<RequireRole role="admin">{lazyEl(<Users />)}</RequireRole>} />
                <Route path="settings" element={<RequireRole role="admin">{lazyEl(<Settings />)}</RequireRole>} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
    );
}
