// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

contract SmartWalletV1 is Ownable2Step, ReentrancyGuard {
    using EnumerableSet for EnumerableSet.AddressSet;

    event TransactionSubmitted(
        bytes32 indexed txHash,
        address indexed proposer
    );
    event TransactionConfirmed(bytes32 indexed txHash, address indexed signer);
    event TransactionExecuted(bytes32 indexed txHash, address indexed executor);

    struct Transaction {
        address destination;
        uint256 value;
        bytes data;
        bool exists;
    }

    EnumerableSet.AddressSet private signers;
    mapping(bytes32 => Transaction) private transactions;
    mapping(bytes32 => mapping(address => bool)) private confirmations;
    mapping(bytes32 => uint256) private confirmationCounts;
    mapping(bytes32 => bool) private executedTransactions;
    uint256 public requiredSignatures = 1;
    uint256 public nonce = 0;

    modifier onlySigner() {
        require(signers.contains(msg.sender), "Not a signer");
        _;
    }

    modifier notZero(address _address) {
        require(_address != address(0), "Address cannot be zero");
        _;
    }

    constructor() Ownable() {}

    function submitTransaction(
        address destination,
        uint256 value,
        bytes memory data
    ) public onlySigner notZero(destination) returns (bytes32) {
        bytes32 txHash = keccak256(
            abi.encode(
                destination,
                value,
                data,
                msg.sender,
                block.timestamp,
                nonce++
            )
        );

        require(!transactions[txHash].exists, "Transaction already exists");

        transactions[txHash] = Transaction({
            destination: destination,
            value: value,
            data: data,
            exists: true
        });

        emit TransactionSubmitted(txHash, msg.sender);
        confirmTransaction(txHash);
        return txHash;
    }

    function confirmTransaction(bytes32 txHash) public onlySigner {
        require(transactions[txHash].exists, "Transaction does not exist");
        require(!confirmations[txHash][msg.sender], "Already confirmed");

        confirmations[txHash][msg.sender] = true;
        confirmationCounts[txHash] += 1;

        emit TransactionConfirmed(txHash, msg.sender);

        if (
            confirmationCounts[txHash] >= requiredSignatures &&
            !executedTransactions[txHash]
        ) {
            _executeTransaction(txHash);
        }
    }

    function _executeTransaction(bytes32 txHash) internal nonReentrant {
        Transaction memory txn = transactions[txHash];

        require(!executedTransactions[txHash], "Already executed");
        require(
            confirmationCounts[txHash] >= requiredSignatures,
            "Not enough confirmations"
        );

        executedTransactions[txHash] = true;

        (bool success, ) = txn.destination.call{value: txn.value}(txn.data);
        require(success, "Execution failed");

        emit TransactionExecuted(txHash, msg.sender);
    }

    function isSigner(address account) public view returns (bool) {
        return signers.contains(account);
    }

    function addSigner(address newSigner) public onlyOwner notZero(newSigner) {
        require(signers.add(newSigner), "Signer already added");
        if (requiredSignatures == 0) {
            requiredSignatures = 1;
        }
    }

    function removeSigner(address signer) public onlyOwner {
        require(signers.remove(signer), "Signer not found");
        if (requiredSignatures > signers.length()) {
            requiredSignatures = signers.length();
        }
    }

    function setRequiredSignatures(
        uint256 newRequiredSignatures
    ) public onlyOwner {
        require(
            newRequiredSignatures > 0,
            "Must require at least one signature"
        );
        require(requiredSignatures != newRequiredSignatures, "No change");
        requiredSignatures = newRequiredSignatures;
    }

    receive() external payable {}
}
