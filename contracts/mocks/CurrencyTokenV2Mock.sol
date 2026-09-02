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
    /// @custom:storage-location erc7201:storage.CurrencyTokenV2Mock
    struct V2Storage {
        string tag;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("storage.CurrencyTokenV2Mock")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant V2_STORAGE =
        0x38f903c2d18bfb3612a3d850e223fe1378ec9dd00b8f9cf44f5495fa16050300;

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
