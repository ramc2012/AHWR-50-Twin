import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout/Layout';
const RigOverview = lazy(() => import('./components/RigOverview/RigOverview'));
const WellControlDashboard = lazy(() => import('./components/WellControl/WellControlDashboard'));
const EdrDashboard = lazy(() => import('./components/EDR/EdrDashboard'));
const FishingDashboard = lazy(() => import('./components/Fishing/FishingDashboard'));
const EquipmentHub = lazy(() => import('./components/Dashboards/EquipmentHub'));
const ActivityPage = lazy(() => import('./components/Activity/ActivityPage'));
const AlarmsPage = lazy(() => import('./components/Alarms/AlarmsPage'));
const WorkoverPage = lazy(() => import('./components/Workover/WorkoverPage'));
const ReportsPage = lazy(() => import('./components/Reports/ReportsPage'));
const MaintenancePage = lazy(() => import('./components/Maintenance/MaintenancePage'));
const EfficiencyPage = lazy(() => import('./components/Efficiency/EfficiencyPage'));
const VariablesPage = lazy(() => import('./components/Variables/VariablesPage'));
const EdgeSyncPage = lazy(() => import('./components/Sync/EdgeSyncPage'));
const OperationsPage = lazy(() => import('./components/Operations/OperationsPage'));
const SettingsPage = lazy(() => import('./components/Settings/SettingsPage'));

import { ThemeModeProvider } from './context/ThemeModeContext';
import { AuthProvider } from './context/AuthContext';
import Login from './components/Auth/Login';
import ProtectedRoute from './components/Auth/ProtectedRoute';

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
        <ThemeModeProvider>
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
                                <Route path="equipment" element={screen(EquipmentHub)} />
                                <Route path="activity" element={screen(ActivityPage)} />
                                <Route path="alarms" element={screen(AlarmsPage)} />
                                <Route path="operations" element={screen(OperationsPage)} />
                                <Route path="workover" element={screen(WorkoverPage)} />
                                <Route path="reports" element={screen(ReportsPage)} />
                                <Route path="maintenance" element={screen(MaintenancePage)} />
                                <Route path="efficiency" element={screen(EfficiencyPage)} />
                                <Route path="variables" element={screen(VariablesPage)} />
                                <Route path="sync" element={screen(EdgeSyncPage)} />
                                {/* Settings: any authenticated user; admin-only tabs are gated inside */}
                                <Route path="settings" element={screen(SettingsPage)} />
                                <Route path="admin" element={<Navigate to="/settings" replace />} />
                                <Route path="*" element={screen(RigOverview)} />
                            </Route>
                        </Route>
                    </Routes>
                </BrowserRouter>
            </AuthProvider>
        </ThemeModeProvider>
    );
}

export default App;
