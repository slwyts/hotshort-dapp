// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract HotshortVault is Ownable, Pausable, EIP712 {

    error ZeroAmount();
    error ZeroAddress();
    error NonceUsed();
    error Expired();
    error BadSignature();
    error BadPayouts();
    error TransferFailed();

    event Deposited(address indexed user, address indexed token, uint256 amount, uint8 indexed purpose, bytes32 ref);
    event Claimed(address indexed user, address indexed token, uint256 amount, uint8 indexed reason, uint256 nonce);
    event Burned(address indexed user, uint256 amount, address indexed referrer);
    event SwappedHsToStock(address indexed user, uint256 hsAmount);
    event SignerUpdated(address indexed previousSigner, address indexed newSigner);
    event AdminWithdraw(address indexed token, address indexed to, uint256 amount);

    address public signer;
    mapping(uint256 => bool) public usedNonces;

    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "Claim(address user,bytes32 payoutsHash,uint256 nonce,uint256 deadline,uint8 reason)"
    );

    constructor(address _owner, address _signer)
        Ownable(_owner)
        EIP712("Hotshort", "1")
    {
        if (_signer == address(0)) revert ZeroAddress();
        signer = _signer;
        emit SignerUpdated(address(0), _signer);
    }

    function deposit(address token, uint256 amount, uint8 purpose, bytes32 ref) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        bool ok = IERC20(token).transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        emit Deposited(msg.sender, token, amount, purpose, ref);
    }

    function claim(
        address[] calldata tokens,
        address[] calldata recipients,
        uint256[] calldata amounts,
        uint256 nonce,
        uint256 deadline,
        uint8 reason,
        bytes calldata sig
    ) external whenNotPaused {
        if (tokens.length == 0 || tokens.length != recipients.length || recipients.length != amounts.length) revert BadPayouts();
        if (block.timestamp > deadline) revert Expired();
        if (usedNonces[nonce]) revert NonceUsed();

        bytes32 payoutsHash = keccak256(abi.encode(tokens, recipients, amounts));
        bytes32 structHash = keccak256(
            abi.encode(CLAIM_TYPEHASH, msg.sender, payoutsHash, nonce, deadline, reason)
        );
        bytes32 digest = _hashTypedDataV4(structHash);

        address recovered = ECDSA.recover(digest, sig);
        if (recovered != signer) revert BadSignature();

        usedNonces[nonce] = true;
        for (uint256 i = 0; i < recipients.length; i++) {
            if (tokens[i] == address(0) || recipients[i] == address(0) || amounts[i] == 0) revert BadPayouts();
            bool ok = IERC20(tokens[i]).transfer(recipients[i], amounts[i]);
            if (!ok) revert TransferFailed();
            emit Claimed(msg.sender, tokens[i], amounts[i], reason, nonce);
        }
    }

    function swapHsToStock(address hsToken, uint256 hsAmount) external whenNotPaused {
        if (hsAmount == 0) revert ZeroAmount();
        bool ok = IERC20(hsToken).transferFrom(msg.sender, address(this), hsAmount);
        if (!ok) revert TransferFailed();
        emit SwappedHsToStock(msg.sender, hsAmount);
    }

    function burnHS(address hsToken, uint256 amount, address referrer) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        bool ok = IERC20(hsToken).transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        emit Burned(msg.sender, amount, referrer);
    }

    function setSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit SignerUpdated(signer, newSigner);
        signer = newSigner;
    }

    function setPaused(bool _paused) external onlyOwner {
        if (_paused) {
            _pause();
        } else {
            _unpause();
        }
    }

    function withdrawTo(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        bool ok = IERC20(token).transfer(to, amount);
        if (!ok) revert TransferFailed();
        emit AdminWithdraw(token, to, amount);
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _domainSeparatorV4();
    }
}
