// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ILSP7DigitalAsset {
    function authorizeOperator(address operator, uint256 amount, bytes calldata operatorNotificationData) external;
    function transfer(address from, address to, uint256 amount, bool force, bytes calldata data) external;
    function balanceOf(address owner) external view returns (uint256);
    function authorizedAmountFor(address operator, address tokenOwner) external view returns (uint256);
}
