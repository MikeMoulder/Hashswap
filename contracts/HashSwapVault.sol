// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Nox, euint256, ebool} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

/// @title HashSwapVault
/// @notice Confidential balances. Intents spend from here; they never move tokens.
///
/// ## Why this contract exists at all
///
/// This is the fix for the failure mode that would otherwise sink the whole
/// project (build.md §2.3 / F1). If `submitIntent()` pulled funds with
/// `transferFrom(user, amount)`, the ERC-20 `Transfer` event would publish the
/// exact amount, and *which* token moved would publish the direction. Every
/// encrypted handle in the system would be decoration — a single `eth_getLogs`
/// call would reconstruct the entire order book.
///
/// So funding is decoupled from trading. Users deposit ahead of time, in
/// whatever quantity they like, and intents draw down an encrypted balance. The
/// deposit is public; the *link* between a deposit and any particular intent is
/// not.
///
/// ## What is still public, stated plainly
///
///   - Deposit amounts and their timing.
///   - Withdrawal amounts and their timing.
///   - The fact that an address holds a balance at all.
///
/// Privacy comes from decoupling in time and quantity, not from hiding that a
/// user exists. A user who deposits exactly 10 ETH and immediately submits a
/// 10 ETH intent has self-linked, and no amount of cryptography fixes that. The
/// UI should discourage it; the README should admit it.
///
/// ## Inheritance, not composition
///
/// `HashSwap` inherits this rather than calling into a separate deployment.
/// Passing an `euint256` across a contract boundary requires an
/// `Nox.allowTransient` grant to the callee first, and every one of those is
/// another NoxCompute call — real gas, on the hot path, for no benefit
/// (build.md §2.6). One deployment, two files.
abstract contract HashSwapVault {
    using SafeERC20 for IERC20;

    /// @dev token => user => encrypted balance.
    mapping(address => mapping(address => euint256)) private _balances;

    struct PendingWithdrawal {
        address user;
        address token;
        uint256 amount;
        bytes32 okHandle;
        bool finalized;
    }

    mapping(uint256 => PendingWithdrawal) private _withdrawals;
    uint256 private _nextWithdrawalId = 1;

    /// @dev Reentrancy flag, shared with `HashSwap`. Every entry point that both
    ///      moves ERC-20s and mutates encrypted state takes it. The tokens are
    ///      constructor parameters, so a hook-bearing token (ERC-777, ERC-1363)
    ///      is a deployment choice rather than something this contract controls.
    uint256 private _entered;

    error Reentrancy();

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    event Deposited(address indexed user, address indexed token, uint256 amount);
    event WithdrawalRequested(
        uint256 indexed id, address indexed user, address indexed token, uint256 amount, bytes32 okHandle
    );
    event WithdrawalFinalized(uint256 indexed id, bool success);

    error AlreadyFinalized();
    error UnknownWithdrawal();
    error ZeroAmount();

    // ------------------------------------------------------------- deposits

    /// @notice Deposit tokens into a confidential balance.
    ///
    /// @dev The amount is public here by design — see the note above. Encrypting
    ///      it would be theatre: the ERC-20 transfer reveals it regardless.
    ///
    ///      The credit is the *measured* balance delta, not the requested
    ///      amount. A fee-on-transfer or rebasing token delivers less than it is
    ///      asked for, and crediting the request would mint vault balance out of
    ///      nothing — the encrypted books would exceed the real ones and the last
    ///      withdrawer would eat the difference.
    function deposit(address token, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();

        uint256 balanceBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = IERC20(token).balanceOf(address(this)) - balanceBefore;
        if (received == 0) revert ZeroAmount();

        _credit(token, msg.sender, Nox.toEuint256(received));
        emit Deposited(msg.sender, token, received);
    }

    // ------------------------------------------------------------ withdrawals

    /// @notice Step 1 of 2 — debit the encrypted balance and ask for a proof.
    ///
    /// @dev Two phases, because solvency cannot be checked synchronously. The
    ///      balance is encrypted, so `Nox.safeSub` reports success as an *encrypted*
    ///      boolean, and Solidity cannot `require` on a ciphertext. The handle is
    ///      marked publicly decryptable and the answer comes back with a gateway
    ///      signature in step 2.
    ///
    ///      This is the same shape as batch settlement (build.md §2.2): compute
    ///      privately, publish one value, verify its proof on-chain before acting.
    function requestWithdraw(address token, uint256 amount)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (amount == 0) revert ZeroAmount();

        euint256 balance = _balances[token][msg.sender];
        (ebool ok, euint256 debited) = Nox.safeSub(balance, Nox.toEuint256(amount));

        // CRITICAL: on underflow `safeSub` returns (false, 0) — it does NOT return
        // the original balance. Assigning `debited` unconditionally would wipe the
        // balance of anyone who requested one wei too much. Always select.
        euint256 newBalance = Nox.select(ok, debited, balance);
        _setBalance(token, msg.sender, newBalance);

        Nox.allowThis(ok);
        Nox.allowPublicDecryption(ok);

        id = _nextWithdrawalId++;
        _withdrawals[id] = PendingWithdrawal({
            user: msg.sender,
            token: token,
            amount: amount,
            okHandle: ebool.unwrap(ok),
            finalized: false
        });

        emit WithdrawalRequested(id, msg.sender, token, amount, ebool.unwrap(ok));
    }

    /// @notice Step 2 of 2 — prove the debit succeeded and release the tokens.
    /// @param proof Gateway-signed decryption proof for the request's `ok` handle.
    /// @dev Permissionless: the proof is what authorises, not the caller. A forged
    ///      proof reverts inside `Nox.publicDecrypt`. Funds always go to the
    ///      original requester, never to `msg.sender`.
    function finalizeWithdraw(uint256 id, bytes calldata proof) external nonReentrant {
        PendingWithdrawal storage w = _withdrawals[id];
        if (w.user == address(0)) revert UnknownWithdrawal();
        if (w.finalized) revert AlreadyFinalized();
        w.finalized = true;

        bool ok = Nox.publicDecrypt(ebool.wrap(w.okHandle), proof);
        if (ok) {
            IERC20(w.token).safeTransfer(w.user, w.amount);
        }
        // If !ok the balance was never debited (the select above kept it), so
        // there is nothing to undo.

        emit WithdrawalFinalized(id, ok);
    }

    // --------------------------------------------------------------- internals

    /// @dev Credit an encrypted amount. Used by deposits, batch fills, and
    ///      cancellation refunds.
    function _credit(address token, address user, euint256 amount) internal {
        euint256 newBalance = Nox.add(_balances[token][user], amount);
        _setBalance(token, user, newBalance);
    }

    /// @dev Debit up to `amount`, reporting success as an encrypted boolean.
    ///
    ///      Returns `effective`, which is `amount` when the user could afford it
    ///      and zero otherwise. Callers fold `effective` into batch totals so an
    ///      unfunded intent contributes nothing without revealing that it was
    ///      unfunded — this is the griefing fix in build.md F7. Reverting instead
    ///      would leak the user's solvency, and letting the intent through would
    ///      let one attacker poison every batch.
    function _debit(address token, address user, euint256 amount)
        internal
        returns (euint256 effective, ebool ok)
    {
        euint256 balance = _balances[token][user];
        euint256 debited;
        (ok, debited) = Nox.safeSub(balance, amount);

        _setBalance(token, user, Nox.select(ok, debited, balance));

        effective = Nox.select(ok, amount, Nox.toEuint256(0));
        Nox.allowThis(effective);
        Nox.allowThis(ok);
    }

    /// @dev Store a balance and re-grant access.
    ///
    ///      Every derived handle needs `allowThis` + `allow(user)` in the SAME
    ///      transaction that produced it. Transient grants are wiped at end-of-tx,
    ///      so a handle stored without them is unreadable forever after — the most
    ///      common Nox bug by a wide margin (build.md §8, trap 2). Centralised
    ///      here so it cannot be forgotten at a call site.
    function _setBalance(address token, address user, euint256 newBalance) private {
        _balances[token][user] = newBalance;
        Nox.allowThis(newBalance);
        Nox.allow(newBalance, user);
    }

    // ----------------------------------------------------------------- views

    /// @notice The caller's own encrypted balance handle, for client-side decryption.
    function balanceHandleOf(address token, address user) external view returns (bytes32) {
        return euint256.unwrap(_balances[token][user]);
    }

    function pendingWithdrawal(uint256 id) external view returns (PendingWithdrawal memory) {
        return _withdrawals[id];
    }
}
