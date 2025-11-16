// On-chain configuration. Reads from:
// - /deployments/testnet.json if ?testnet=1 or hostname contains 'testnet'
// - /deployments/prod.json if production mode
// - /deployments/local.json if localhost
let GAME_ENTRY_ADDRESS = '0x50aF74673Be378f7c5876a28C420F5cf746e1B8a';
let VAULT_ADDRESS = '0x44e8a50FbfcaEadDBe0B6952dcC00eDB90F1f94F';
let PRIZE_DISTRIBUTOR_ADDRESS = '0xB802b0b296D8D26Bf431E861E4a6F4a17Ac9c52D';
let WBSTR_TOKEN_ADDRESS = '0xce66c55a5a3d6a7c0665f4c31a81ba51b24b4143'; // default testnet token; can be overridden by deployments file
try {
	// Switch deployments source based on mode (local vs prod)
	const { getDeploymentsPath } = await import('./env.js');
	const d = await (await fetch(getDeploymentsPath(), { cache: 'no-store' })).json();
	GAME_ENTRY_ADDRESS = d.gameEntry || GAME_ENTRY_ADDRESS;
	VAULT_ADDRESS = d.gameVault || VAULT_ADDRESS;
	PRIZE_DISTRIBUTOR_ADDRESS = d.prizeDistributor || PRIZE_DISTRIBUTOR_ADDRESS;
	WBSTR_TOKEN_ADDRESS = d.wbstrToken || WBSTR_TOKEN_ADDRESS;
} catch (error) {
	console.error('CRITICAL: Failed to load on-chain deployments. Using default addresses, which may cause the app to fail. Please check the deployment JSON file.', error);
}
export { GAME_ENTRY_ADDRESS, VAULT_ADDRESS, PRIZE_DISTRIBUTOR_ADDRESS, WBSTR_TOKEN_ADDRESS };

// Zero address helper
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Minimal ABI fragments for core contracts (keep in sync with deployed versions)
export const GAME_ENTRY_ABI = [
	'function buyInLYX(uint256 tableId) payable',
	'function buyInLSP7(address token, uint256 tableId, uint256 amount) external'
];

export const GAME_VAULT_ABI = [
	'function smallestUnitsPerChip(address token) view returns (uint256)',
	'function isTokenAllowed(address token) view returns (bool)',
	'function balanceOf(uint256 tableId, address player, address token) view returns (uint256)',
	'function withdraw(uint256 tableId, address token, uint256 amount) external',
	'function withdrawInChips(uint256 tableId, address token, uint256 chips) external'
];

export const PRIZE_DISTRIBUTOR_ABI = [
	'function authorizedPayouts(address token, address player) view returns (uint256)',
	'function claimPrize(address token) external',
	'function claimMultiple(address[] calldata tokens) external'
];

export const LSP7_MIN_ABI = [
	'function authorizeOperator(address operator, uint256 amount) external',
	'function authorizeOperator(address operator, uint256 amount, bytes data) external',
	'function authorizedAmountFor(address operator, address tokenOwner) view returns (uint256)',
	'function isOperatorFor(address operator, address tokenOwner) view returns (bool)',
	'function balanceOf(address tokenOwner) view returns (uint256)',
	'function decimals() view returns (uint8)'
];
