import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, createTheme } from '@mui/material/styles';
import Layout from './components/Layout/Layout';
const RigOverview = lazy(() => import('./components/RigOverview/RigOverview'));
const WellControlDashboard = lazy(() => import('./components/WellControl/WellControlDashboard'));
const TrendsDashboard = lazy(() => import('./components/Trends/TrendsDashboard'));
const EdrDashboard = lazy(() => import('./components/EDR/EdrDashboard'));
const AdminPanel = lazy(() => import('./components/Admin/AdminPanel'));
const FishingDashboard = lazy(() => import('./components/Fishing/FishingDashboard'));
const EquipmentHub = lazy(() => import('./components/Dashboards/EquipmentHub'));
const ActivityPage = lazy(() => import('./components/Activity/ActivityPage'));
const AlarmsPage = lazy(() => import('./components/Alarms/AlarmsPage'));
const WorkoverPage = lazy(() => import('./components/Workover/WorkoverPage'));
const ReportsPage = lazy(() => import('./components/Reports/ReportsPage'));
const MaintenancePage = lazy(() => import('./components/Maintenance/MaintenancePage'));
const FleetDashboard = lazy(() => import('./components/Central/FleetDashboard'));

const darkTheme = createTheme({
    palette: {
        mode: 'dark',
        primary: {
            main: '#38bdf8',
        },
        background: {
            default: '#0f172a',
            paper: '#1e293b',
        },
    },
    typography: {
        fontFamily: 'Inter, sans-serif',
    },
});

import { AuthProvider } from './context/AuthContext';
import Login from './components/Auth/Login';
import ProtectedRoute from './components/Auth/ProtectedRoute';
import RoleRoute from './components/Auth/RoleRoute';

import { ErrorBoundary } from './components/ErrorBoundary';

const screen = (Component) => (
    <ErrorBoundary>
        <Suspense fallback={<div style={{ padding: 24, color: '#94a3b8' }}>Loading...</div>}>
            <Component />
        </Suspense>
    </ErrorBoundary>
);

function App() {
    return (
        <ThemeProvider theme={darkTheme}>
            <AuthProvider>
                <BrowserRouter>
                    <Routes>
                        <Route path="/login" element={<Login />} />

                        <Route element={<ProtectedRoute />}>
                            <Route path="/" element={<Layout />}>
                                <Route index element={screen(RigOverview)} />
                                <Route path="engine" element={<Navigate to="/equipment" replace />} />
                                <Route path="wellcontrol" element={screen(WellControlDashboard)} />
                                <Route path="fishing" element={screen(FishingDashboard)} />
                                <Route path="edr" element={screen(EdrDashboard)} />
                                <Route path="trends" element={screen(TrendsDashboard)} />
                                <Route path="equipment" element={screen(EquipmentHub)} />
                                <Route path="activity" element={screen(ActivityPage)} />
                                <Route path="alarms" element={screen(AlarmsPage)} />
                                <Route path="workover" element={screen(WorkoverPage)} />
                                <Route path="reports" element={screen(ReportsPage)} />
                                <Route path="maintenance" element={screen(MaintenancePage)} />
                                <Route path="fleet" element={screen(FleetDashboard)} />
                                {/* Admin / Settings restricted to role 'admin' */}
                                <Route element={<RoleRoute allow={['admin']} />}>
                                    <Route path="admin" element={screen(AdminPanel)} />
                                </Route>
                                <Route path="*" element={screen(RigOverview)} />
                            </Route>
                        </Route>
                    </Routes>
                </BrowserRouter>
            </AuthProvider>
        </ThemeProvider>
    );
}

export default App;
