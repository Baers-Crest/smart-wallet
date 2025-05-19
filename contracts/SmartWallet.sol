// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

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

    event UserOperationValidated(address indexed sender, uint256 nonce);
    event FundsTransferred(address indexed to, uint256 amount);

    address public trustedEntryPoint;
    uint256 public nonce;

    function initialize(
        address _entryPoint,
        address _owner
    ) public initializer {
        require(_entryPoint != address(0), "Invalid entry point");
        require(_owner != address(0), "Invalid owner");
        trustedEntryPoint = _entryPoint;
        __Ownable_init();
        __UUPSUpgradeable_init();
        _transferOwnership(_owner);
    }

    function validateUserOp(
        PackedUserOperation calldata userOp,
        bytes32 userOpHash,
        uint256 missingAccountFunds
    ) external override returns (uint256) {
        require(msg.sender == trustedEntryPoint, "Invalid point");
        require(
            userOpHash.toEthSignedMessageHash().recover(userOp.signature) ==
                owner(),
            "Invalid signature"
        );
        if (userOp.nonce != nonce) revert("Invalid nonce");
        nonce++;
        emit UserOperationValidated(msg.sender, nonce);

        if (missingAccountFunds > 0) {
            (bool sent, ) = payable(msg.sender).call{
                value: missingAccountFunds
            }("");
            require(sent, "Funding failed");
            emit FundsTransferred(msg.sender, missingAccountFunds);
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
