// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// @notice Minimal local interface for a Uniswap v3 pool. See ISwapRouter02 for
///         why these are hand-written rather than imported.
interface IUniswapV3Pool {
    /// @notice Current pool state.
    /// @dev DO NOT price a batch from `sqrtPriceX96`. Spot is manipulable within
    ///      a single block by a flash loan, which would let an attacker force a
    ///      zero-residual batch to clear at an arbitrary price (build.md F8).
    ///      Use `observe` instead. This is exposed only for display and for
    ///      asserting TWAP deviation bounds.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    /// @notice Cumulative tick observations, for TWAP derivation.
    /// @param secondsAgos Lookback points, e.g. [1800, 0] for a 30-minute TWAP.
    /// @dev The manipulation-resistant price source. Used to price the
    ///      zero-residual case and to bound the keeper's `minOut` (build.md F6).
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);

    function token0() external view returns (address);

    function token1() external view returns (address);

    function fee() external view returns (uint24);
}
