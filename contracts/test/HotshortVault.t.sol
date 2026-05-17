// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../HotshortVault.sol";
import "./MockERC20.sol";

contract HotshortVaultTest is Test {
    HotshortVault internal vault;
    MockERC20 internal usdt;
    MockERC20 internal hs;

    uint256 internal signerPk = 0xA11CE;
    address internal signerAddr;
    address internal owner = address(this);
    address internal alice = address(0xA11);
    address internal bob = address(0xB0B);

    uint256 constant ONE = 1e18;

    function setUp() public {
        signerAddr = vm.addr(signerPk);
        vault = new HotshortVault(signerAddr);

        usdt = new MockERC20("Mock USDT", "USDT", 18);
        hs = new MockERC20("Mock HS", "HS", 18);

        usdt.mint(alice, 10_000 * ONE);
        hs.mint(alice, 10_000 * ONE);
        usdt.mint(address(vault), 10_000 * ONE); // 模拟奖池
    }

    function test_DepositPullsFundsAndEmits() public {
        vm.startPrank(alice);
        usdt.approve(address(vault), 1_000 * ONE);

        vm.expectEmit(true, true, true, true);
        emit HotshortVault.Deposited(alice, address(usdt), 1_000 * ONE, 1, bytes32(uint256(0xCAFE)));
        vault.deposit(address(usdt), 1_000 * ONE, 1, bytes32(uint256(0xCAFE)));
        vm.stopPrank();

        assertEq(usdt.balanceOf(address(vault)), 11_000 * ONE);
    }

    function test_ClaimWithValidSignatureReleasesFunds() public {
        uint256 amount = 500 * ONE;
        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 3600;
        uint8 reason = 1;

        bytes memory sig = _signClaim(alice, address(usdt), amount, nonce, deadline, reason);

        uint256 balBefore = usdt.balanceOf(alice);
        vm.prank(alice);
        vault.claim(address(usdt), amount, nonce, deadline, reason, sig);
        assertEq(usdt.balanceOf(alice) - balBefore, amount);

        // replay
        vm.prank(alice);
        vm.expectRevert(HotshortVault.NonceUsed.selector);
        vault.claim(address(usdt), amount, nonce, deadline, reason, sig);
    }

    function test_ClaimRejectsBadSigner() public {
        uint256 amount = 500 * ONE;
        uint256 nonce = 2;
        uint256 deadline = block.timestamp + 3600;

        bytes memory sig = _signClaimWithKey(0xBAD5, alice, address(usdt), amount, nonce, deadline, 1);

        vm.prank(alice);
        vm.expectRevert(HotshortVault.BadSignature.selector);
        vault.claim(address(usdt), amount, nonce, deadline, 1, sig);
    }

    function test_ClaimRejectsExpired() public {
        uint256 amount = 100 * ONE;
        uint256 nonce = 3;
        uint256 deadline = block.timestamp + 1;
        bytes memory sig = _signClaim(alice, address(usdt), amount, nonce, deadline, 1);

        vm.warp(deadline + 1);
        vm.prank(alice);
        vm.expectRevert(HotshortVault.Expired.selector);
        vault.claim(address(usdt), amount, nonce, deadline, 1, sig);
    }

    function test_OnlyOwnerCanRotateSignerOrPauseOrWithdraw() public {
        vm.prank(alice);
        vm.expectRevert(HotshortVault.NotOwner.selector);
        vault.setSigner(bob);

        vm.prank(alice);
        vm.expectRevert(HotshortVault.NotOwner.selector);
        vault.setPaused(true);

        vm.prank(alice);
        vm.expectRevert(HotshortVault.NotOwner.selector);
        vault.withdrawTo(address(usdt), bob, 1);

        vault.setSigner(bob);
        assertEq(vault.signer(), bob);
        vault.setPaused(true);
        assertTrue(vault.paused());
    }

    function test_PausedBlocksDepositClaimBurnSwap() public {
        vault.setPaused(true);

        vm.startPrank(alice);
        usdt.approve(address(vault), 1 * ONE);
        vm.expectRevert(HotshortVault.Paused.selector);
        vault.deposit(address(usdt), 1 * ONE, 1, bytes32(0));

        hs.approve(address(vault), 1 * ONE);
        vm.expectRevert(HotshortVault.Paused.selector);
        vault.burnHS(address(hs), 1 * ONE, alice);

        vm.expectRevert(HotshortVault.Paused.selector);
        vault.swapHsToStock(address(hs), 1 * ONE);
        vm.stopPrank();
    }

    function test_BurnAndSwapEmitAndPullHs() public {
        vm.startPrank(alice);
        hs.approve(address(vault), 100 * ONE);

        vm.expectEmit(true, true, false, true);
        emit HotshortVault.Burned(alice, 50 * ONE, bob);
        vault.burnHS(address(hs), 50 * ONE, bob);

        vm.expectEmit(true, false, false, true);
        emit HotshortVault.SwappedHsToStock(alice, 30 * ONE);
        vault.swapHsToStock(address(hs), 30 * ONE);
        vm.stopPrank();

        assertEq(hs.balanceOf(address(vault)), 80 * ONE);
    }

    function test_AdminWithdrawTransfersOut() public {
        uint256 before = usdt.balanceOf(bob);
        vault.withdrawTo(address(usdt), bob, 1_000 * ONE);
        assertEq(usdt.balanceOf(bob) - before, 1_000 * ONE);
    }

    // --- helpers ---
    function _signClaim(
        address user,
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        uint8 reason
    ) internal view returns (bytes memory) {
        return _signClaimWithKey(signerPk, user, token, amount, nonce, deadline, reason);
    }

    function _signClaimWithKey(
        uint256 pk,
        address user,
        address token,
        uint256 amount,
        uint256 nonce,
        uint256 deadline,
        uint8 reason
    ) internal view returns (bytes memory) {
        bytes32 typeHash = keccak256(
            "Claim(address user,address token,uint256 amount,uint256 nonce,uint256 deadline,uint8 reason)"
        );
        bytes32 structHash = keccak256(abi.encode(typeHash, user, token, amount, nonce, deadline, reason));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
