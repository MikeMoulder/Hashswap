// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, euint256, ebool} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

/// @title BatchMath
/// @notice Branchless helpers over Nox encrypted integers.
///
/// Nox has no `min`, `max`, or `abs` — see build.md §2.5. It also has no usable
/// `if` on ciphertext: branching on an encrypted value is impossible by
/// construction, so every conditional here is a `Nox.select`.
///
/// **Every function in this library costs gas proportional to its op count**,
/// because each `Nox.*` call is an external call into the NoxCompute singleton
/// (build.md §2.6). Op counts are documented per function and are the reason
/// `netOf` exists rather than a naive `min` + `absDiff` pair.
library BatchMath {
    /// @notice min(a, b). Cost: 2 ops (lt, select).
    function min(euint256 a, euint256 b) internal returns (euint256) {
        return Nox.select(Nox.lt(a, b), a, b);
    }

    /// @notice max(a, b). Cost: 2 ops (gt, select).
    function max(euint256 a, euint256 b) internal returns (euint256) {
        return Nox.select(Nox.gt(a, b), a, b);
    }

    /// @notice |a - b|, underflow-safe. Cost: 4 ops (ge, select, select, sub).
    /// @dev Prefer `netOf` when the minimum is also needed — it is one op cheaper
    ///      and returns both values.
    function absDiff(euint256 a, euint256 b) internal returns (euint256) {
        ebool aBigger = Nox.ge(a, b);
        euint256 hi = Nox.select(aBigger, a, b);
        euint256 lo = Nox.select(aBigger, b, a);
        return Nox.sub(hi, lo);
    }

    /// @notice The batch netting primitive: crossed volume and residual in one pass.
    /// @param totalBuy  Aggregate encrypted buy-side volume, base units.
    /// @param totalSell Aggregate encrypted sell-side volume, base units.
    /// @return crossed  min(totalBuy, totalSell) — internalised, never touches the pool.
    /// @return residual |totalBuy - totalSell| — the only value that becomes public.
    /// @return sellSide Encrypted true if the residual must be *sold* into the pool.
    ///
    /// @dev Cost: 5 ops (lt, select, sub, sub, add) versus 7 for a naive
    ///      `min` + `absDiff` + `gt`. At ~6 ops per intent for aggregation, this
    ///      saving is small in isolation but `netOf` runs inside `closeBatch`,
    ///      which we need to keep O(1) — see build.md §2.6.
    ///
    ///      The residual trick: because `crossed` is the minimum, exactly one of
    ///      `totalBuy - crossed` and `totalSell - crossed` is zero and the other
    ///      is the true residual. Adding them yields |a-b| with no second
    ///      comparison and no underflow, reusing the `crossed` we already needed.
    ///
    ///      `sellSide` is the *same* `ebool` that produced `crossed`, so the
    ///      direction costs nothing. Nox exposes no boolean negation, which is
    ///      why this returns sell-orientation rather than buy-orientation —
    ///      taking the free handle instead of paying an op to invert it.
    ///
    ///      When the batch is perfectly balanced, `residual` is zero and
    ///      `sellSide` is meaningless. The caller MUST branch on R == 0 and
    ///      price from the TWAP oracle instead (build.md §3, F8).
    function netOf(euint256 totalBuy, euint256 totalSell)
        internal
        returns (euint256 crossed, euint256 residual, ebool sellSide)
    {
        sellSide = Nox.lt(totalBuy, totalSell);
        crossed = Nox.select(sellSide, totalBuy, totalSell);
        residual = Nox.add(Nox.sub(totalBuy, crossed), Nox.sub(totalSell, crossed));
    }

    /// @notice Grant this contract and `user` persistent access to `v`.
    /// @dev The single most common Nox bug is omitting these after an operation:
    ///      transient ACLs are wiped at end-of-transaction, so a handle without
    ///      an explicit grant is permanently unreadable from the next block on
    ///      (build.md §8, trap 2). Call this after *every* derived handle.
    function share(euint256 v, address user) internal {
        Nox.allowThis(v);
        Nox.allow(v, user);
    }
}
