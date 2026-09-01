// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CurrencyToken} from "./CurrencyToken.sol";

import {
    ERC1967Proxy
} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {
    Initializable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {
    AccessControlUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/// @title TokenFactory
/// @notice Deploys and registers {CurrencyToken} instances, one per symbol, each
///         behind its own ERC-1967 (UUPS) proxy.
/// @dev
///      - tokens are deployed as ERC-1967 proxies over a shared implementation
///        rather than as raw `new CurrencyToken(...)` instances, so each token can
///        be upgraded independently by its own owner;
///      - the implementation this factory points new tokens at is admin-updatable
///        via {setTokenImplementation}. Note this only affects tokens deployed
///        AFTER the change — already-deployed tokens keep their own implementation
///        until their own owner upgrades them. The factory has no authority over
///        a token once it is deployed;
///      - the factory implementation disables its own initializers in the
///        constructor, so the raw implementation cannot be initialized by anyone;
///      - deployment is pausable via `PAUSER_ROLE`;
///      - inputs are validated (no zero owner, no empty name/symbol);
///      - the unreachable `token == address(0)` check after `new` is gone — proxy
///        construction reverts on failure, it never yields the zero address;
///      - `TokenDeployed` indexes the token and owner addresses.
///
///      Storage layout appends to `TokenFactoryLegacy`'s (`tokens` stays at slot 0;
///      AccessControl and Pausable both use ERC-7201 namespaced storage), so this
///      remains a valid upgrade target for the existing transparent proxy. Such an
///      upgrade would need a reinitializer to populate `tokenImplementation`, which
///      `initialize` cannot set on an already-initialized proxy.
contract TokenFactory is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable
{
    /// ********************************** Constants ****************************************

    bytes32 public constant DEPLOYER_ROLE = keccak256("DEPLOYER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// ********************************** States ****************************************

    /// @dev Mapping from token Symbol to token address. Slot 0 — do not reorder.
    mapping(string => address) public tokens;

    /// @dev Implementation that newly deployed token proxies are pointed at.
    address public tokenImplementation;

    /// ********************************** Errors ****************************************

    error TokenAlreadyDeployed(string symbol);
    error ZeroAddress();
    error EmptyString();
    error NotAContract(address target);

    /// ********************************** Events ****************************************

    event TokenDeployed(
        address indexed token,
        address indexed owner,
        string name,
        string symbol
    );

    event TokenImplementationUpdated(
        address indexed previousImplementation,
        address indexed newImplementation
    );

    /// ********************************** Constructor ****************************************

    /// @dev Locks the implementation so it can only ever be used through a proxy.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// ********************************** Initializer ****************************************

    function initialize(
        address defaultAdmin,
        address tokenDeployer,
        address currencyTokenImplementation
    ) public initializer {
        if (defaultAdmin == address(0) || tokenDeployer == address(0)) {
            revert ZeroAddress();
        }

        __AccessControl_init();
        __Pausable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(DEPLOYER_ROLE, tokenDeployer);
        _grantRole(PAUSER_ROLE, defaultAdmin);

        _setTokenImplementation(currencyTokenImplementation);
    }

    /// ********************************** Functions ****************************************

    /// @notice Deploy a new {CurrencyToken} proxy and register it under `symbol`.
    /// @return token Address of the newly deployed token proxy.
    function deployToken(
        string memory name,
        string memory symbol,
        address owner,
        uint8 decimals,
        uint256 initialSupply
    ) external onlyRole(DEPLOYER_ROLE) whenNotPaused returns (address token) {
        if (owner == address(0)) {
            revert ZeroAddress();
        }
        if (bytes(name).length == 0 || bytes(symbol).length == 0) {
            revert EmptyString();
        }
        if (tokens[symbol] != address(0)) {
            revert TokenAlreadyDeployed(symbol);
        }

        token = address(
            new ERC1967Proxy(
                tokenImplementation,
                abi.encodeCall(
                    CurrencyToken.initialize,
                    (name, symbol, owner, decimals, initialSupply)
                )
            )
        );

        tokens[symbol] = token;

        emit TokenDeployed(token, owner, name, symbol);
    }

    /// @notice Point future token deployments at a new implementation.
    /// @dev Does not affect already-deployed tokens; each of those is upgraded by
    ///      its own owner through its own proxy.
    function setTokenImplementation(
        address currencyTokenImplementation
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTokenImplementation(currencyTokenImplementation);
    }

    /// @notice Halt new token deployments.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume new token deployments.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// ********************************** Pure ****************************************

    function version() external pure virtual returns (string memory) {
        return "v1";
    }

    /// ********************************** Internal ****************************************

    function _setTokenImplementation(
        address currencyTokenImplementation
    ) private {
        if (currencyTokenImplementation == address(0)) {
            revert ZeroAddress();
        }
        if (currencyTokenImplementation.code.length == 0) {
            revert NotAContract(currencyTokenImplementation);
        }

        emit TokenImplementationUpdated(
            tokenImplementation,
            currencyTokenImplementation
        );

        tokenImplementation = currencyTokenImplementation;
    }
}
