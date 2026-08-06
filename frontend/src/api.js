import axios from 'axios';

// Keep base relative ('') so nginx proxies /api and /socket.io in production.
axios.defaults.baseURL = '';

// Without this a wedged backend leaves every page spinning forever with no error --
// on an unattended rig console that reads as "the rig is quiet", which is the one
// thing an HMI must never imply. Deliberately generous so normal calls never trip it.
// The genuinely slow endpoints (history, archive export, well report) pass their own
// longer `timeout` at the call site; see LONG_TIMEOUT_MS.
axios.defaults.timeout = 15000;

/** For endpoints that legitimately take a while: historian queries and exports. */
export const LONG_TIMEOUT_MS = 120000;

// Restore the Authorization header on hard reload (before React mounts) so the
// very first request after a refresh is authenticated.
const storedToken = localStorage.getItem('romii_token');
if (storedToken) {
    axios.defaults.headers.common['Authorization'] = 'Bearer ' + storedToken;
}

let handlingUnauthorized = false;

// Global response interceptor: on 401 clear auth and bounce to /login exactly once.
axios.interceptors.response.use(
    (response) => response,
    (error) => {
        const status = error?.response?.status;
        if (status === 401 && !handlingUnauthorized) {
            handlingUnauthorized = true;
            localStorage.removeItem('romii_token');
            localStorage.removeItem('romii_user');
            delete axios.defaults.headers.common['Authorization'];
            // Avoid redirect loops if we are already on the login screen.
            if (window.location.pathname !== '/login') {
                window.location.assign('/login');
            } else {
                handlingUnauthorized = false;
            }
        }
        return Promise.reject(error);
    }
);

export default axios;
