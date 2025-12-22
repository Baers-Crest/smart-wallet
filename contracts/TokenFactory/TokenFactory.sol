// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "./CurrencyToken.sol";

import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

contract TokenFactory is Initializable, AccessControlUpgradeable {
    /// ********************************** Constants ****************************************

    bytes32 public constant DEPLOYER_ROLE = keccak256("DEPLOYER_ROLE");

    /// ********************************** States ****************************************

    /// @dev Mapping from token Symbol to token address
    mapping(string => address) public tokens;

    /// ********************************** Errors ****************************************
    error TokenAlreadyDeployed(string symbol);
    /// ********************************** Events ****************************************
    event TokenDeployed(address token, string name);

    /// ********************************** Initializer ****************************************
    function initialize(
        address defaultAdmin,
        address tokenDeployer
    ) public initializer {
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(DEPLOYER_ROLE, tokenDeployer);
    }

    /// ********************************** Functions ****************************************

    function deployToken(
        string memory name,
        string memory symbol,
        address owner,
        uint8 decimals,
        uint256 initialSupply
    ) external onlyRole(DEPLOYER_ROLE) returns (address token) {
        if (tokens[symbol] != address(0)) {
            revert TokenAlreadyDeployed(symbol);
        }

        token = address(
            new CurrencyToken(name, symbol, owner, decimals, initialSupply)
        );

        if (token == address(0)) {
            revert();
        }

        tokens[symbol] = token;

        emit TokenDeployed(token, name);
    }
}
