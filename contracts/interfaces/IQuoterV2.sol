// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// @notice Minimal local interface for Uniswap v3 QuoterV2.
///
/// Used only to compute each participant's counterfactual solo fill, which is
/// how the savings figure in build.md §3 is produced. Note QuoterV2 is NOT a
/// view function — it reverts internally and decodes the revert data, so it must
/// be called off-chain or via `staticcall` from a non-view context.
///
/// Sepolia: 0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3
interface IQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );
}
