// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/TestTokens.sol";

/**
 * 部署 TestHS（构造函数自动部 TestUSDT + mint 100T 给自己），
 * 然后调用 bootstrapLiquidity 在 PancakeSwap V2 建池并把 LP 烧到 0xdEaD：
 *   PRIVATE_KEY=0x... forge script script/DeployTestTokens.s.sol --rpc-url bsc --broadcast
 *
 * 默认参数：
 *   PANCAKE_ROUTER   = 0x10ED43C718714eb63d5aA57B78B54704E256024E（BSC V2）
 *   INITIAL_HS_LIQ   = 100_000_000 ether     —— 1 亿 THS 入池
 *   INITIAL_USDT_LIQ = 80_000 ether          —— 8 万 TUSDT 入池
 *   → 1 THS = 0.0008 TUSDT
 */
contract DeployTestTokens is Script {
    function run() external returns (TestHS testHs, TestUSDT testUsdt, address pair) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address router = vm.envOr(
            "PANCAKE_ROUTER",
            address(0x10ED43C718714eb63d5aA57B78B54704E256024E)
        );
        uint256 hsLiq = vm.envOr("INITIAL_HS_LIQ", uint256(100_000_000 ether));
        uint256 usdtLiq = vm.envOr("INITIAL_USDT_LIQ", uint256(80_000 ether));

        vm.startBroadcast(pk);
        testHs = new TestHS();
        (pair, ) = testHs.bootstrapLiquidity(router, hsLiq, usdtLiq);
        vm.stopBroadcast();

        testUsdt = testHs.usdt();

        console2.log("TestHS    :", address(testHs));
        console2.log("TestUSDT  :", address(testUsdt));
        console2.log("PancakePair:", pair);
        console2.log("Router    :", router);
        console2.log("ChainId   :", block.chainid);

        string memory key = "deployed";
        vm.serializeAddress(key, "testHs", address(testHs));
        vm.serializeAddress(key, "testUsdt", address(testUsdt));
        vm.serializeAddress(key, "pancakePair", pair);
        vm.serializeAddress(key, "router", router);
        vm.serializeUint(key, "chainId", block.chainid);
        string memory json = vm.serializeUint(key, "deployedAt", block.timestamp);
        vm.writeJson(json, "./lib/contracts/deployed.testnet.json");
    }
}
