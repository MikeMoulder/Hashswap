// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A token that burns a percentage of every transfer.
///
/// Exists to pin one regression: `HashSwapVault.deposit` must credit what the
/// contract actually received, not what the caller asked to send. Crediting the
/// request against a token like this mints vault balance out of nothing, and the
/// shortfall only surfaces when the last user tries to withdraw.
contract MockFeeToken is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) ERC20("Fee", "FEE") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from == address(0) || to == address(0)) {
            super._update(from, to, value);
            return;
        }
        uint256 fee = value * feeBps / 10_000;
        super._update(from, to, value - fee);
        super._update(from, address(0), fee); // burned
    }
}
