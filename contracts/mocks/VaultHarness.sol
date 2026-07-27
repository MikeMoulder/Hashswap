// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {Nox, euint256, ebool} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {HashSwapVault} from "../HashSwapVault.sol";

/// @notice Test-only concrete instance of the abstract vault, exposing the
///         internal credit/debit paths that `HashSwap` will drive in Stage 2.
contract VaultHarness is HashSwapVault {
    bytes32 public lastEffective;
    bytes32 public lastOk;

    function debit(address token, address user, uint256 amount) external {
        (euint256 effective, ebool ok) = _debit(token, user, Nox.toEuint256(amount));
        lastEffective = euint256.unwrap(effective);
        lastOk = ebool.unwrap(ok);
    }

    function credit(address token, address user, uint256 amount) external {
        _credit(token, user, Nox.toEuint256(amount));
    }
}
