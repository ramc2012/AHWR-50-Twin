import axios from 'axios';

// Same-origin: nginx proxies /api and /socket.io to the CRMF backend.
axios.defaults.baseURL = '';

const stored = localStorage.getItem('crmf_token');
if (stored) axios.defaults.headers.common['Authorization'] = 'Bearer ' + stored;

let handling401 = false;
axios.interceptors.response.use(
    (r) => r,
    (error) => {
        if (error?.response?.status === 401 && !handling401) {
            handling401 = true;
            localStorage.removeItem('crmf_token');
            localStorage.removeItem('crmf_user');
            delete axios.defaults.headers.common['Authorization'];
            if (window.location.pathname !== '/login') window.location.assign('/login');
            else handling401 = false;
        }
        return Promise.reject(error);
    }
);

export const setToken = (token) => {
    if (token) {
        localStorage.setItem('crmf_token', token);
        axios.defaults.headers.common['Authorization'] = 'Bearer ' + token;
    } else {
        localStorage.removeItem('crmf_token');
        delete axios.defaults.headers.common['Authorization'];
    }
};

export const api = {
    login: (username, password) => axios.post('/api/auth/login', { username, password }).then((r) => r.data),
    me: () => axios.get('/api/auth/me').then((r) => r.data),
    fleet: () => axios.get('/api/fleet').then((r) => r.data),
    summary: () => axios.get('/api/fleet/summary').then((r) => r.data),
    rig: (id) => axios.get(`/api/rigs/${id}`).then((r) => r.data),
    history: (id, metric, minutes) => axios.get(`/api/rigs/${id}/history`, { params: { metric, minutes } }).then((r) => r.data),
    alarms: (priority) => axios.get('/api/alarms', { params: { priority } }).then((r) => r.data),
    dataQuality: () => axios.get('/api/data-quality').then((r) => r.data),
    workover: (hours) => axios.get('/api/workover', { params: { hours } }).then((r) => r.data),
    governance: () => axios.get('/api/governance').then((r) => r.data),
    updateDeployment: (rigId, patch) => axios.patch(`/api/governance/deployment/${rigId}`, patch).then((r) => r.data),
    addEscalation: (body) => axios.post('/api/governance/escalations', body).then((r) => r.data),
    updateEscalation: (id, patch) => axios.patch(`/api/governance/escalations/${id}`, patch).then((r) => r.data),
    addDecision: (body) => axios.post('/api/governance/decisions', body).then((r) => r.data),
    tags: () => axios.get('/api/config/tags').then((r) => r.data),
    rigsConfig: () => axios.get('/api/config/rigs').then((r) => r.data),
    // Reporting periods (audit #29): snapshot (default, current behaviour) | daily | weekly | monthly.
    report: (period) => axios.get('/api/reports/fleet', { params: period ? { period } : {} }).then((r) => r.data),

    // Maintenance & Reliability (audit #7).
    maintenance: (params) => axios.get('/api/maintenance', { params }).then((r) => r.data),
    maintenanceSummary: () => axios.get('/api/maintenance/summary').then((r) => r.data),
    addMaintenance: (body) => axios.post('/api/maintenance', body).then((r) => r.data),
    updateMaintenance: (id, patch) => axios.patch(`/api/maintenance/${id}`, patch).then((r) => r.data),

    // User & Access Management (audit #8) — admin-only on the backend.
    users: () => axios.get('/api/users').then((r) => r.data),
    addUser: (body) => axios.post('/api/users', body).then((r) => r.data),
    updateUser: (username, patch) => axios.patch(`/api/users/${username}`, patch).then((r) => r.data),
    deleteUser: (username) => axios.delete(`/api/users/${username}`).then((r) => r.data),

    // Alarm notifications (webhook/email). Channels are admin-only on the backend.
    notifications: (limit) => axios.get('/api/notifications', { params: { limit } }).then((r) => r.data),
    notifyChannels: () => axios.get('/api/notifications/channels').then((r) => r.data),
    addNotifyChannel: (body) => axios.post('/api/notifications/channels', body).then((r) => r.data),
    updateNotifyChannel: (id, patch) => axios.patch(`/api/notifications/channels/${id}`, patch).then((r) => r.data),
    deleteNotifyChannel: (id) => axios.delete(`/api/notifications/channels/${id}`).then((r) => r.data),
    testNotifyChannel: (id) => axios.post(`/api/notifications/channels/${id}/test`).then((r) => r.data),
};
