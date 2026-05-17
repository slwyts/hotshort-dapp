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
    address internal alice = address(0xA11);
    address internal bob = address(0xB0B);
    address internal dead = address(0x000000000000000000000000000000000000dEaD);

    uint256 constant ONE = 1e18;

    function setUp() public {
        signerAddr = vm.addr(signerPk);
        vault = new HotshortVault(address(this), signerAddr);

        usdt = new MockERC20("Mock USDT", "USDT", 18);
        hs = new MockERC20("Mock HS", "HS", 18);

        usdt.mint(alice, 10_000 * ONE);
        hs.mint(alice, 10_000 * ONE);
        usdt.mint(address(vault), 10_000 * ONE);
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

    function test_ConstructorSetsExplicitOwner() public {
        HotshortVault ownedByBob = new HotshortVault(bob, signerAddr);
        assertEq(ownedByBob.owner(), bob);
        assertEq(ownedByBob.signer(), signerAddr);

        vm.prank(bob);
        ownedByBob.setPaused(true);
        assertTrue(ownedByBob.paused());
    }

    function test_ConstructorRejectsZeroOwner() public {
        vm.expectRevert(abi.encodeWithSignature("OwnableInvalidOwner(address)", address(0)));
        new HotshortVault(address(0), signerAddr);
    }

    function test_ClaimWithValidSignatureReleasesFunds() public {
        uint256 amount = 500 * ONE;
        uint256 nonce = 1;
        uint256 deadline = block.timestamp + 3600;
        uint8 reason = 2;
        (address[] memory recipients, uint256[] memory amounts) = _singlePayout(alice, amount);
        bytes memory sig = _signClaim(alice, address(usdt), recipients, amounts, nonce, deadline, reason);

        uint256 balBefore = usdt.balanceOf(alice);
        vm.prank(alice);
        vault.claim(address(usdt), recipients, amounts, nonce, deadline, reason, sig);
        assertEq(usdt.balanceOf(alice) - balBefore, amount);

        vm.prank(alice);
        vm.expectRevert(HotshortVault.NonceUsed.selector);
        vault.claim(address(usdt), recipients, amounts, nonce, deadline, reason, sig);
    }

    function test_ClaimWithMultipleSignedPayoutsReleasesFunds() public {
        uint256 nonce = 11;
        uint256 deadline = block.timestamp + 3600;
        uint8 reason = 1;
        address[] memory recipients = new address[](2);
        recipients[0] = alice;
        recipients[1] = dead;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 950 * ONE;
        amounts[1] = 50 * ONE;
        bytes memory sig = _signClaim(alice, address(usdt), recipients, amounts, nonce, deadline, reason);

        uint256 userBefore = usdt.balanceOf(alice);
        uint256 deadBefore = usdt.balanceOf(dead);
        vm.prank(alice);
        vault.claim(address(usdt), recipients, amounts, nonce, deadline, reason, sig);
        assertEq(usdt.balanceOf(alice) - userBefore, 950 * ONE);
        assertEq(usdt.balanceOf(dead) - deadBefore, 50 * ONE);
    }

    function test_ClaimRejectsTamperedPayouts() public {
        uint256 nonce = 12;
        uint256 deadline = block.timestamp + 3600;
        uint8 reason = 1;
        (address[] memory recipients, uint256[] memory amounts) = _singlePayout(alice, 500 * ONE);
        bytes memory sig = _signClaim(alice, address(usdt), recipients, amounts, nonce, deadline, reason);
        amounts[0] = 501 * ONE;

        vm.prank(alice);
        vm.expectRevert(HotshortVault.BadSignature.selector);
        vault.claim(address(usdt), recipients, amounts, nonce, deadline, reason, sig);
    }

    function test_ClaimRejectsBadSigner() public {
        uint256 amount = 500 * ONE;
        uint256 nonce = 2;
        uint256 deadline = block.timestamp + 3600;
        (address[] memory recipients, uint256[] memory amounts) = _singlePayout(alice, amount);
        bytes memory sig = _signClaimWithKey(0xBAD5, alice, address(usdt), recipients, amounts, nonce, deadline, 1);

        vm.prank(alice);
        vm.expectRevert(HotshortVault.BadSignature.selector);
        vault.claim(address(usdt), recipients, amounts, nonce, deadline, 1, sig);
    }

    function test_ClaimRejectsExpired() public {
        uint256 amount = 100 * ONE;
        uint256 nonce = 3;
        uint256 deadline = block.timestamp + 1;
        (address[] memory recipients, uint256[] memory amounts) = _singlePayout(alice, amount);
        bytes memory sig = _signClaim(alice, address(usdt), recipients, amounts, nonce, deadline, 1);

        vm.warp(deadline + 1);
        vm.prank(alice);
        vm.expectRevert(HotshortVault.Expired.selector);
        vault.claim(address(usdt), recipients, amounts, nonce, deadline, 1, sig);
    }

    function test_AdminOnlyControls() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        vault.setSigner(bob);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        vault.setPaused(true);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        vault.withdrawTo(address(usdt), bob, 1);

        vault.setSigner(bob);
        assertEq(vault.signer(), bob);
        vault.setPaused(true);
        assertTrue(vault.paused());
    }

    function test_PausedBlocksDepositClaimBurnSwap() public {
        uint256 amount = 100 * ONE;
        uint256 nonce = 4;
        uint256 deadline = block.timestamp + 3600;
        (address[] memory recipients, uint256[] memory amounts) = _singlePayout(alice, amount);
        bytes memory sig = _signClaim(alice, address(usdt), recipients, amounts, nonce, deadline, 1);

        vault.setPaused(true);

        vm.startPrank(alice);
        usdt.approve(address(vault), 1 * ONE);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.deposit(address(usdt), 1 * ONE, 1, bytes32(0));

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.claim(address(usdt), recipients, amounts, nonce, deadline, 1, sig);

        hs.approve(address(vault), 2 * ONE);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.burnHS(address(hs), 1 * ONE, alice);

        vm.expectRevert(Pausable.EnforcedPause.selector);
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
        uint256 beforeBalance = usdt.balanceOf(bob);
        vault.withdrawTo(address(usdt), bob, 1_000 * ONE);
        assertEq(usdt.balanceOf(bob) - beforeBalance, 1_000 * ONE);
    }

    function _singlePayout(
        address recipient,
        uint256 amount
    ) internal pure returns (address[] memory recipients, uint256[] memory amounts) {
        recipients = new address[](1);
        recipients[0] = recipient;
        amounts = new uint256[](1);
        amounts[0] = amount;
    }

    function _signClaim(
        address user,
        address token,
        address[] memory recipients,
        uint256[] memory amounts,
        uint256 nonce,
        uint256 deadline,
        uint8 reason
    ) internal view returns (bytes memory) {
        return _signClaimWithKey(signerPk, user, token, recipients, amounts, nonce, deadline, reason);
    }

    function _signClaimWithKey(
        uint256 pk,
        address user,
        address token,
        address[] memory recipients,
        uint256[] memory amounts,
        uint256 nonce,
        uint256 deadline,
        uint8 reason
    ) internal view returns (bytes memory) {
        bytes32 typeHash = keccak256(
            "Claim(address user,address token,bytes32 payoutsHash,uint256 nonce,uint256 deadline,uint8 reason)"
        );
        bytes32 payoutsHash = keccak256(abi.encode(recipients, amounts));
        bytes32 structHash = keccak256(abi.encode(typeHash, user, token, payoutsHash, nonce, deadline, reason));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }
}
