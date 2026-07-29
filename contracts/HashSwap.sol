// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Nox, euint256, ebool, externalEuint256, externalEbool}
    from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

import {HashSwapVault} from "./HashSwapVault.sol";
import {BatchMath} from "./lib/BatchMath.sol";
import {UniswapAdapter} from "./lib/UniswapAdapter.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";

/// @title HashSwap
/// @notice Confidential batch-netting over an unmodified Uniswap v3 pool.
///
/// Users submit encrypted swap intents. The contract aggregates them into an
/// encrypted batch, crosses offsetting orders internally, and decrypts and
/// settles only the *net residual* against the real pool. All participants clear
/// at one uniform price.
///
/// ## The only number that ever becomes public
///
/// `R = |totalBuy - totalSell|`, plus its direction. Individual intent amounts
/// and sides never are. The residual must be public because Uniswap takes a
/// plain `uint256` — that is the design, not a leak (build.md §2.2).
///
/// ## Settlement is two transactions
///
/// `closeBatch()` computes R privately and marks it publicly decryptable. An
/// off-chain keeper fetches the plaintext plus a gateway-signed proof, then calls
/// `settle()`, which verifies the proof on-chain before touching Uniswap. **The
/// keeper cannot forge a residual.** It can, however, choose when to submit —
/// keeper honesty is enforced cryptographically, keeper ordering only
/// economically, via the TWAP-derived slippage bound (build.md F6).
///
/// ## Amount denomination
///
/// All intents are in *base* token units with an encrypted side flag, so
/// `min(buy, sell)` is well defined — you cannot take the minimum of "8 ETH" and
/// "20,000 USDC". Buyers therefore lock quote at submit time using a public
/// reference price plus a buffer, and are refunded the unused portion at
/// settlement.
contract HashSwap is HashSwapVault {
    using BatchMath for euint256;

    uint256 public constant WAD = 1e18;

    /// @dev Buyers lock 105% of the reference cost. If the clearing price drifts
    ///      above the buffer their fill is clamped to what they locked, which
    ///      under-fills them rather than making the contract insolvent. An
    ///      encrypted limit price (build.md Stage 6) is the real fix.
    uint256 public constant BUFFER_BPS = 10_500;

    /// @dev Below this, a batch reveals too much: at N=1 the residual *is* that
    ///      user's entire trade. The anonymity set is the batch size, so this is
    ///      a correctness requirement rather than a tuning knob (build.md F2).
    uint32 public constant MIN_BATCH_SIZE = 3;
    uint32 public constant MAX_BATCH_SIZE = 8;

    uint64 public constant BATCH_WINDOW = 60 seconds;

    /// @dev After this long unsettled, anyone may cancel and refund the batch.
    ///      Without it a dead keeper or an unresolvable handle locks funds
    ///      forever (build.md F4 / invariant I8).
    uint64 public constant SETTLE_TIMEOUT = 1 hours;

    enum Status { Open, Closed, Settled, Cancelled }

    struct Intent {
        address user;
        bytes32 amount;      // euint256, base units, zero if unfunded
        bytes32 isBuy;       // ebool
        bytes32 quoteLocked; // euint256, buffered quote debited (zero for sells)
        bool withdrawn;
    }

    /// @dev Encrypted constants shared across one batch's fills.
    struct FillCtx {
        euint256 zero;
        euint256 priceWad;
        euint256 wad;
        euint256 bps;
        euint256 feeRate;
        address mk;
        uint16 feeBps;
    }

    struct Batch {
        uint64 openedAt;
        uint64 closedAt;
        uint32 count;
        Status status;
        bytes32 totalBuy;
        bytes32 totalSell;
        bytes32 residualHandle;
        bytes32 sellSideHandle;
        uint256 refPrice;      // public reference at open, WAD quote per base
        uint256 residual;      // plaintext, after settle
        uint256 clearingPrice; // WAD, after settle
        bool residualIsSell;
    }

    address public immutable baseToken;
    address public immutable quoteToken;
    uint24 public immutable poolFee;
    ISwapRouter02 public immutable swapRouter;

    /// @notice Who may configure the maker. Set once, at deployment.
    address public immutable owner;

    /// @notice Market maker of last resort — an address paid to always be on the
    ///         other side of a batch so it clears instead of waiting for
    ///         strangers. Optional: zero disables the mechanism entirely.
    ///
    /// @dev **This trades privacy for liveness and the tradeoff must be
    ///      disclosed.** A maker padding a batch that contains one real user can
    ///      subtract its own orders and derive that user's position exactly. The
    ///      public still learns nothing; the maker learns everything. That is the
    ///      same bargain an RFQ dealer offers, and it is only honest if stated.
    address public maker;

    /// @notice Spread taken around the clearing price, in basis points, paid to
    ///         the maker. Capped so the operator cannot quietly tax a batch to
    ///         death.
    uint16 public makerFeeBps;

    uint16 public constant MAX_MAKER_FEE_BPS = 50; // 0.5%

    uint256 public currentBatchId;
    mapping(uint256 => Batch) private _batches;
    mapping(uint256 => Intent[]) private _intents;

    event BatchOpened(uint256 indexed batchId, uint256 refPrice);
    event IntentSubmitted(uint256 indexed batchId, address indexed user, uint256 index);
    event IntentWithdrawn(uint256 indexed batchId, address indexed user, uint256 index);
    event BatchClosed(uint256 indexed batchId, bytes32 residualHandle, bytes32 sellSideHandle);
    event BatchSettled(
        uint256 indexed batchId, uint256 residual, bool residualIsSell, uint256 clearingPrice
    );
    event BatchCancelled(uint256 indexed batchId);
    event MakerUpdated(address indexed maker, uint16 feeBps);
    event MakerPaid(uint256 indexed batchId, address indexed maker);
    event BatchRolledOver(uint256 indexed batchId, uint32 count);

    error BatchNotOpen();
    error BatchNotClosed();
    error NotIntentOwner();
    error IntentAlreadyWithdrawn();
    error BatchFull();
    error WindowNotElapsed();
    error TimeoutNotElapsed();
    error ResidualMismatch();
    error NotOwner();
    error FeeTooHigh();

    constructor(
        address baseToken_,
        address quoteToken_,
        uint24 poolFee_,
        ISwapRouter02 swapRouter_,
        uint256 initialRefPrice
    ) {
        baseToken = baseToken_;
        quoteToken = quoteToken_;
        poolFee = poolFee_;
        swapRouter = swapRouter_;
        owner = msg.sender;
        _openBatch(initialRefPrice);
    }

    // ------------------------------------------------------------------- admin

    /// @notice Configure the maker of last resort.
    /// @param maker_ Address to pay, or zero to disable the mechanism.
    /// @param feeBps Spread around the clearing price, capped at MAX_MAKER_FEE_BPS.
    function setMaker(address maker_, uint16 feeBps) external {
        if (msg.sender != owner) revert NotOwner();
        if (feeBps > MAX_MAKER_FEE_BPS) revert FeeTooHigh();
        maker = maker_;
        makerFeeBps = feeBps;
        emit MakerUpdated(maker_, feeBps);
    }

    // ------------------------------------------------------------------ intake

    /// @notice Submit an encrypted swap intent. **Moves no tokens.**
    ///
    /// @dev Token movement here would defeat the entire system: an ERC-20
    ///      `Transfer` publishes the amount, and which token moved publishes the
    ///      direction (build.md F1). Intents debit the confidential vault instead.
    ///
    ///      Aggregation is incremental. Each caller pays for their own ~17 Nox
    ///      ops, which keeps `closeBatch()` O(1) no matter how large the batch
    ///      gets. A close that looped over every intent would hit the block gas
    ///      limit almost immediately (build.md §2.6).
    function submitIntent(
        externalEuint256 amountHandle,
        bytes calldata amountProof,
        externalEbool sideHandle,
        bytes calldata sideProof
    ) external returns (uint256 index) {
        Batch storage b = _batches[currentBatchId];
        if (b.status != Status.Open) revert BatchNotOpen();
        if (b.count >= MAX_BATCH_SIZE) revert BatchFull();

        euint256 amount = Nox.fromExternal(amountHandle, amountProof);
        ebool isBuy = Nox.fromExternal(sideHandle, sideProof);

        euint256 zero = Nox.toEuint256(0);
        euint256 wantBuy = Nox.select(isBuy, amount, zero);
        euint256 wantSell = Nox.select(isBuy, zero, amount);

        // Sellers post base collateral. `_debit` yields zero on insufficient
        // funds rather than reverting, so an unfunded intent silently
        // contributes nothing instead of poisoning the batch (build.md F7).
        (euint256 effectiveSell,) = _debit(baseToken, msg.sender, wantSell);

        // Buyers lock quote at the reference price plus a buffer.
        euint256 quoteNeeded = Nox.div(
            Nox.mul(wantBuy, Nox.toEuint256(b.refPrice * BUFFER_BPS / 10_000)),
            Nox.toEuint256(WAD)
        );
        (euint256 quoteLocked, ebool quoteOk) = _debit(quoteToken, msg.sender, quoteNeeded);

        // A buy the user could not collateralise must not count toward the batch.
        euint256 effectiveBuy = Nox.select(quoteOk, wantBuy, zero);

        b.totalBuy = euint256.unwrap(Nox.add(euint256.wrap(b.totalBuy), effectiveBuy));
        b.totalSell = euint256.unwrap(Nox.add(euint256.wrap(b.totalSell), effectiveSell));
        Nox.allowThis(euint256.wrap(b.totalBuy));
        Nox.allowThis(euint256.wrap(b.totalSell));

        euint256 recorded = Nox.add(effectiveBuy, effectiveSell);
        BatchMath.share(recorded, msg.sender);
        BatchMath.share(quoteLocked, msg.sender);
        Nox.allowThis(isBuy);
        Nox.allow(isBuy, msg.sender);

        index = _intents[currentBatchId].length;
        _intents[currentBatchId].push(
            Intent({
                user: msg.sender,
                amount: euint256.unwrap(recorded),
                isBuy: ebool.unwrap(isBuy),
                quoteLocked: euint256.unwrap(quoteLocked),
                withdrawn: false
            })
        );
        b.count++;

        emit IntentSubmitted(currentBatchId, msg.sender, index);
    }

    /// @notice Pull an intent out of a batch that has not closed yet, and get the
    ///         posted collateral back.
    ///
    /// @dev Without this a user can be stranded. `closeBatch` refuses to settle a
    ///      batch below `MIN_BATCH_SIZE` and rolls the window instead, so in a
    ///      quiet market an intent can sit in a perpetually-rolling batch with its
    ///      collateral debited and no way out — `cancelBatch` only applies once a
    ///      batch is Closed. This is the escape hatch for that case.
    ///
    ///      Withdrawal is public: it reveals that this address left the batch, but
    ///      not the amount or the side. Both totals are decremented branchlessly,
    ///      so which one actually moved stays hidden.
    function withdrawIntent(uint256 batchId, uint256 index) external {
        Batch storage b = _batches[batchId];
        if (b.status != Status.Open) revert BatchNotOpen();

        Intent storage it = _intents[batchId][index];
        if (it.user != msg.sender) revert NotIntentOwner();
        if (it.withdrawn) revert IntentAlreadyWithdrawn();
        it.withdrawn = true;

        euint256 amount = euint256.wrap(it.amount);
        ebool isBuy = ebool.wrap(it.isBuy);
        euint256 zero = Nox.toEuint256(0);

        euint256 buyPart = Nox.select(isBuy, amount, zero);
        euint256 sellPart = Nox.select(isBuy, zero, amount);

        b.totalBuy = euint256.unwrap(Nox.sub(euint256.wrap(b.totalBuy), buyPart));
        b.totalSell = euint256.unwrap(Nox.sub(euint256.wrap(b.totalSell), sellPart));
        Nox.allowThis(euint256.wrap(b.totalBuy));
        Nox.allowThis(euint256.wrap(b.totalSell));

        // Return exactly what was posted: base for a sell, locked quote for a buy.
        _credit(baseToken, it.user, sellPart);
        _credit(quoteToken, it.user, euint256.wrap(it.quoteLocked));

        b.count--;
        emit IntentWithdrawn(batchId, msg.sender, index);
    }

    // ------------------------------------------------------------------- close

    /// @notice Net the batch and publish only the residual.
    /// @dev O(1) — the totals were accumulated incrementally at submit time.
    function closeBatch() external {
        uint256 id = currentBatchId;
        Batch storage b = _batches[id];
        if (b.status != Status.Open) revert BatchNotOpen();
        if (block.timestamp < b.openedAt + BATCH_WINDOW && b.count < MAX_BATCH_SIZE) {
            revert WindowNotElapsed();
        }

        // Too few participants to hide anyone. Roll the window rather than
        // settle a batch that would expose its own members (build.md F2).
        if (b.count < MIN_BATCH_SIZE) {
            b.openedAt = uint64(block.timestamp);
            emit BatchRolledOver(id, b.count);
            return;
        }

        (, euint256 residual, ebool sellSide) =
            BatchMath.netOf(euint256.wrap(b.totalBuy), euint256.wrap(b.totalSell));

        Nox.allowThis(residual);
        Nox.allowThis(sellSide);
        Nox.allowPublicDecryption(residual);
        Nox.allowPublicDecryption(sellSide);

        b.residualHandle = euint256.unwrap(residual);
        b.sellSideHandle = ebool.unwrap(sellSide);
        b.closedAt = uint64(block.timestamp);
        b.status = Status.Closed;

        emit BatchClosed(id, b.residualHandle, b.sellSideHandle);
    }

    // ------------------------------------------------------------------ settle

    /// @notice Verify the published residual, swap it, and fill every participant.
    ///
    /// @param residual        Plaintext residual, from the keeper.
    /// @param residualProof   Gateway-signed proof for it.
    /// @param isSell          Plaintext direction.
    /// @param sellSideProof   Gateway-signed proof for the direction.
    /// @param limitAmount     `minOut` for a sell residual, `maxIn` for a buy.
    ///
    /// @dev Both proofs are verified against the handles stored at close, so a
    ///      keeper reporting a false residual reverts here (invariant I7).
    function settle(
        uint256 batchId,
        uint256 residual,
        bytes calldata residualProof,
        bool isSell,
        bytes calldata sellSideProof,
        uint256 limitAmount
    ) external {
        Batch storage b = _batches[batchId];
        if (b.status != Status.Closed) revert BatchNotClosed();

        uint256 verifiedResidual =
            Nox.publicDecrypt(euint256.wrap(b.residualHandle), residualProof);
        bool verifiedIsSell = Nox.publicDecrypt(ebool.wrap(b.sellSideHandle), sellSideProof);
        if (verifiedResidual != residual || verifiedIsSell != isSell) revert ResidualMismatch();

        uint256 clearingPrice;
        if (residual == 0) {
            // Perfect coincidence of wants: nothing touches Uniswap at all. Price
            // from the reference rather than an execution that never happened.
            // Production must read a TWAP here, never `slot0` — spot is
            // flash-manipulable within a block (build.md F8).
            clearingPrice = b.refPrice;
        } else if (isSell) {
            uint256 quoteOut = UniswapAdapter.swapExactIn(
                swapRouter, baseToken, quoteToken, poolFee, residual, limitAmount, address(this)
            );
            clearingPrice = quoteOut * WAD / residual;
        } else {
            uint256 quoteIn = UniswapAdapter.swapExactOut(
                swapRouter, quoteToken, baseToken, poolFee, residual, limitAmount, address(this)
            );
            clearingPrice = quoteIn * WAD / residual;
        }

        b.residual = residual;
        b.residualIsSell = isSell;
        b.clearingPrice = clearingPrice;
        b.status = Status.Settled;

        _distribute(batchId, clearingPrice);
        _openBatch(clearingPrice);

        emit BatchSettled(batchId, residual, isSell, clearingPrice);
    }

    /// @dev Fill every participant at the single clearing price.
    ///
    ///      Uniform pricing means no participant gains from position in the
    ///      batch. It does NOT mean every participant beats a solo trade: in a
    ///      one-sided batch (`crossed == 0`) a small trader pays the aggregate's
    ///      average price, which is worse than trading alone. Crossed volume
    ///      always wins; the residual is fair, not free (build.md F5).
    ///
    ///      When a maker is configured, a spread is taken around `P_clear`:
    ///      sellers receive slightly less, buyers pay slightly more, and the
    ///      difference accrues to the maker. That is what pays someone to always
    ///      be on the other side, so a batch clears instead of waiting for
    ///      strangers who may never arrive.
    function _distribute(uint256 batchId, uint256 clearingPrice) private {
        Intent[] storage list = _intents[batchId];

        // Shared encrypted constants live in a memory struct so the per-intent
        // work can sit in its own stack frame. Inlining it all blows the Yul
        // stack limit — every Nox op holds a live local, and there are a dozen
        // per fill.
        FillCtx memory c = FillCtx({
            zero: Nox.toEuint256(0),
            priceWad: Nox.toEuint256(clearingPrice),
            wad: Nox.toEuint256(WAD),
            bps: Nox.toEuint256(10_000),
            feeRate: Nox.toEuint256(makerFeeBps),
            mk: maker,
            feeBps: makerFeeBps
        });

        euint256 accrued = c.zero;
        bool anyFee = false;

        for (uint256 i = 0; i < list.length; i++) {
            if (list[i].withdrawn) continue; // already refunded at withdrawal

            (euint256 fee, bool charged) = _fillOne(list[i], c);
            if (charged) {
                accrued = Nox.add(accrued, fee);
                anyFee = true;
            }
        }

        if (anyFee) {
            _credit(quoteToken, c.mk, accrued);
            emit MakerPaid(batchId, c.mk);
        }
    }

    /// @dev Fill a single participant, returning the maker spread taken from it.
    function _fillOne(Intent storage it, FillCtx memory c)
        private
        returns (euint256 fee, bool charged)
    {
        euint256 amount = euint256.wrap(it.amount);
        ebool isBuy = ebool.wrap(it.isBuy);

        euint256 quoteValue = Nox.div(Nox.mul(amount, c.priceWad), c.wad);
        euint256 sellerGets = quoteValue;
        euint256 buyerOwes = quoteValue;

        // The maker does not pay the spread it earns. This branches on a plain
        // address, not on ciphertext — who the maker is was never secret, so no
        // encrypted comparison is needed.
        charged = c.feeBps > 0 && c.mk != address(0) && it.user != c.mk;
        if (charged) {
            fee = Nox.div(Nox.mul(quoteValue, c.feeRate), c.bps);
            sellerGets = Nox.sub(quoteValue, fee);
            buyerOwes = Nox.add(quoteValue, fee);
        }

        // Buyer receives base and is refunded the unspent portion of the lock.
        // `safeSub` clamps so a clearing price beyond the buffer under-refunds
        // rather than making the vault insolvent.
        (ebool refundOk, euint256 refundRaw) = Nox.safeSub(euint256.wrap(it.quoteLocked), buyerOwes);
        euint256 refund = Nox.select(refundOk, refundRaw, c.zero);

        _credit(baseToken, it.user, Nox.select(isBuy, amount, c.zero));
        _credit(quoteToken, it.user, Nox.select(isBuy, refund, sellerGets));
    }

    // ------------------------------------------------------------------ cancel

    /// @notice Refund a batch that never settled.
    /// @dev Permissionless and time-gated. This is the answer to "what if the
    ///      keeper dies?" — the first production-readiness question anyone asks
    ///      (build.md F4, invariant I8).
    function cancelBatch(uint256 batchId) external {
        Batch storage b = _batches[batchId];
        if (b.status != Status.Closed) revert BatchNotClosed();
        if (block.timestamp < b.closedAt + SETTLE_TIMEOUT) revert TimeoutNotElapsed();

        Intent[] storage list = _intents[batchId];
        euint256 zero = Nox.toEuint256(0);

        for (uint256 i = 0; i < list.length; i++) {
            Intent storage it = list[i];
            if (it.withdrawn) continue; // already refunded at withdrawal time

            euint256 amount = euint256.wrap(it.amount);
            ebool isBuy = ebool.wrap(it.isBuy);

            // Return exactly what was posted: base for sellers, locked quote for
            // buyers. No swap happened, so nothing is netted.
            _credit(baseToken, it.user, Nox.select(isBuy, zero, amount));
            _credit(quoteToken, it.user, euint256.wrap(it.quoteLocked));
        }

        b.status = Status.Cancelled;
        if (batchId == currentBatchId) _openBatch(b.refPrice);

        emit BatchCancelled(batchId);
    }

    // ---------------------------------------------------------------- internals

    function _openBatch(uint256 refPrice) private {
        uint256 id = ++currentBatchId;
        Batch storage b = _batches[id];
        b.openedAt = uint64(block.timestamp);
        b.status = Status.Open;
        b.refPrice = refPrice;

        euint256 zero = Nox.toEuint256(0);
        b.totalBuy = euint256.unwrap(zero);
        b.totalSell = euint256.unwrap(zero);

        emit BatchOpened(id, refPrice);
    }

    // ------------------------------------------------------------------- views

    function getBatch(uint256 batchId) external view returns (Batch memory) {
        return _batches[batchId];
    }

    function intentCount(uint256 batchId) external view returns (uint256) {
        return _intents[batchId].length;
    }

    function getIntent(uint256 batchId, uint256 index) external view returns (Intent memory) {
        return _intents[batchId][index];
    }
}
