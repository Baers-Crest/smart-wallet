// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./SmartWallet.sol";

contract SmartWalletFactoryV1 {
    event WalletDeployed(address indexed owner, address wallet, bytes32 salt);

    mapping(bytes32 => address) public deployedWallets;

    function createWallet(bytes32 salt) external returns (address wallet) {
        require(deployedWallets[salt] == address(0), "Wallet already deployed");

        wallet = address(new SmartWalletV1{salt: salt}());

        SmartWalletV1(payable(wallet)).transferOwnership(msg.sender);

        deployedWallets[salt] = wallet;

        emit WalletDeployed(msg.sender, wallet, salt);
    }

    function computeWallet(
        bytes32 salt
    ) public view returns (address predicted) {
        bytes memory bytecode = type(SmartWalletV1).creationCode;

        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                salt,
                keccak256(bytecode)
            )
        );

        predicted = address(uint160(uint(hash)));
    }

    function getWalletsBySalts(
        bytes32[] calldata salts
    ) external view returns (address[] memory addresses) {
        addresses = new address[](salts.length);
        for (uint i = 0; i < salts.length; i++) {
            addresses[i] = deployedWallets[salts[i]];
        }
    }
}
