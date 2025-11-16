#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const timeoutMs = parseInt(process.env.WAIT_TIMEOUT_MS || '120000', 10);
const pollInterval = 1000;
const root = path.resolve(__dirname, '..');
const pathsToCheck = [
  path.join(root, 'deployments', 'local.json'),
  // Prefer V3 artifact; keep legacy as fallback
  path.join(root, 'artifacts', 'contracts', 'GameVaultV3.sol', 'GameVaultV3.json'),
  path.join(root, 'artifacts', 'contracts', 'GameVault.sol', 'GameVault.json'),
];

console.log('functions: waiting for deployment artifacts (timeout %dms)...', timeoutMs);

let elapsed = 0;
const timer = setInterval(() => {
  const exists = pathsToCheck.some(p => fs.existsSync(p));
  if (exists) {
    clearInterval(timer);
    console.log('functions: artifacts detected; starting functions emulator...');
    const child = spawn('firebase', ['emulators:start', '--only', 'functions'], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code));
  } else {
    elapsed += pollInterval;
    if (elapsed >= timeoutMs) {
      clearInterval(timer);
      console.warn('functions: artifacts not found after %dms; starting emulator anyway.', timeoutMs);
      const child = spawn('firebase', ['emulators:start', '--only', 'functions'], { stdio: 'inherit' });
      child.on('exit', (code) => process.exit(code));
    }
  }
}, pollInterval);
