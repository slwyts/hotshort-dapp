// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title HotshortVault
 * @notice 极简资金托管合约：用户存款上链可查；提款须由 Worker 签出 EIP-712 凭证。
 *         所有业务规则（利率、套餐、彩票、燃烧、返佣）均在链下 Cloudflare Worker 执行。
 *
 *         Roles:
 *           - owner   : 应急权限（轮换 signer / 暂停 / 紧急归集）
 *           - signer  : Worker 私钥地址，签发 claim 凭证
 *
 *         Tokens (BSC mainnet):
 *           - USDT, HS, LP(PancakePair) 共用同一份 deposit/claim
 */

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract HotshortVault {
    // --- Errors ---
    error NotOwner();
    error Paused();
    error ZeroAmount();
    error ZeroAddress();
    error NonceUsed();
    error Expired();
    error BadSignature();
    error TransferFailed();

    // --- Events ---
    event Deposited(address indexed user, address indexed token, uint256 amount, uint8 indexed purpose, bytes32 ref);
    event Claimed(address indexed user, address indexed token, uint256 amount, uint8 indexed reason, uint256 nonce);
    event Burned(address indexed user, uint256 amount, address indexed referrer);
    event SwappedHsToStock(address indexed user, uint256 hsAmount);
    event SignerUpdated(address indexed previousSigner, address indexed newSigner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PausedUpdated(bool paused);
    event AdminWithdraw(address indexed token, address indexed to, uint256 amount);

    // --- Storage ---
    address public owner;
    address public signer;
    bool public paused;
    mapping(uint256 => bool) public usedNonces;

    // EIP-712
    bytes32 public constant CLAIM_TYPEHASH = keccak256(
        "Claim(address user,address token,uint256 amount,uint256 nonce,uint256 deadline,uint8 reason)"
    );
    bytes32 private immutable _DOMAIN_SEPARATOR;

    constructor(address _signer) {
        if (_signer == address(0)) revert ZeroAddress();
        owner = msg.sender;
        signer = _signer;

        _DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("Hotshort")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );

        emit OwnershipTransferred(address(0), msg.sender);
        emit SignerUpdated(address(0), _signer);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    // --- 用户入金 ---
    /**
     * @notice 用户存款（USDT/HS/LP 通用）。
     * @param token    ERC20 地址
     * @param amount   数额
     * @param purpose  1=stake 2=ai-package 3=lottery-ticket 4=burn 5=swap-hs-to-stock
     * @param ref      可选业务引用（订单号/套餐档位/彩票期号），由前端 keccak 计算
     */
    function deposit(address token, uint256 amount, uint8 purpose, bytes32 ref) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        bool ok = IERC20(token).transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        emit Deposited(msg.sender, token, amount, purpose, ref);
    }

    // --- 用户领取 ---
    /**
     * @notice 凭 Worker 签名领取奖励/本金/分红。
     * @param token     ERC20 地址
     * @param amount    数额
     * @param nonce     全局唯一 nonce（Worker 维护，禁止重放）
     * @param deadline  签名截止时间（unix 秒）
     * @param reason    1=stake-yield 2=stock-dividend 3=lottery-prize 4=burn-dividend
     *                  5=referral 6=hs-airdrop 7=admin-refund
     * @param sig       65 字节 ECDSA 签名（v,r,s 顺序）
     */
    function claim(
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        uint8 reason,
        bytes calldata sig
    ) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp > deadline) revert Expired();
        if (usedNonces[nonce]) revert NonceUsed();

        bytes32 structHash = keccak256(
            abi.encode(CLAIM_TYPEHASH, msg.sender, token, amount, nonce, deadline, reason)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", _DOMAIN_SEPARATOR, structHash));

        address recovered = _recover(digest, sig);
        if (recovered == address(0) || recovered != signer) revert BadSignature();

        usedNonces[nonce] = true;
        bool ok = IERC20(token).transfer(msg.sender, amount);
        if (!ok) revert TransferFailed();

        emit Claimed(msg.sender, token, amount, reason, nonce);
    }

    // --- 闪兑：HS -> 锁仓 2 年股票（链上仅记录入金，股票账本由 Worker 维护） ---
    function swapHsToStock(address hsToken, uint256 hsAmount) external whenNotPaused {
        if (hsAmount == 0) revert ZeroAmount();
        bool ok = IERC20(hsToken).transferFrom(msg.sender, address(this), hsAmount);
        if (!ok) revert TransferFailed();
        emit SwappedHsToStock(msg.sender, hsAmount);
    }

    // --- 燃烧 HS（用户主动；具体分配在 Worker 里按 50/20/15/5/5/5 计算） ---
    function burnHS(address hsToken, uint256 amount, address referrer) external whenNotPaused {
        if (amount == 0) revert ZeroAmount();
        bool ok = IERC20(hsToken).transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        emit Burned(msg.sender, amount, referrer);
    }

    // --- 管理员 ---
    function setSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        emit SignerUpdated(signer, newSigner);
        signer = newSigner;
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedUpdated(_paused);
    }

    function withdrawTo(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        bool ok = IERC20(token).transfer(to, amount);
        if (!ok) revert TransferFailed();
        emit AdminWithdraw(token, to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    // --- View ---
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }

    // --- Internal ---
    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return address(0);
        // 防 ECDSA malleability
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return address(0);
        }
        return ecrecover(digest, v, r, s);
    }
}
