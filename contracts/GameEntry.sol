// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "./interfaces/ILSP7DigitalAsset.sol";

/**
 * @title IGameVault
 * @notice Vmesnik za interakcijo z obstoječo GameVaultV5 pogodbo.
 * @dev Vsebuje samo funkcije, ki jih potrebujemo za vplačila v imenu igralcev.
 */
interface IGameVault {
    function depositLyxFor(uint256 tableId, address player) external payable;
    function depositLsp7For(address token, uint256 tableId, address player, uint256 amount) external;
}

// Dodaten vmesnik za preverjanje, ali je žeton dovoljen
interface IGameVaultView {
    function isTokenAllowed(address token) external view returns (bool);
}

/**
 * @title GameEntry
 * @notice Uporabniku prijazna vstopna točka za plačila v poker igri.
 * @dev Ta pogodba deluje kot posrednik (proxy/facade) med igralcem in kompleksnim
 * sistemom GameVault. Igralci odobrijo tej pogodbi porabo žetonov,
 * ta pogodba pa nato kot "Trusted Depositor" položi sredstva v GameVault.
 */
contract GameEntry is Ownable, ReentrancyGuard {

    // Naslov obstoječe GameVaultV5 pogodbe
     IGameVault public gameVault;

    // Dogodki za lažje sledenje na verigi blokov
     event GameVaultAddressSet(address indexed oldVaultAddress, address indexed newVaultAddress);
     event BuyInPaid(uint256 indexed tableId, address indexed player, address indexed token, uint256 amount);

    /**
     * @dev Ob deployu pogodbe nastavimo lastnika in naslov obstoječega GameVault-a.
     * @param initialOwner Naslov, ki bo lastnik te pogodbe.
     * @param _gameVaultAddress Naslov že deployane GameVaultV5 pogodbe.
     */
    constructor(address initialOwner, address _gameVaultAddress) Ownable(initialOwner) {
        require(_gameVaultAddress != address(0), "GameEntry: Vault address cannot be zero");
        gameVault = IGameVault(_gameVaultAddress);
    }

    /**
     * @notice Spremeni naslov GameVault pogodbe (samo lastnik).
     * @param _newVaultAddress Nov naslov GameVaultV5 pogodbe.
     */
    function setGameVault(address _newVaultAddress) external onlyOwner {
        require(_newVaultAddress != address(0), "GameEntry: New vault address cannot be zero");
        emit GameVaultAddressSet(address(gameVault), _newVaultAddress);
        gameVault = IGameVault(_newVaultAddress);
    }

    /**
     * @notice Funkcija za plačilo vstopnine (buy-in) z LYX (nativno valuto).
     * @param tableId Identifikator mize, za katero se plačuje.
     */
    function buyInLYX(uint256 tableId) external payable nonReentrant {
        require(msg.value > 0, "GameEntry: Must send LYX to pay buy-in");
        
        // Preprosto posredujemo prejeti LYX in podatke na GameVault.
        // GameVault bo zabeležil vplačilo za igralca (msg.sender).
        gameVault.depositLyxFor{value: msg.value}(tableId, msg.sender);
        
        emit BuyInPaid(tableId, msg.sender, address(0), msg.value);
    }

    /**
     * @notice Funkcija za plačilo vstopnine (buy-in) z LSP7 žetoni (npr. WBSTR).
     * @param token Naslov LSP7 žetona, s katerim se plačuje.
     * @param tableId Identifikator mize, za katero se plačuje.
     * @param amount Znesek v najmanjših enotah žetona.
     */
    function buyInLSP7(address token, uint256 tableId, uint256 amount) external nonReentrant {
        require(amount > 0, "GameEntry: Amount must be greater than zero");

        // Varnost: preveri, ali je žeton dovoljen na GameVault-u, preden karkoli prenesemo
        bool allowed = IGameVaultView(address(gameVault)).isTokenAllowed(token);
        require(allowed, "GameEntry: Token not allowed on vault");

        // 1. KORAK: Prevzem žetonov od igralca.
        // Igralec (msg.sender) mora predhodno odobriti TEJ (GameEntry) pogodbi,
        // da lahko porabi njegove žetone.
        // To je standardni "approve" postopek.
        ILSP7DigitalAsset(token).transfer(msg.sender, address(this), amount, true, abi.encodePacked("Poker Buy-In"));

    // 2. KORAK: Odobritev porabe za GameVault.
    // GameVault bo v naslednjem koraku "pull"-al žetone iz tega kontrakta,
    // zato mora biti GameVault pooblaščen kot operator za točen znesek.
    ILSP7DigitalAsset(token).authorizeOperator(address(gameVault), amount, abi.encodePacked("GameEntry: authorize vault"));
        
        // 3. KORAK: Klicanje funkcije za polog na GameVault-u.
        // Ta pogodba (kot zaupanja vreden naslov) kliče funkcijo za polog
        // v imenu igralca (msg.sender).
        gameVault.depositLsp7For(token, tableId, msg.sender, amount);

    // 4. KORAK: Po uspešnem pologu ponastavimo dovoljenje na 0 (varnostni cleanup).
    ILSP7DigitalAsset(token).authorizeOperator(address(gameVault), 0, abi.encodePacked("GameEntry: revoke vault"));

        emit BuyInPaid(tableId, msg.sender, token, amount);
    }

    /**
     * @notice Reševanje pomotoma poslanih sredstev (LYX ali LSP7 žetoni)
     * @param token naslov žetona;
     * address(0) za LYX
     * @param amount znesek za dvig
     * @param to prejemnik sredstev
     */
    function withdrawAccidentalFunds(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        require(to != address(0), "GameEntry: to cannot be zero");
        if (token == address(0)) {
            (bool ok, ) = payable(to).call{value: amount}("");
            require(ok, "GameEntry: LYX transfer failed");
        } else {
            // force=true je varno, saj je to operacija iz tega smart contracta
            ILSP7DigitalAsset(token).transfer(address(this), to, amount, true, abi.encodePacked("Rescue"));
        }
    }
}