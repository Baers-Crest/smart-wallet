// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {
    ERC20Upgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {
    ERC20PermitUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {
    ERC20PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import {
    Ownable2StepUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {
    UUPSUpgradeable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {
    Initializable
} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/// @title CurrencyToken
/// @notice Closed-loop gateway token deployed by {TokenFactory} behind a UUPS proxy.
/// @dev
///      - each token is its own ERC-1967 proxy; upgrades are authorised per token
///        by that token's owner via {_authorizeUpgrade}. Tokens do not share an
///        upgrade authority, so one token's migration cannot touch another's;
///      - ownership transfer is two-step and renouncing is disabled, so a mistyped
///        address can never strand `mint`/`burn`/`pause`/upgrade rights;
///      - all balance movements (including `mint`/`burn`) are pausable by the owner;
///      - `TransferSuccess` indexes `keccak256(bytes(paymentReference))` instead of
///        `value`, making off-chain reconciliation a direct log lookup;
///      - the plain ERC-20 `transfer(address,uint256)` and
///        `transferFrom(address,address,uint256)` entrypoints always revert with
///        {ReferenceRequired}. Every balance movement between accounts must carry
///        a payment reference so it lands in the reconciliation log. NOTE: this
///        is a deliberate deviation from ERC-20 — the token keeps the standard's
///        ABI but not its behaviour, so venues that call the two-argument
///        entrypoints (exchanges, custodians, DEXes, most explorers' "send"
///        buttons) cannot move these tokens. That is intended for a closed-loop
///        gateway asset; it is not suitable for a freely tradable one;
///      Storage: this contract's own state lives in an ERC-7201 namespace, so
///      future versions may add parent contracts without colliding with it.

contract CurrencyToken is
    Initializable,
    ERC20Upgradeable,
    ERC20PermitUpgradeable,
    ERC20PausableUpgradeable,
    Ownable2StepUpgradeable,
    UUPSUpgradeable
{
    /// ********************************** Events ****************************************

    /// @notice Emitted for every transfer that carries a payment reference.
    /// @param from Sender of the funds.
    /// @param to Recipient of the funds.
    /// @param referenceHash `keccak256(bytes(paymentReference))`, indexed so
    ///        reconciliation can look a payment up directly instead of scanning
    ///        block ranges.
    /// @param value Amount transferred, in token units.
    /// @param paymentReference The plain-text reference, carried in the data section.
    event TransferSuccess(
        address indexed from,
        address indexed to,
        bytes32 indexed referenceHash,
        uint256 value,
        string paymentReference
    );

    /// ********************************** Errors ****************************************

    /// @notice A referenced transfer, mint or burn was attempted with a zero amount.
    error ZeroAmount();
    /// @notice A referenced transfer was attempted with an empty reference string.
    error EmptyReference();
    /// @notice Batch input arrays are not all the same length.
    error LengthMismatch();
    /// @notice A batch call was made with no entries.
    error EmptyBatch();
    /// @notice `renounceOwnership` is permanently disabled on this token.
    error RenounceDisabled();
    /// @notice The token owner was given as the zero address.
    error ZeroAddress();
    /// @notice A referenced transfer was attempted with a reference that has already been used.
    error ReferenceAlreadyUsed();
    /// @notice The plain ERC-20 entrypoints are disabled; use the overload that
    ///         takes a payment reference.
    error ReferenceRequired();

    /// ********************************** Storage ****************************************

    /// @custom:storage-location erc7201:kumaapay.storage.CurrencyToken
    struct CurrencyTokenStorage {
        uint8 decimals;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("kumaapay.storage.CurrencyToken")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant CURRENCY_TOKEN_STORAGE =
        0x442239b2b9b30c3758ea54520206457758ec662da4e587c0ad8e5daa89aac300;

    function _currencyTokenStorage()
        private
        pure
        returns (CurrencyTokenStorage storage $)
    {
        assembly {
            $.slot := CURRENCY_TOKEN_STORAGE
        }
    }

    /// ********************************** States ****************************************

    /// @dev Mapping for payment reference -> sender -> recipient -> amount -> used. Prevents double-spending of a reference.
    mapping(string => mapping(address => mapping(address => mapping(uint256 => bool))))
        public paymentReferenceUsed;

    /// ********************************** Constructor ****************************************

    /// @dev Locks the implementation so it can only ever be used through a proxy.
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// ********************************** Initializer ****************************************

    function initialize(
        string memory _name,
        string memory _symbol,
        address _owner,
        uint8 _tokenDecimals,
        uint256 _initialSupply
    ) public initializer {
        if (_owner == address(0)) {
            revert ZeroAddress();
        }

        __ERC20_init(_name, _symbol);
        __ERC20Permit_init(_name);
        __ERC20Pausable_init();
        __Ownable_init(_owner);
        __Ownable2Step_init();
        __UUPSUpgradeable_init();

        _currencyTokenStorage().decimals = _tokenDecimals;

        if (_initialSupply != 0) {
            _mint(_owner, _initialSupply);
        }
    }

    /// ********************************** Transfers ****************************************

    /// @notice Transfer with a payment reference recorded in {TransferSuccess}.
    function transfer(
        address to,
        uint256 amount,
        string calldata paymentReference
    ) external virtual {
        address sender = _msgSender();

        _validateReferenced(amount, paymentReference, sender, to);

        super.transfer(to, amount);

        paymentReferenceUsed[paymentReference][sender][to][amount] = true;

        emit TransferSuccess(
            sender,
            to,
            keccak256(bytes(paymentReference)),
            amount,
            paymentReference
        );
    }

    /// @notice Disabled. Use {transfer(address,uint256,string)} instead.
    /// @dev Kept in the ABI for ERC-20 shape, but always reverts: an unreferenced
    ///      movement would never reach the reconciliation log.
    function transfer(
        address,
        uint256
    ) public pure virtual override returns (bool) {
        revert ReferenceRequired();
    }

    /// @notice Disabled. Use {transferFrom(address,address,uint256,string)} instead.
    /// @dev Kept in the ABI for ERC-20 shape, but always reverts: an unreferenced
    ///      movement would never reach the reconciliation log.
    function transferFrom(
        address,
        address,
        uint256
    ) public pure virtual override returns (bool) {
        revert ReferenceRequired();
    }

    /// @notice Transfer to many recipients, each with its own payment reference.
    function batchTransfer(
        address[] calldata to,
        uint256[] calldata amounts,
        string[] calldata references
    ) external virtual {
        uint256 len = to.length;

        if (len == 0) {
            revert EmptyBatch();
        }
        if (len != amounts.length || len != references.length) {
            revert LengthMismatch();
        }

        address sender = _msgSender();

        for (uint256 i = 0; i < len; ) {
            _validateReferenced(amounts[i], references[i], sender, to[i]);

            super.transfer(to[i], amounts[i]);

            paymentReferenceUsed[references[i]][sender][to[i]][
                amounts[i]
            ] = true;

            emit TransferSuccess(
                sender,
                to[i],
                keccak256(bytes(references[i])),
                amounts[i],
                references[i]
            );

            unchecked {
                ++i;
            }
        }
    }

    /// @notice Allowance-based transfer with a payment reference.
    function transferFrom(
        address from,
        address to,
        uint256 amount,
        string calldata paymentReference
    ) external virtual {
        _validateReferenced(amount, paymentReference, from, to);

        super.transferFrom(from, to, amount);

        paymentReferenceUsed[paymentReference][from][to][amount] = true;

        emit TransferSuccess(
            from,
            to,
            keccak256(bytes(paymentReference)),
            amount,
            paymentReference
        );
    }

    /// @notice Allowance-based transfers for many payers/recipients.
    function batchTransferFrom(
        address[] calldata from,
        address[] calldata to,
        uint256[] calldata amounts,
        string[] calldata references
    ) external virtual {
        uint256 len = to.length;

        if (len == 0) {
            revert EmptyBatch();
        }
        if (
            len != from.length ||
            len != amounts.length ||
            len != references.length
        ) {
            revert LengthMismatch();
        }

        for (uint256 i = 0; i < len; ) {
            _validateReferenced(amounts[i], references[i], from[i], to[i]);

            super.transferFrom(from[i], to[i], amounts[i]);

            paymentReferenceUsed[references[i]][from[i]][to[i]][
                amounts[i]
            ] = true;

            emit TransferSuccess(
                from[i],
                to[i],
                keccak256(bytes(references[i])),
                amounts[i],
                references[i]
            );

            unchecked {
                ++i;
            }
        }
    }

    /// ********************************** Supply ****************************************

    /// @notice Mint new supply. Owner only.
    function mint(address to, uint256 amount) external onlyOwner {
        if (amount == 0) {
            revert ZeroAmount();
        }

        _mint(to, amount);
    }

    /// @notice Burn supply from any holder, without allowance. Owner only.
    /// @dev Deliberate for a closed-loop gateway token; treat as a monitored
    ///      invariant — see the contract-level trust assumption.
    function burn(address from, uint256 amount) external onlyOwner {
        if (amount == 0) {
            revert ZeroAmount();
        }

        _burn(from, amount);
    }

    /// ********************************** Pausing ****************************************

    /// @notice Halt all balance movements, including mint and burn. Owner only.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resume balance movements. Owner only.
    function unpause() external onlyOwner {
        _unpause();
    }

    /// ********************************** Ownership ****************************************

    /// @notice Permanently disabled: renouncing would strand `mint`, `burn`,
    ///         `pause` and the upgrade authority with no way to recover them.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    /// ********************************** Views ****************************************

    function decimals() public view virtual override returns (uint8) {
        return _currencyTokenStorage().decimals;
    }

    /// ********************************** Pure ****************************************

    function version() external pure virtual returns (string memory) {
        return "v1";
    }

    /// ********************************** Internal ****************************************

    /// @dev Only this token's owner may upgrade this token's implementation.
    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyOwner {}

    function _validateReferenced(
        uint256 amount,
        string calldata paymentReference,
        address from,
        address to
    ) private view {
        if (amount == 0) {
            revert ZeroAmount();
        }

        if (bytes(paymentReference).length == 0) {
            revert EmptyReference();
        }

        if (paymentReferenceUsed[paymentReference][from][to][amount]) {
            revert ReferenceAlreadyUsed();
        }
    }

    function _update(
        address from,
        address to,
        uint256 value
    ) internal virtual override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        super._update(from, to, value);
    }
}
