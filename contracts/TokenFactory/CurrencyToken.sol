// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract CurrencyToken is ERC20Permit, Ownable {
    /// ********************************** Events ****************************************

    event TransferSuccess(
        address indexed from,
        address indexed to,
        uint256 indexed value,
        string _reference
    );

    /// ********************************** Errors ****************************************

    error TransferFailed(
        address from,
        address to,
        uint256 value,
        string _reference
    );

    /// ********************************** Private States ****************************************
    uint8 private _decimals;

    /// ********************************** Constructor ****************************************

    constructor(
        string memory _name,
        string memory _symbol,
        address _owner,
        uint8 _tokenDecimals,
        uint256 _initialSupply
    ) ERC20Permit(_name) ERC20(_name, _symbol) Ownable(_owner) {
        _mint(_owner, _initialSupply);
        _decimals = _tokenDecimals;
    }

    /// ********************************** Functions ****************************************

    function transfer(
        address to,
        uint256 amount,
        string memory _reference
    ) public virtual {
        if (transfer(to, amount)) {
            emit TransferSuccess(_msgSender(), to, amount, _reference);
        } else {
            revert TransferFailed(_msgSender(), to, amount, _reference);
        }
    }

    function mint(address to, uint256 amount) public onlyOwner {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) public onlyOwner {
        _burn(from, amount);
    }

    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }
}
