// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapRouter02} from "../interfaces/ISwapRouter02.sol";

/// @notice Deterministic constant-product stand-in for Uniswap v3's SwapRouter02.
///
/// Real v3 concentrated liquidity is not reproduced — this is `x·y=k` with a
/// flat fee. That is enough to exercise settlement logic and to make slippage
/// *directionally* real, so the netting benefit is measurable in tests. The
/// actual price improvement numbers quoted in the demo must come from a real
/// pool (a fork or Sepolia), not from here.
contract MockSwapRouter is ISwapRouter02 {
    using SafeERC20 for IERC20;

    mapping(address => uint256) public reserves;
    uint256 public feeBps = 30; // 0.3%, matching the common v3 tier

    function seed(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        reserves[token] += amount;
    }

    /// @notice Constant-product quote, fee taken on the input.
    function quote(address tokenIn, address tokenOut, uint256 amountIn)
        public
        view
        returns (uint256)
    {
        uint256 rIn = reserves[tokenIn];
        uint256 rOut = reserves[tokenOut];
        if (rIn == 0 || rOut == 0 || amountIn == 0) return 0;
        uint256 amountInAfterFee = amountIn * (10_000 - feeBps) / 10_000;
        return (rOut * amountInAfterFee) / (rIn + amountInAfterFee);
    }

    /// @notice Inverse constant-product: input required for an exact output.
    function quoteIn(address tokenIn, address tokenOut, uint256 amountOut)
        public
        view
        returns (uint256)
    {
        uint256 rIn = reserves[tokenIn];
        uint256 rOut = reserves[tokenOut];
        if (rIn == 0 || rOut == 0 || amountOut == 0 || amountOut >= rOut) return type(uint256).max;
        uint256 inAfterFee = (rIn * amountOut) / (rOut - amountOut) + 1;
        return inAfterFee * 10_000 / (10_000 - feeBps) + 1;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        amountOut = quote(params.tokenIn, params.tokenOut, params.amountIn);
        require(amountOut >= params.amountOutMinimum, "MockSwapRouter: slippage");

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        reserves[params.tokenIn] += params.amountIn;
        reserves[params.tokenOut] -= amountOut;
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }

    function exactOutputSingle(ExactOutputSingleParams calldata params)
        external
        payable
        returns (uint256 amountIn)
    {
        amountIn = quoteIn(params.tokenIn, params.tokenOut, params.amountOut);
        require(amountIn <= params.amountInMaximum, "MockSwapRouter: excessive input");

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        reserves[params.tokenIn] += amountIn;
        reserves[params.tokenOut] -= params.amountOut;
        IERC20(params.tokenOut).safeTransfer(params.recipient, params.amountOut);
    }
}
