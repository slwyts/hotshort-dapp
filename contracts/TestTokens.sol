// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IPancakeRouter02 {
    function factory() external view returns (address);

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint256 amountADesired,
        uint256 amountBDesired,
        uint256 amountAMin,
        uint256 amountBMin,
        address to,
        uint256 deadline
    ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity);
}

interface IPancakeFactory {
    function getPair(address tokenA, address tokenB) external view returns (address);
}

/**
 * 测试 USDT —— 100T 全 mint 给 bootstrapHolder（即 TestHS 合约本身），owner 给 deployer。
 * 公开限频 faucet。
 */
contract TestUSDT is ERC20, Ownable {
    error FaucetCooldown();

    uint256 public faucetAmount = 10_000 ether;
    uint256 public faucetCooldown = 12 hours;
    mapping(address => uint256) public lastFaucetAt;

    event Faucet(address indexed to, uint256 amount);
    event FaucetParamsUpdated(uint256 amount, uint256 cooldown);

    constructor(address bootstrapHolder, address owner_)
        ERC20("Test USDT", "tUSDT")
        Ownable(owner_)
    {
        _mint(bootstrapHolder, 100_000_000_000_000 ether);
    }

    function faucet() external {
        if (block.timestamp < lastFaucetAt[msg.sender] + faucetCooldown) revert FaucetCooldown();
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);
        emit Faucet(msg.sender, faucetAmount);
    }

    function setFaucetParams(uint256 amount, uint256 cooldown) external onlyOwner {
        faucetAmount = amount;
        faucetCooldown = cooldown;
        emit FaucetParamsUpdated(amount, cooldown);
    }
}

/**
 * 测试 HS —— 构造函数：
 *   1) 部 TestUSDT，把 100T tUSDT 全 mint 给本合约；
 *   2) 给本合约 mint 100T tHS。
 *
 * 部署后由 owner 调一次 bootstrapLiquidity(router, hsLiq, usdtLiq)：
 *   - approve PancakeRouter；
 *   - addLiquidity（首次会自动 createPair）；
 *   - 收到的 LP 凭证全部打入 0xdEaD —— 池子永久锁定无法 rug；
 *   - 剩余 tHS / tUSDT 转给 owner，方便分发 / faucet。
 *
 * 一次性流程，bootstrapped flag 防重入。
 */
contract TestHS is ERC20, Ownable {
    error FaucetCooldown();
    error AlreadyBootstrapped();
    error NotBootstrappedYet();

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    TestUSDT public immutable usdt;
    address public pair;
    address public router;
    bool public bootstrapped;

    uint256 public faucetAmount = 10_000 ether;
    uint256 public faucetCooldown = 12 hours;
    mapping(address => uint256) public lastFaucetAt;

    event Faucet(address indexed to, uint256 amount);
    event FaucetParamsUpdated(uint256 amount, uint256 cooldown);
    event LiquidityBootstrapped(address indexed pair, uint256 hsLiq, uint256 usdtLiq, uint256 lpBurned);

    constructor() ERC20("Test HotShort", "tHS") Ownable(msg.sender) {
        usdt = new TestUSDT(address(this), msg.sender);
        _mint(address(this), 100_000_000_000_000 ether);
    }

    /**
     * 一键建池 + 锁池：approve → addLiquidity → LP burn 到 0xdEaD → 余币给 owner。
     * 比例由 hsLiq / usdtLiq 决定（默认 1 亿 / 8 万 → 1 THS = 0.0008 TUSDT）。
     */
    function bootstrapLiquidity(
        address router_,
        uint256 hsLiq,
        uint256 usdtLiq
    ) external onlyOwner returns (address pair_, uint256 lpBurned) {
        if (bootstrapped) revert AlreadyBootstrapped();
        bootstrapped = true;
        router = router_;

        _approve(address(this), router_, hsLiq);
        usdt.approve(router_, usdtLiq);

        (, , uint256 lp) = IPancakeRouter02(router_).addLiquidity(
            address(this),
            address(usdt),
            hsLiq,
            usdtLiq,
            hsLiq,
            usdtLiq,
            address(this),
            block.timestamp + 600
        );

        pair_ = IPancakeFactory(IPancakeRouter02(router_).factory()).getPair(
            address(this),
            address(usdt)
        );
        pair = pair_;

        IERC20(pair_).transfer(DEAD, lp);
        lpBurned = lp;

        _transfer(address(this), msg.sender, balanceOf(address(this)));
        usdt.transfer(msg.sender, usdt.balanceOf(address(this)));

        emit LiquidityBootstrapped(pair_, hsLiq, usdtLiq, lp);
    }

    function faucet() external {
        if (!bootstrapped) revert NotBootstrappedYet();
        if (block.timestamp < lastFaucetAt[msg.sender] + faucetCooldown) revert FaucetCooldown();
        lastFaucetAt[msg.sender] = block.timestamp;
        _mint(msg.sender, faucetAmount);
        emit Faucet(msg.sender, faucetAmount);
    }

    function setFaucetParams(uint256 amount, uint256 cooldown) external onlyOwner {
        faucetAmount = amount;
        faucetCooldown = cooldown;
        emit FaucetParamsUpdated(amount, cooldown);
    }
}
