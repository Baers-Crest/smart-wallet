// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import "./SmartWalletProxy.sol";

contract SmartWalletFactory {
    address public immutable implementation;

    event WalletCreated(address indexed wallet, address indexed owner);

    constructor(address _implementation) {
        implementation = _implementation;
    }

    function createWallet(
        address owner,
        address entryPoint,
        uint256 salt
    ) external returns (address wallet) {
        bytes memory initData = abi.encodeWithSignature(
            "initialize(address,address)",
            entryPoint,
            owner
        );
        bytes32 finalSalt = keccak256(
            abi.encodePacked(owner, salt, msg.sender)
        );
        wallet = address(
            new SmartWalletProxy{salt: finalSalt}(implementation, initData)
        );
        emit WalletCreated(wallet, owner);
    }

    function computeWalletAddress(
        address owner,
        address entryPoint,
        uint256 salt
    ) external view returns (address predicted) {
        bytes memory initData = abi.encodeWithSignature(
            "initialize(address,address)",
            entryPoint,
            owner
        );
        bytes memory creationCode = abi.encodePacked(
            type(SmartWalletProxy).creationCode,
            abi.encode(implementation, initData)
        );
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                keccak256(abi.encodePacked(owner, salt, msg.sender)),
                keccak256(creationCode)
            )
        );
        predicted = address(uint160(uint256(hash)));
    }
}
