// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, euint256, ebool} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {BatchMath} from "../lib/BatchMath.sol";

/// @notice Test-only harness exposing BatchMath over the Nox library.
/// @dev Library functions are `internal` and mutate state through NoxCompute, so
///      they cannot be called directly from a test. This wraps them and stores
///      the resulting handles for inspection.
contract BatchMathHarness {
    euint256 private _totalBuy;
    euint256 private _totalSell;

    bytes32 public crossedHandle;
    bytes32 public residualHandle;
    bytes32 public sellSideHandle;

    /// @dev Seeds via `Nox.toEuint256`, which produces *public* handles. Fine for
    ///      a math harness; never do this with user data in the real protocol —
    ///      a trivially-encrypted value carries no ACL and anyone can read it.
    function seed(uint256 buy, uint256 sell) external {
        _totalBuy = Nox.toEuint256(buy);
        _totalSell = Nox.toEuint256(sell);
        Nox.allowThis(_totalBuy);
        Nox.allowThis(_totalSell);
    }

    function runNetOf() external {
        (euint256 crossed, euint256 residual, ebool sellSide) =
            BatchMath.netOf(_totalBuy, _totalSell);

        Nox.allowThis(crossed);
        Nox.allowThis(residual);
        Nox.allowThis(sellSide);

        crossedHandle = euint256.unwrap(crossed);
        residualHandle = euint256.unwrap(residual);
        sellSideHandle = ebool.unwrap(sellSide);
    }

    function runMin() external returns (bytes32) {
        euint256 m = BatchMath.min(_totalBuy, _totalSell);
        Nox.allowThis(m);
        return euint256.unwrap(m);
    }

    function runAbsDiff() external returns (bytes32) {
        euint256 d = BatchMath.absDiff(_totalBuy, _totalSell);
        Nox.allowThis(d);
        return euint256.unwrap(d);
    }
}
