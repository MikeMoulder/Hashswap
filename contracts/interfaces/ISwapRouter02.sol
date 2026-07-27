// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

/// @notice Minimal local interface for Uniswap v3 SwapRouter02.
///
/// Hand-written rather than imported. The Uniswap v3-periphery package is
/// pinned to Solidity 0.7.6 and Nox requires ^0.8.35 — the two cannot compile in
/// one project (build.md §4). We need exactly one function, so a local interface
/// is both the only option and the honest one.
///
/// Sepolia: 0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct ExactOutputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountOut;
        uint256 amountInMaximum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Used when the batch residual is a net *sell* of the base token.
    /// @dev This and `exactOutputSingle` are the entire surface area of our
    ///      integration. Uniswap is unmodified, unforked, and unaware of us.
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);

    /// @notice Used when the residual is a net *buy*.
    /// @dev The residual is denominated in base units, so a net buy needs an
    ///      exact-output swap: we must acquire precisely R base tokens, and the
    ///      quote spent is whatever the pool charges. That quote amount is what
    ///      sets the batch clearing price.
    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        payable
        returns (uint256 amountIn);
}
