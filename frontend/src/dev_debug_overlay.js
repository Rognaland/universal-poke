// Tiny dev overlay to show Firestore host and last write error
import { db } from './firebase.js';

function createOverlay() {
  const id = '__dev_debug_overlay__';
  if (document.getElementById(id)) return;
  const o = document.createElement('div');
  o.id = id;
  o.style.position = 'fixed';
  o.style.right = '8px';
  o.style.bottom = '8px';
  o.style.zIndex = 99999;
  o.style.background = 'rgba(0,0,0,0.6)';
  o.style.color = '#fff';
  o.style.padding = '8px 12px';
  o.style.fontSize = '12px';
  o.style.borderRadius = '6px';
  o.style.maxWidth = '320px';
  o.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
  o.innerHTML = `<div style="font-weight:600;margin-bottom:6px;">DEV DEBUG</div><div id="dev_debug_host">host: unknown</div><div id="dev_debug_last">last: none</div>`;
  document.body.appendChild(o);
}

export function setDebugHost(h) {
  try { createOverlay(); document.getElementById('dev_debug_host').textContent = 'host: ' + h; } catch (e) {}
}
export function setDebugLast(v) {
  try { createOverlay(); document.getElementById('dev_debug_last').textContent = 'last: ' + v; } catch (e) {}
}

// Hook into window to allow external updates
window.__dev_debug = { setDebugHost, setDebugLast };

export default { setDebugHost, setDebugLast };
