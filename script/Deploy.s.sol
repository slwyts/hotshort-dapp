// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/HotshortVault.sol";

/**
 * 部署脚本：
 *   forge script script/Deploy.s.sol --rpc-url <network> --broadcast
 *
 * 环境变量：
 *   PRIVATE_KEY     必填，部署者
 *   INITIAL_OWNER   可选，初始 owner；默认 = 部署者
 *   INITIAL_SIGNER  可选，初始 EIP-712 签名者；默认 = 部署者
 */
contract Deploy is Script {
    function run() external returns (HotshortVault vault) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address initialOwner = vm.envOr("INITIAL_OWNER", deployer);
        address signer = vm.envOr("INITIAL_SIGNER", deployer);

        vm.startBroadcast(pk);
        vault = new HotshortVault(initialOwner, signer);
        vm.stopBroadcast();

        console2.log("HotshortVault:", address(vault));
        console2.log("Owner       :", initialOwner);
        console2.log("Signer      :", signer);
        console2.log("ChainId     :", block.chainid);
    }
}
