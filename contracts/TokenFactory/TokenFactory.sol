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
///      - `TokenDeployed` indexes the token and owner addresses
contract TokenFactory is
    Initializable,
    AccessControlUpgradeable,
    PausableUpgradeable
{
    /// ********************************** Constants ****************************************

    /// @notice Role permitted to call {deployToken}.
    bytes32 public constant DEPLOYER_ROLE = keccak256("DEPLOYER_ROLE");
    /// @notice Role permitted to call {pause} and {unpause}.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// ********************************** States ****************************************

    /// @notice Deployed token proxy for a given symbol, or the zero address if
    ///         no token has been registered under that symbol.
    /// @dev Mapping from token Symbol to token address. Slot 0 — do not reorder.
    mapping(string => address) public tokens;

    /// @notice Implementation that {deployToken} points new token proxies at.
    /// @dev Changing this does not affect already-deployed tokens.
    address public tokenImplementation;

    /// ********************************** Errors ****************************************

    /// @notice A token is already registered under `symbol`.
    error TokenAlreadyDeployed(string symbol);
    /// @notice An address argument was given as the zero address.
    error ZeroAddress();
    /// @notice A required string argument was empty.
    error EmptyString();
    /// @notice `target` has no deployed code, so it cannot be an implementation.
    error NotAContract(address target);

    /// ********************************** Events ****************************************

    /// @notice Emitted once per token, when {deployToken} registers it.
    /// @param token Address of the newly deployed token proxy.
    /// @param owner Account granted ownership of the new token.
    /// @param name ERC-20 name of the new token.
    /// @param symbol ERC-20 symbol the token is registered under.
    event TokenDeployed(
        address indexed token,
        address indexed owner,
        string name,
        string symbol
    );

    /// @notice Emitted when the implementation for future deployments changes.
    /// @param previousImplementation Implementation in use before the change; the
    ///        zero address when set from {initialize}.
    /// @param newImplementation Implementation future deployments will use.
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

    /// @notice Initialize the factory proxy: assign roles and set the token
    ///         implementation new deployments will use.
    /// @param defaultAdmin Account granted `DEFAULT_ADMIN_ROLE` and `PAUSER_ROLE`.
    /// @param tokenDeployer Account granted `DEPLOYER_ROLE`.
    /// @param currencyTokenImplementation {CurrencyToken} implementation that
    ///        newly deployed token proxies are pointed at. Must be a contract.
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
    /// @param name ERC-20 name for the new token.
    /// @param symbol ERC-20 symbol for the new token. Must not already be
    ///        registered; symbols are permanent once used.
    /// @param owner Account given ownership of the new token, and with it the
    ///        `mint`/`burn`/`pause` and upgrade rights over that token alone.
    /// @param decimals Number of decimals the new token reports.
    /// @param initialSupply Amount minted to `owner` at deployment; may be zero.
    /// @return token Address of the newly deployed token proxy.
    function deployToken(
        string calldata name,
        string calldata symbol,
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
    /// @param currencyTokenImplementation New {CurrencyToken} implementation.
    ///        Must be a contract.
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

    /// @notice Implementation version of this factory.
    /// @return Version identifier of this implementation.
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
