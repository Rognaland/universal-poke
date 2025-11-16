// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./interfaces/ILSP7DigitalAsset.sol";

// Vmesnik posodobljen, da se ujema z imenom PrizeDistributorV6
interface IPrizeDistributorV6 {
    function consumeAuthorization(address winner, address tokenAddress, uint256 amount) external returns (bool);
    function claimPrizeFor(address winner, address tokenAddress, uint256 amount) external returns (bool);
}

/**
 * @title GameVaultV6
 * @notice Escrow sef, ki sledi stanjem po mizah in sprošča sredstva
 * samo z avtorizacijo s strani PrizeDistributor-ja.
 */
contract GameVaultV6 is Ownable, ReentrancyGuard {
    address public prizeDistributor;
    mapping(address => bool) public isTokenAllowed;
    mapping(address => bool) public trustedDepositor;
    // Struktura stanj: token -> tableId -> player -> amount
    mapping(address => mapping(uint256 => mapping(address => uint256))) private balances;
    mapping(address => uint256) public smallestUnitsPerChip;
    mapping(address => uint256) public totalTokenBalances; // Za lažje reševanje "ujetih" sredstev
    // Globalni rake v basis points (npr. 300 = 3%). Nanaša se na vse depozite privzeto.
    uint16 public rakeBps;
    // Per-token rake override (če je nastavljen, prepiše globalni)
    mapping(address => uint16) public tokenRakeBps;
    mapping(address => bool) public hasTokenRakeBps;
    // Per-table per-token rake override (najvišja prioriteta)
    mapping(uint256 => mapping(address => uint16)) public tableTokenRakeBps;
    mapping(uint256 => mapping(address => bool)) public hasTableTokenRakeBps;

    // --- Dogodki ---
    event Deposited(address indexed player, address indexed token, uint256 indexed tableId, uint256 amount);
    event Withdrawn(address indexed player, address indexed token, uint256 indexed tableId, uint256 amount);
    event WithdrawnInChips(address indexed player, address indexed token, uint256 indexed tableId, uint256 chips, uint256 amount);
    event BalancesMoved(uint256 indexed tableId, address indexed token, address indexed from, address to, uint256 amount);
    event PrizeDistributorChanged(address indexed oldAddress, address indexed newAddress);
    event TokenAllowanceChanged(address indexed token, bool allowed);
    event TrustedDepositorChanged(address indexed depositor, bool isTrusted);
    event SmallestUnitsPerChipSet(address indexed token, uint256 unitsPerChip);
    event RakeBpsChanged(uint16 oldBps, uint16 newBps);
    event RakeTaken(uint256 indexed tableId, address indexed token, uint256 amount, address indexed ownerWallet);
    event TokenRakeSet(address indexed token, uint16 rakeBps);
    event TableTokenRakeSet(uint256 indexed tableId, address indexed token, uint16 rakeBps);
    event DepositedInChips(address indexed player, address indexed token, uint256 indexed tableId, uint256 chips, uint256 amount);

    modifier onlyTrusted() {
        require(trustedDepositor[msg.sender] || msg.sender == owner(), "GameVaultV6: caller is not trusted or owner");
        _;
    }

    constructor(address initialOwner, address _prizeDistributor) Ownable(initialOwner) {
        require(initialOwner != address(0), "GameVaultV6: initialOwner cannot be zero");
        require(_prizeDistributor != address(0), "GameVaultV6: prizeDistributor cannot be zero");
        prizeDistributor = _prizeDistributor;
    }

    // --- Funkcije, ki jih kliče GameEntry ---
    function depositLyxFor(uint256 tableId, address player) external payable nonReentrant onlyTrusted {
        require(msg.value > 0, "GameVaultV6: must send LYX");
        require(player != address(0), "GameVaultV6: player cannot be zero address");
        // Izračun rake
        uint256 bps = _effectiveRakeBps(tableId, address(0));
        uint256 fee = (msg.value * bps) / 10_000;
        uint256 netAmount = msg.value - fee;
        balances[address(0)][tableId][player] += netAmount;
        totalTokenBalances[address(0)] += netAmount;
        emit Deposited(player, address(0), tableId, netAmount);
        emit DepositedInChips(player, address(0), tableId, _chipsFromAmount(address(0), netAmount), netAmount);
        if (fee > 0) {
            (bool sent, ) = payable(owner()).call{value: fee}("");
            require(sent, "GameVaultV6: rake LYX transfer failed");
            emit RakeTaken(tableId, address(0), fee, owner());
        }
    }

    function depositLsp7For(address token, uint256 tableId, address player, uint256 amount) external nonReentrant onlyTrusted {
        require(isTokenAllowed[token], "GameVaultV6: token not allowed");
        require(amount > 0, "GameVaultV6: amount must be > 0");
        require(player != address(0), "GameVaultV6: player cannot be zero address");
        
        ILSP7DigitalAsset t = ILSP7DigitalAsset(token);
        // Vault potegne sredstva od klicatelja (GameEntry), ki mu mora zaupati.
        t.transfer(msg.sender, address(this), amount, true, abi.encodePacked("GameVaultV6: trusted deposit"));

        // Izračun rake
        uint256 bps = _effectiveRakeBps(tableId, token);
        uint256 fee = (amount * bps) / 10_000;
        uint256 netAmount = amount - fee;
        balances[token][tableId][player] += netAmount;
        totalTokenBalances[token] += netAmount;
        emit Deposited(player, token, tableId, netAmount);
        emit DepositedInChips(player, token, tableId, _chipsFromAmount(token, netAmount), netAmount);
        if (fee > 0) {
            bool isEOA = owner().code.length == 0;
            t.transfer(address(this), owner(), fee, isEOA, abi.encodePacked("GameVaultV6: rake"));
            emit RakeTaken(tableId, token, fee, owner());
        }
    }

    // --- Funkcije za izplačila ---
    function _withdraw(uint256 tableId, address token, uint256 amount, address recipient) internal {
        // Defense-in-depth: dovoli dvige le za prepoznane tokene.
        // Ne uporabljamo strogega isTokenAllowed, ker bi lahko zamrznili sredstva,
        // če bi bil token kasneje onemogočen. Namesto tega dovolimo LYX (address(0)),
        // trenutno dovoljene tokene ali tokene, za katere je vault že kadarkoli držal stanje.
        require(
            token == address(0) || isTokenAllowed[token] || totalTokenBalances[token] > 0,
            "GameVaultV6: token not recognized for withdrawal"
        );
        require(amount > 0, "GameVaultV6: amount must be > 0");
        uint256 bal = balances[token][tableId][recipient];
        require(bal >= amount, "GameVaultV6: insufficient balance");
        
    require(prizeDistributor != address(0), "GameVaultV6: distributor not set");
    bool ok = IPrizeDistributorV6(prizeDistributor).consumeAuthorization(recipient, token, amount);
        require(ok, "GameVaultV6: authorization not available from PrizeDistributor");

        balances[token][tableId][recipient] -= amount;
        totalTokenBalances[token] -= amount;

        if (token == address(0)) {
            (bool sent, ) = payable(recipient).call{value: amount}("");
            require(sent, "GameVaultV6: LYX transfer failed");
        } else {
            bool isEOA = recipient.code.length == 0;
            ILSP7DigitalAsset(token).transfer(address(this), recipient, amount, isEOA, abi.encodePacked("GameVaultV6: withdraw"));
        }
        emit Withdrawn(recipient, token, tableId, amount);
    }

    function withdraw(uint256 tableId, address token, uint256 amount) external nonReentrant {
        _withdraw(tableId, token, amount, msg.sender);
    }

    function withdrawInChips(uint256 tableId, address token, uint256 chips) external nonReentrant {
        require(chips > 0, "GameVaultV6: chips must be > 0");
        uint256 unitsPerChip = smallestUnitsPerChip[token];
        require(unitsPerChip > 0, "GameVaultV6: unitsPerChip not set for token");
        uint256 amount = chips * unitsPerChip;
        _withdraw(tableId, token, amount, msg.sender);
        emit WithdrawnInChips(msg.sender, token, tableId, chips, amount);
    }

    // --- Deposit helperji v chips ---
    function depositLyxInChipsFor(uint256 tableId, address player, uint256 chips) external payable nonReentrant onlyTrusted {
        require(chips > 0, "GameVaultV6: chips must be > 0");
        require(player != address(0), "GameVaultV6: player cannot be zero address");
        uint256 unitsPerChip = smallestUnitsPerChip[address(0)];
        require(unitsPerChip > 0, "GameVaultV6: LYX unitsPerChip not set");
        uint256 required = chips * unitsPerChip;
        require(msg.value == required, "GameVaultV6: sent value mismatch with chips");

        // reuse logic via local inline to avoid duplication
        uint256 bps = _effectiveRakeBps(tableId, address(0));
        uint256 fee = (required * bps) / 10_000;
        uint256 netAmount = required - fee;
        balances[address(0)][tableId][player] += netAmount;
        totalTokenBalances[address(0)] += netAmount;
        emit Deposited(player, address(0), tableId, netAmount);
        emit DepositedInChips(player, address(0), tableId, chips, netAmount);
        if (fee > 0) {
            (bool sent, ) = payable(owner()).call{value: fee}("");
            require(sent, "GameVaultV6: rake LYX transfer failed");
            emit RakeTaken(tableId, address(0), fee, owner());
        }
    }

    function depositLsp7InChipsFor(address token, uint256 tableId, address player, uint256 chips) external nonReentrant onlyTrusted {
        require(isTokenAllowed[token], "GameVaultV6: token not allowed");
        require(chips > 0, "GameVaultV6: chips must be > 0");
        require(player != address(0), "GameVaultV6: player cannot be zero address");
        uint256 unitsPerChip = smallestUnitsPerChip[token];
        require(unitsPerChip > 0, "GameVaultV6: unitsPerChip not set for token");
        uint256 amount = chips * unitsPerChip;

        ILSP7DigitalAsset t = ILSP7DigitalAsset(token);
        t.transfer(msg.sender, address(this), amount, true, abi.encodePacked("GameVaultV6: trusted deposit (chips)"));

        uint256 bps = _effectiveRakeBps(tableId, token);
        uint256 fee = (amount * bps) / 10_000;
        uint256 netAmount = amount - fee;
        balances[token][tableId][player] += netAmount;
        totalTokenBalances[token] += netAmount;
        emit Deposited(player, token, tableId, netAmount);
        emit DepositedInChips(player, token, tableId, chips, netAmount);
        if (fee > 0) {
            bool isEOA = owner().code.length == 0;
            t.transfer(address(this), owner(), fee, isEOA, abi.encodePacked("GameVaultV6: rake"));
            emit RakeTaken(tableId, token, fee, owner());
        }
    }
    
    function withdrawFor(uint256 tableId, address player, address token, uint256 amount) external nonReentrant onlyTrusted {
         _withdraw(tableId, token, amount, player);
    }

    // --- Funkcije za poravnavo (settlement), ki jih kliče Backend ---
    function moveBalance(uint256 tableId, address token, address from, address to, uint256 amount) public nonReentrant onlyTrusted {
        require(to != address(0) && from != address(0), "GameVaultV6: zero address");
        require(amount > 0, "GameVaultV6: amount must be > 0");
        uint256 bal = balances[token][tableId][from];
        require(bal >= amount, "GameVaultV6: insufficient 'from' balance");
        
        unchecked {
            balances[token][tableId][from] = bal - amount;
            balances[token][tableId][to] += amount;
        }
        emit BalancesMoved(tableId, token, from, to, amount);
    }
    
    function moveBalancesBatch(uint256 tableId, address token, address[] calldata froms, address[] calldata tos, uint256[] calldata amounts) external nonReentrant onlyTrusted {
        require(froms.length == tos.length && tos.length == amounts.length, "GameVaultV6: array length mismatch");
        for (uint256 i = 0; i < froms.length; i++) {
            moveBalance(tableId, token, froms[i], tos[i], amounts[i]);
        }
    }

    // --- Administratorske in pomožne funkcije ---
    function setPrizeDistributor(address _new) external onlyOwner {
        require(_new != address(0), "GameVaultV6: distributor cannot be zero");
        emit PrizeDistributorChanged(prizeDistributor, _new);
        prizeDistributor = _new;
    }

    function setTokenAllowed(address token, bool allowed) external onlyOwner {
        isTokenAllowed[token] = allowed;
        emit TokenAllowanceChanged(token, allowed);
    }
    
    function setTrustedDepositor(address depositor, bool isTrusted) external onlyOwner {
        require(depositor != address(0), "GameVaultV6: depositor cannot be zero");
        trustedDepositor[depositor] = isTrusted;
        emit TrustedDepositorChanged(depositor, isTrusted);
    }

    function setSmallestUnitsPerChip(address token, uint256 unitsPerChip) external onlyOwner {
        require(unitsPerChip > 0, "GameVaultV6: unitsPerChip must be > 0");
        smallestUnitsPerChip[token] = unitsPerChip;
        emit SmallestUnitsPerChipSet(token, unitsPerChip);
    }

    function setRakeBps(uint16 _rakeBps) external onlyOwner {
        require(_rakeBps <= 10_000, "GameVaultV6: rakeBps > 10000");
        uint16 old = rakeBps;
        rakeBps = _rakeBps;
        emit RakeBpsChanged(old, _rakeBps);
    }

    function setTokenRakeBps(address token, uint16 _rakeBps) external onlyOwner {
        require(_rakeBps <= 10_000, "GameVaultV6: rakeBps > 10000");
        tokenRakeBps[token] = _rakeBps;
        hasTokenRakeBps[token] = true;
        emit TokenRakeSet(token, _rakeBps);
    }

    function setTableTokenRakeBps(uint256 tableId, address token, uint16 _rakeBps) external onlyOwner {
        require(_rakeBps <= 10_000, "GameVaultV6: rakeBps > 10000");
        tableTokenRakeBps[tableId][token] = _rakeBps;
        hasTableTokenRakeBps[tableId][token] = true;
        emit TableTokenRakeSet(tableId, token, _rakeBps);
    }

    // --- Internal helpers ---
    function _effectiveRakeBps(uint256 tableId, address token) internal view returns (uint16) {
        if (hasTableTokenRakeBps[tableId][token]) {
            return tableTokenRakeBps[tableId][token];
        }
        if (hasTokenRakeBps[token]) {
            return tokenRakeBps[token];
        }
        return rakeBps;
    }

    function _chipsFromAmount(address token, uint256 amount) internal view returns (uint256) {
        uint256 unitsPerChip = smallestUnitsPerChip[token];
        if (unitsPerChip == 0) return 0;
        return amount / unitsPerChip;
    }

    function balanceOf(uint256 tableId, address player, address token) external view returns (uint256) {
        return balances[token][tableId][player];
    }
    
    function balanceOf(uint256 tableId, address player) external view returns (uint256) {
        return balances[address(0)][tableId][player];
    }
    
    receive() external payable {}
}