// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IUniswapV3Pool} from "../interfaces/IUniswapV3Pool.sol";

/// @notice Stand-in for a Uniswap v3 pool's oracle surface.
///
/// @dev Deliberately stores a real `sqrtPriceX96` rather than the WAD price the
///      tests think in, so `PoolOracle` runs its actual Q64.96 conversion
///      instead of a stub. A mock that returned the answer directly would pass
///      whether or not that conversion were correct, which is the one thing
///      here worth testing.
///
///      `setPrice` therefore converts in the opposite direction, and the tests
///      assert the round trip lands back where it started.
contract MockUniswapV3Pool is IUniswapV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint24 public immutable fee;

    uint160 private _sqrtPriceX96;
    int24 private _tick;
    int24 private _meanTick;
    uint16 private _cardinality = 100;
    bool private _observeReverts;

    constructor(address tokenA, address tokenB, uint24 fee_, uint256 priceWad, address base) {
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        fee = fee_;
        setPrice(priceWad, base);
    }

    /// @notice Set the pool price, given as WAD quote-per-base.
    function setPrice(uint256 priceWad, address base) public {
        require(priceWad != 0, "price=0");
        // ratio = token1 per token0, in raw units, as PoolOracle reads it.
        uint256 ratioX96 = base == token0
            ? (priceWad << 96) / 1e18
            : (uint256(1e18) << 96) / priceWad;
        // sqrt(ratio * 2**96) == sqrt(ratio) * 2**48, then shift up to Q96.
        _sqrtPriceX96 = uint160(_sqrt(ratioX96) << 48);
    }

    /// @notice Move spot away from the mean without moving the mean, which is
    ///         what a manipulation attempt looks like to `PoolOracle`.
    function setTicks(int24 spot, int24 mean) external {
        _tick = spot;
        _meanTick = mean;
    }

    function setCardinality(uint16 c) external {
        _cardinality = c;
    }

    function setObserveReverts(bool v) external {
        _observeReverts = v;
    }

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (_sqrtPriceX96, _tick, 0, _cardinality, _cardinality, 0, true);
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory liq)
    {
        require(!_observeReverts, "OLD");
        tickCumulatives = new int56[](2);
        liq = new uint160[](2);
        tickCumulatives[0] = 0;
        // Chosen so that (tc[1] - tc[0]) / window == _meanTick exactly.
        tickCumulatives[1] = int56(_meanTick) * int56(uint56(secondsAgos[0]));
    }

    function _sqrt(uint256 x) private pure returns (uint256 y) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
    }
}
