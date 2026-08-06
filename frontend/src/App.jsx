import { Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './components/Layout/Layout';
import { lazyWithRetry } from './lazyWithRetry';
const RigOverview = lazyWithRetry(() => import('./components/RigOverview/RigOverview'), 'RigOverview');
const RigConsoleOverview = lazyWithRetry(() => import('./components/RigOverview/RigConsoleOverview'), 'RigConsoleOverview');
const WellControlDashboard = lazyWithRetry(() => import('./components/WellControl/WellControlDashboard'), 'WellControlDashboard');
const EdrDashboard = lazyWithRetry(() => import('./components/EDR/EdrDashboard'), 'EdrDashboard');
const FishingDashboard = lazyWithRetry(() => import('./components/Fishing/FishingDashboard'), 'FishingDashboard');
const EquipmentHub = lazyWithRetry(() => import('./components/Dashboards/EquipmentHub'), 'EquipmentHub');
const ActivityPage = lazyWithRetry(() => import('./components/Activity/ActivityPage'), 'ActivityPage');
const AlarmsPage = lazyWithRetry(() => import('./components/Alarms/AlarmsPage'), 'AlarmsPage');
const WorkoverPage = lazyWithRetry(() => import('./components/Workover/WorkoverPage'), 'WorkoverPage');
const ReportsPage = lazyWithRetry(() => import('./components/Reports/ReportsPage'), 'ReportsPage');
const MaintenancePage = lazyWithRetry(() => import('./components/Maintenance/MaintenancePage'), 'MaintenancePage');
const EfficiencyPage = lazyWithRetry(() => import('./components/Efficiency/EfficiencyPage'), 'EfficiencyPage');
const VariablesPage = lazyWithRetry(() => import('./components/Variables/VariablesPage'), 'VariablesPage');
const EdgeSyncPage = lazyWithRetry(() => import('./components/Sync/EdgeSyncPage'), 'EdgeSyncPage');
const OperationsPage = lazyWithRetry(() => import('./components/Operations/OperationsPage'), 'OperationsPage');
const WellPage = lazyWithRetry(() => import('./components/Well/WellPage'), 'WellPage');
const SettingsPage = lazyWithRetry(() => import('./components/Settings/SettingsPage'), 'SettingsPage');

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
                                <Route index element={screen(RigConsoleOverview)} />
                                <Route path="overview-classic" element={screen(RigOverview)} />
                                <Route path="engine" element={<Navigate to="/equipment" replace />} />
                                <Route path="wellcontrol" element={screen(WellControlDashboard)} />
                                <Route path="fishing" element={screen(FishingDashboard)} />
                                <Route path="edr" element={screen(EdrDashboard)} />
                                <Route path="equipment" element={screen(EquipmentHub)} />
                                <Route path="activity" element={screen(ActivityPage)} />
                                <Route path="alarms" element={screen(AlarmsPage)} />
                                <Route path="operations" element={screen(OperationsPage)} />
                                <Route path="well" element={screen(WellPage)} />
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
