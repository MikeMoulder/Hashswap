// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IUniswapV3Pool} from "../interfaces/IUniswapV3Pool.sol";

/// @title PoolOracle
/// @notice Reads a batch's reference price from the pool it will settle against.
///
/// **Why this exists.** A batch used to inherit its reference price from the
/// last batch that successfully settled. That made pricing a function of the
/// contract's own trading history rather than of the market: when settlement
/// stopped, pricing froze, and frozen pricing is exactly what prevents
/// settlement. A market could therefore drift out of its own price band and
/// never get back — `cancelBatch` reopened the successor at the same stale
/// reference, so every batch inherited the failure. On Sepolia one market
/// reached 60% away from its pool and could no longer clear a buy of any size,
/// down to dust.
///
/// Reading the pool at open makes staleness structurally impossible. The
/// reference is at most one batch window old rather than unboundedly old, and a
/// failed batch can no longer poison its successor.
///
/// ## Why spot, and why that is safe here
///
/// The price itself comes from `slot0`, which is spot and manipulable within a
/// single block. It is used only after `observe` confirms spot sits within
/// `MAX_TICK_DEVIATION` of the time-weighted mean over `WINDOW`. Moving spot far
/// enough to matter therefore means holding it there across the whole window,
/// against arbitrage, which is the property the TWAP is for.
///
/// The comparison is done in tick space on purpose. Ticks are what `observe`
/// already returns, and comparing them needs no conversion — which is what lets
/// this file avoid `TickMath` and 512-bit `FullMath` entirely. Converting a tick
/// to a price would need both, and both are exact, unforgiving, and silent when
/// mistranscribed.
library PoolOracle {
    /// @dev Averaging window for the manipulation check. Long enough that
    ///      holding a false price across it is expensive, short enough that the
    ///      reference still tracks a moving market.
    uint32 internal constant WINDOW = 600; // 10 minutes

    /// @dev How far spot may sit from the mean before the reading is refused.
    ///      A tick is 1.0001x, so 200 ticks is very close to 2%.
    int24 internal constant MAX_TICK_DEVIATION = 200;

    /// @dev Squaring `sqrtPriceX96` must not overflow. This bound is not a
    ///      practical restriction — it permits any raw price ratio below 2**64,
    ///      which covers every realistic pair and decimal combination — but
    ///      reverting is the correct response to a pool outside it, rather than
    ///      wrapping silently.
    error PriceOutOfRange();

    /// @notice Reference price for `base`/`quote`, WAD-scaled, or `ok == false`
    ///         when the pool cannot currently be trusted to give one.
    ///
    /// @return ok    False when spot has moved too far from the mean, or the
    ///               pool has no usable history. The caller must then fall back
    ///               rather than revert: this is on the path of `settle` and
    ///               `cancelBatch`, and a manipulated pool must not be able to
    ///               wedge a batch that is trying to clear or refund.
    /// @return price Raw quote per raw base, times 1e18. Token decimals need no
    ///               special handling — they are already carried by the raw
    ///               ratio the pool stores.
    function refPrice(IUniswapV3Pool pool, address base)
        internal
        view
        returns (bool ok, uint256 price)
    {
        (uint160 sqrtPriceX96, int24 tick,, uint16 cardinality,,,) = pool.slot0();

        // A pool with a single observation cannot answer `observe` honestly: it
        // extrapolates from the current tick, so the "mean" it returns is spot
        // wearing a costume and the deviation check below would compare a value
        // against itself. Refuse rather than accept a check that cannot fail.
        if (cardinality < 2) return (false, 0);

        uint32[] memory ago = new uint32[](2);
        ago[0] = WINDOW;
        ago[1] = 0;

        // `observe` reverts when the window predates the pool's oldest
        // observation. That is a young or sparsely traded pool, not an attack.
        try pool.observe(ago) returns (int56[] memory cumulatives, uint160[] memory) {
            int56 delta = cumulatives[1] - cumulatives[0];
            int24 meanTick = int24(delta / int56(uint56(WINDOW)));

            // Round toward negative infinity, matching Uniswap's own convention
            // for negative ticks. Without this a negative mean is biased one
            // tick high, which is not material to the comparison but makes the
            // value disagree with every other tool that reads the same pool.
            if (delta < 0 && (delta % int56(uint56(WINDOW)) != 0)) meanTick--;

            int24 drift = tick > meanTick ? tick - meanTick : meanTick - tick;
            if (drift > MAX_TICK_DEVIATION) return (false, 0);
        } catch {
            return (false, 0);
        }

        return (true, _priceFromSqrt(sqrtPriceX96, pool, base));
    }

    /// @dev Convert `sqrtPriceX96` to a WAD-scaled quote-per-base price.
    ///
    ///      The pool stores sqrt(token1/token0) in Q64.96. Squaring recovers the
    ///      ratio in Q128.192; the shifts below step down to WAD without ever
    ///      needing a 512-bit intermediate, which is what keeps `FullMath` out
    ///      of this file. Shifting before scaling costs low-order bits and
    ///      retains about 2**96 of precision on the ratio — far more than the
    ///      1e18 that survives into the result.
    function _priceFromSqrt(uint160 sqrtPriceX96, IUniswapV3Pool pool, address base)
        private
        view
        returns (uint256)
    {
        if (sqrtPriceX96 >= type(uint128).max) revert PriceOutOfRange();

        uint256 ratioX192 = uint256(sqrtPriceX96) * uint256(sqrtPriceX96);

        // token0/token1 ordering is by address and says nothing about which side
        // is the base, so the ratio has to be inverted for half of all pairs.
        if (base == pool.token0()) {
            // price = (ratio / 2**192) * 1e18
            return ((ratioX192 >> 96) * 1e18) >> 96;
        }
        // price = (2**192 / ratio) * 1e18, kept in one expression so the
        // division happens last and no precision is thrown away first.
        return (1e18 << 192) / ratioX192;
    }
}
