// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@account-abstraction/contracts/interfaces/IAccount.sol";
import "@account-abstraction/contracts/core/UserOperationLib.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract SmartWallet is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    IAccount
{
    using ECDSA for bytes32;

    address public trustedEntryPoint;
    uint256 public nonce;

    function initialize(
        address _entryPoint,
        address _owner
    ) public initializer {
        trustedEntryPoint = _entryPoint;
        __Ownable_init();
        _transferOwnership(_owner);
    }

    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external override returns (uint256) {
        require(
            userOpHash.toEthSignedMessageHash().recover(userOp.signature) ==
                owner(),
            "Invalid signature"
        );
        if (userOp.nonce != nonce) revert("Invalid nonce");
        nonce++;

        if (missingAccountFunds > 0) {
            (bool sent, ) = payable(msg.sender).call{
                value: missingAccountFunds
            }("");
            require(sent, "Funding failed");
        }

        return 0;
    }

    function execute(address to, uint256 value, bytes calldata data) external {
        require(msg.sender == trustedEntryPoint, "Not entry point");
        (bool success, ) = to.call{value: value}(data);
        require(success, "Call failed");
    }

    function executeBatch(
        address[] calldata dests,
        uint256[] calldata values,
        bytes[] calldata data
    ) external {
        require(msg.sender == trustedEntryPoint, "Not entry point");
        require(
            dests.length == values.length && values.length == data.length,
            "Mismatched inputs"
        );
        for (uint256 i = 0; i < dests.length; i++) {
            (bool success, ) = dests[i].call{value: values[i]}(data[i]);
            require(success, "Batch call failed");
        }
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    receive() external payable {}
}
