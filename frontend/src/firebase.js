// Firebase initialization and exports
import { initializeApp } from 'firebase/app';
import { initializeFirestore, connectFirestoreEmulator, setLogLevel } from 'firebase/firestore';
import { isProdMode } from './env.js';
import { getAnalytics, isSupported as analyticsIsSupported } from 'firebase/analytics';

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: 'AIzaSyDLWDOCsIY3YE8zr3oxEkyZOy6eFMEMS3Q',
  authDomain: 'poker-4683e.firebaseapp.com',
  projectId: 'poker-4683e',
  storageBucket: 'poker-4683e.firebasestorage.app',
  messagingSenderId: '515393166903',
  appId: '1:515393166903:web:444c8a442b31476f6ee9b2',
  measurementId: 'G-0KV6LFGZ8M'
};

// Initialize Firebase
export const app = initializeApp(firebaseConfig);
const firestoreSettings = {
  experimentalAutoDetectLongPolling: true,
  experimentalForceLongPolling: false,
  useFetchStreams: false,
};

export const db = initializeFirestore(app, firestoreSettings);

// Expose config for other modules to detect projectId/emulator context
try { if (typeof window !== 'undefined') window.firebaseConfig = firebaseConfig; } catch (e) {}

// If running on localhost, connect to the local Firestore emulator to avoid
// contacting the production Firestore API. This makes local E2E and emulator
// setups reliable without changing build-time config.
try {
  if (typeof window !== 'undefined' && window.location) {
    const { hostname: host, protocol } = window.location;
    // Broad local-dev detection: file protocol, empty hostname (file://),
    // localhost variants, 0.0.0.0, common LAN ranges (192.168.x.x, 10.x.x.x, 172.16-31.x.x), and .local
    const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '';
    const isFileProtocol = protocol === 'file:' || host === '';
    const isLan = /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(host);
    const isLocalTld = host.endsWith('.local');
  if (!isProdMode() && (isFileProtocol || isLocalHost || isLan || isLocalTld)) {
      // default emulator host/port used by our docker emulator setup
      connectFirestoreEmulator(db, '127.0.0.1', 8080);
      // Enable verbose Firestore SDK logs locally to help diagnose realtime/write stream issues
      try { setLogLevel('debug'); } catch (e) {}
  console.info('[firebase] connected to Firestore emulator at 127.0.0.1:8080 (debug logging enabled)');
  // Expose for UI debug overlay
  try { window.__firebase_emulator_host_for_debugging__ = '127.0.0.1:8080'; } catch (e) {}
    }
  }
} catch (e) {
  // Avoid breaking the app if emulator connect fails
  console.warn('[firebase] failed to connect to Firestore emulator (continuing with production):', e);
}

// Patch a global hook to capture last Firestore write/network errors (SDK logs will also appear)
try {
  // SDK doesn't expose a simple centralized error hook; applications can set window event on failures
  window.addEventListener('unhandledrejection', (ev) => {
    try { window.__dev_debug && window.__dev_debug.setDebugLast && window.__dev_debug.setDebugLast(String(ev.reason || ev)); } catch (e) {}
  });
  window.addEventListener('error', (ev) => {
    try { window.__dev_debug && window.__dev_debug.setDebugLast && window.__dev_debug.setDebugLast(String(ev.error || ev.message || ev)); } catch (e) {}
  });
} catch (e) {}

// Analytics is optional and only works on supported envs (https/localhost)
export let analytics = null;
try {
  const setupAnalytics = async () => {
    if (await analyticsIsSupported()) {
      analytics = getAnalytics(app);
    }
  };
  setupAnalytics();
} catch (_) {
  // ignore analytics errors in unsupported environments
}

export default app;
