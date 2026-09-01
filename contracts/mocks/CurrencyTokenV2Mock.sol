// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CurrencyToken} from "../TokenFactory/CurrencyToken.sol";

/// @title CurrencyTokenV2Mock
/// @notice Test-only successor to {CurrencyToken}.
/// @dev Exists to prove that a token proxy can be upgraded by its own owner
///      without disturbing balances, allowances or permit nonces, and that a
///      V2 may add its own state without colliding with V1's ERC-7201 namespace.
///      Not for deployment.
contract CurrencyTokenV2Mock is CurrencyToken {
    /// @custom:storage-location erc7201:kumaapay.storage.CurrencyTokenV2Mock
    struct V2Storage {
        string tag;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("kumaapay.storage.CurrencyTokenV2Mock")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant V2_STORAGE =
        0xe216223014d4043181d80d81b06a285676dd052f3418a9353b7bbdf8e3e38300;

    function _v2Storage() private pure returns (V2Storage storage $) {
        assembly {
            $.slot := V2_STORAGE
        }
    }

    function initializeV2(string calldata newTag) external reinitializer(2) {
        _v2Storage().tag = newTag;
    }

    function tag() external view returns (string memory) {
        return _v2Storage().tag;
    }

    function version() external pure override returns (string memory) {
        return "v2";
    }
}
