// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

import "./interfaces/ILSP7DigitalAsset.sol";

/**
 * @title PrizeDistributorV6
 * @notice Securely manages prize payouts to winners based on authorizations issued by a trusted game server.
 */
contract PrizeDistributorV6 is Ownable, ReentrancyGuard {
    address public gameServerAddress;
    mapping(address => mapping(address => uint256)) public authorizedPayouts;
    mapping(address => bool) public isAuthorizedVault;

    event PayoutAuthorized(address indexed winner, address indexed token, uint256 amount);
    event PrizeClaimed(address indexed winner, address indexed token, uint256 amount);
    event PrizeClaimedFor(address indexed winner, address indexed token, uint256 amount, address indexed byVault);
    event AuthorizationConsumed(address indexed winner, address indexed token, uint256 amount, address indexed vault);
    event GameServerChanged(address indexed oldServer, address indexed newServer);
    event AuthorizedVaultChanged(address indexed vault, bool allowed);

    modifier onlyGameServer() {
        require(msg.sender == gameServerAddress, "PrizeDistributorV6: Caller is not the authorized game server");
        _;
    }

    constructor(address initialOwner, address _gameServerAddress) Ownable(initialOwner) {
        require(initialOwner != address(0), "PrizeDistributorV6: Initial owner cannot be zero");
        require(_gameServerAddress != address(0), "PrizeDistributorV6: Game server address cannot be zero");

        gameServerAddress = _gameServerAddress;
    }

    function authorizePayout(address winner, address tokenAddress, uint256 amount) external onlyGameServer {
        require(winner != address(0), "PrizeDistributorV6: Winner address cannot be zero");
        require(amount > 0, "PrizeDistributorV6: Payout amount must be positive");
        authorizedPayouts[tokenAddress][winner] += amount;
        emit PayoutAuthorized(winner, tokenAddress, amount);
    }

    function consumeAuthorization(address winner, address tokenAddress, uint256 amount) external returns (bool) {
        require(isAuthorizedVault[msg.sender], "PrizeDistributorV6: caller is not an authorized vault");
        require(winner != address(0), "PrizeDistributorV6: winner cannot be zero");
        require(amount > 0, "PrizeDistributorV6: amount must be > 0");
        uint256 auth = authorizedPayouts[tokenAddress][winner];
        require(auth >= amount, "PrizeDistributorV6: insufficient authorization");
        unchecked {
            authorizedPayouts[tokenAddress][winner] = auth - amount;
        }
        emit AuthorizationConsumed(winner, tokenAddress, amount, msg.sender);
        return true;
    }

    function claimPrize(address tokenAddress) external nonReentrant {
        uint256 amountToClaim = authorizedPayouts[tokenAddress][msg.sender];
        require(amountToClaim > 0, "PrizeDistributorV6: No prize to claim for this user and token");
        authorizedPayouts[tokenAddress][msg.sender] = 0;
        if (tokenAddress == address(0)) {
            (bool success, ) = payable(msg.sender).call{value: amountToClaim}("");
            require(success, "PrizeDistributorV6: LYX transfer failed");
        } else {
            ILSP7DigitalAsset token = ILSP7DigitalAsset(tokenAddress);
            bool isEOA = msg.sender.code.length == 0;
            token.transfer(address(this), msg.sender, amountToClaim, isEOA, abi.encodePacked("PrizeDistributorV6: Payout"));
        }

        emit PrizeClaimed(msg.sender, tokenAddress, amountToClaim);
    }

    /**
     * @notice Authorized vault can transfer prizes from this contract directly to the winner in one tx.
     * Uses and reduces the existing authorization for the winner.
     */
    function claimPrizeFor(address winner, address tokenAddress, uint256 amount) external nonReentrant returns (bool) {
        require(isAuthorizedVault[msg.sender], "PrizeDistributorV6: caller is not an authorized vault");
        require(winner != address(0), "PrizeDistributorV6: winner cannot be zero");
        require(amount > 0, "PrizeDistributorV6: amount must be > 0");
        uint256 auth = authorizedPayouts[tokenAddress][winner];
        require(auth >= amount, "PrizeDistributorV6: insufficient authorization");
        unchecked {
            authorizedPayouts[tokenAddress][winner] = auth - amount;
        }

        if (tokenAddress == address(0)) {
            (bool success, ) = payable(winner).call{value: amount}("");
            require(success, "PrizeDistributorV6: LYX transfer failed");
        } else {
            ILSP7DigitalAsset token = ILSP7DigitalAsset(tokenAddress);
            bool isEOA = winner.code.length == 0;
            token.transfer(address(this), winner, amount, isEOA, abi.encodePacked("PrizeDistributorV6: PayoutFor"));
        }

        emit PrizeClaimedFor(winner, tokenAddress, amount, msg.sender);
        return true;
    }

    function setGameServer(address _newServerAddress) external onlyOwner {
        require(_newServerAddress != address(0), "PrizeDistributorV6: New server address cannot be zero");
        emit GameServerChanged(gameServerAddress, _newServerAddress);
        gameServerAddress = _newServerAddress;
    }

    function setAuthorizedVault(address vault, bool allowed) external onlyOwner {
        require(vault != address(0), "PrizeDistributorV6: vault cannot be zero");
        isAuthorizedVault[vault] = allowed;
        emit AuthorizedVaultChanged(vault, allowed);
    }

    function withdrawStuckFunds(address tokenAddress) external onlyOwner nonReentrant {
        if (tokenAddress == address(0)) {
            uint256 balance = address(this).balance;
            require(balance > 0, "PrizeDistributorV6: No LYX to withdraw");
            (bool success, ) = payable(owner()).call{value: balance}("");
            require(success, "PrizeDistributorV6: Stuck LYX transfer failed");
        } else {
            ILSP7DigitalAsset token = ILSP7DigitalAsset(tokenAddress);
            uint256 balance = token.balanceOf(address(this));
            require(balance > 0, "PrizeDistributorV6: No tokens to withdraw");
            bool isEOA = owner().code.length == 0;
            token.transfer(address(this), owner(), balance, isEOA, abi.encodePacked("PrizeDistributorV6: Stuck funds withdrawal"));
        }
    }

    function claimMultiple(address[] calldata tokenAddresses) external nonReentrant {
        for (uint256 i = 0; i < tokenAddresses.length; i++) {
            address tokenAddress = tokenAddresses[i];
            uint256 amountToClaim = authorizedPayouts[tokenAddress][msg.sender];
            if (amountToClaim == 0) continue;

            authorizedPayouts[tokenAddress][msg.sender] = 0;
            if (tokenAddress == address(0)) {
                (bool success, ) = payable(msg.sender).call{value: amountToClaim}("");
                require(success, "PrizeDistributorV6: LYX transfer failed");
            } else {
                ILSP7DigitalAsset token = ILSP7DigitalAsset(tokenAddress);
                bool isEOA = msg.sender.code.length == 0;
                token.transfer(address(this), msg.sender, amountToClaim, isEOA, abi.encodePacked("PrizeDistributorV6: Payout"));
            }

            emit PrizeClaimed(msg.sender, tokenAddress, amountToClaim);
        }
    }

    receive() external payable {}
}
