export function isProdMode() {
  try {
    const { hostname, protocol, search } = window.location;
    const params = new URLSearchParams(search || '');
    if (params.get('prod') === '1') return true;
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.endsWith('.local');
    const isFileProtocol = protocol === 'file:';
    return !(isLocalHost || isFileProtocol);
  } catch (_) {
    return false;
  }
}

export function getFunctionsBase() {
  const projectId = (window.firebaseConfig && window.firebaseConfig.projectId) || 'poker-4683e';
  if (isProdMode()) return `https://us-central1-${projectId}.cloudfunctions.net`;
  return `http://127.0.0.1:5001/${projectId}/us-central1`;
}

export function getDeploymentsPath() {
  try {
    const { hostname, search } = window.location;
    const params = new URLSearchParams(search || '');
    
    // LOCALHOST always uses testnet for development/testing
    const isLocalHost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname.endsWith('.local');
    if (isLocalHost) {
      return '/deployments/testnet.json';
    }
    
    // Check if testnet mode (query param or hostname)
    if (params.get('testnet') === '1' || hostname.includes('testnet') || hostname.includes('testpoker12') || hostname.includes('testpoker13') || hostname.includes('universalpoker')) {
      return '/deployments/testnet.json';
    }
    
    return isProdMode() ? '/deployments/prod.json' : '/deployments/local.json';
  } catch (_) {
    return isProdMode() ? '/deployments/prod.json' : '/deployments/local.json';
  }
}
