import { io } from 'socket.io-client';

// ONE shared socket instance for the whole app.
// - autoConnect:false so the connection is owned by Layout (after auth), not by import side-effects.
// - auth is a callback so the LATEST token is read on every (re)connect.
export const socket = io('/', {
    autoConnect: false,
    auth: (cb) => cb({ token: localStorage.getItem('romii_token') }),
    // Go straight to WebSocket. The default polling-then-upgrade handshake costs an
    // extra round trip on every reconnect, which is the common case on a rig link.
    transports: ['websocket', 'polling'],
    // Reconnect fast and keep trying: an unattended console must come back on its own
    // after a link flap, not sit disconnected until someone reloads the page.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
    timeout: 10000,
});

export function connectSocket() {
    if (!socket.connected) socket.connect();
}

export function disconnectSocket() {
    if (socket.connected) socket.disconnect();
}
