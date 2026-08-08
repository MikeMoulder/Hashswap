// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Nox, euint256, ebool, externalEuint256, externalEbool}
    from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

import {HashSwapVault} from "./HashSwapVault.sol";
import {BatchMath} from "./lib/BatchMath.sol";
import {UniswapAdapter} from "./lib/UniswapAdapter.sol";
import {PoolOracle} from "./lib/PoolOracle.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";
import {IUniswapV3Pool} from "./interfaces/IUniswapV3Pool.sol";

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

    /// @dev Buyers lock this much of the reference cost at submit time. `settle`
    ///      refuses any clearing price that would exceed what the buffer covers
    ///      (see `MAX_PRICE_DEVIATION_BPS`), so the lock is always sufficient.
    ///
    ///      Derived in the constructor rather than written down, because it is
    ///      not a free parameter: it is a consequence of the band, the pool's
    ///      fee, and the maker fee cap. It used to be a hand-set 10_500 with the
    ///      relationship recorded only in a comment, which is a standing
    ///      invitation to widen the band later and reintroduce the insolvency
    ///      the comment warns about. Now the relationship is computed, and the
    ///      constructor asserts it.
    uint256 public immutable BUFFER_BPS;

    /// @dev The pool's own fee, in basis points. `poolFee` is in hundredths of a
    ///      basis point (10_000 = 1%), which is Uniswap's unit, not ours.
    uint256 public immutable poolFeeBps;

    /// @notice How far the realized clearing price may drift from the batch's
    ///         reference price before settlement is refused, in basis points.
    ///
    /// @dev **This is the solvency bound, not a tuning knob.** Buyers post
    ///      `BUFFER_BPS` of the reference cost and nothing more, while sellers are
    ///      credited at the realized price. If the realized price were allowed
    ///      past what buyers locked, the contract would credit more quote than it
    ///      holds and the last withdrawer would find the vault empty. The bound
    ///      that must hold is
    ///
    ///          (10_000 + MAX_PRICE_DEVIATION_BPS) * (10_000 + MAX_MAKER_FEE_BPS)
    ///              <= BUFFER_BPS * 10_000
    ///
    ///      which the constructor now enforces directly, with the pool's own fee
    ///      as a third factor — see `BUFFER_BPS`. Raising this alone can no
    ///      longer reintroduce the insolvency, because the buffer is computed
    ///      from it rather than maintained alongside it by hand.
    ///
    ///      **This bounds price risk only.** The pool's fee is a known constant,
    ///      not a surprise, and charging it against this band was costing a
    ///      quarter of the budget on a 1% pool for nothing — enough that a 2%
    ///      market move made batches unsettleable. `settle` now adds the fee to
    ///      the execution bounds explicitly and this number means what it says.
    ///
    ///      The lower half of the band protects sellers symmetrically, and
    ///      incidentally makes a zero clearing price unreachable — a zero would
    ///      otherwise propagate into the next batch's reference and let buys
    ///      through with no collateral at all.
    uint16 public constant MAX_PRICE_DEVIATION_BPS = 400; // ±4%

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
        // Maker terms are snapshotted when the batch opens so that the owner
        // cannot change what a participant is charged after they have already
        // committed collateral to this batch.
        address maker;
        uint16 makerFeeBps;
    }

    address public immutable baseToken;
    address public immutable quoteToken;
    uint24 public immutable poolFee;
    ISwapRouter02 public immutable swapRouter;

    /// @dev The pool this market settles against, and now also prices against.
    ///      Validated in the constructor to be the same pool the router will
    ///      route through, so the price a batch is opened at and the price it
    ///      settles at cannot come from different markets.
    IUniswapV3Pool public immutable pool;

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

    /// @notice The closed batch awaiting `settle` or `cancelBatch`, or zero.
    ///
    /// @dev Closing used to be the end of order collection *and* the start of a
    ///      freeze: the next batch was opened at the end of `settle`, so between
    ///      close and settlement `currentBatchId` pointed at a Closed batch and
    ///      every `submitIntent` reverted with `BatchNotOpen`. A batch that could
    ///      not settle — a stale `refPrice` against a drifted pool is enough —
    ///      took the whole market down with it for `SETTLE_TIMEOUT`, because the
    ///      only thing that could reopen trading was the transaction that could
    ///      not be sent.
    ///
    ///      `closeBatch` now opens the successor immediately, so collection never
    ///      stops. This holds the batch still owed a settlement, which is what
    ///      `settle` and `cancelBatch` address instead of `currentBatchId`.
    ///
    ///      Exactly one may be outstanding. Allowing a queue would let a batch
    ///      stuck on a stale reference be followed by more batches inheriting
    ///      that same reference, each one closing into the same unsettleable
    ///      state — a cascade of locked collateral rather than one hour of it.
    ///      Orders keep flowing into the open batch either way; only *closing*
    ///      waits.
    uint256 public pendingSettlement;

    mapping(uint256 => Batch) private _batches;
    mapping(uint256 => Intent[]) private _intents;

    /// @dev One live intent per address per batch.
    ///
    ///      Without this an attacker fills every slot themselves, which costs
    ///      little because `_debit` answers an unfunded intent with zero rather
    ///      than reverting. That locks real users out, and worse, it hands the
    ///      attacker the whole batch: knowing their own orders they can read the
    ///      published residual and recover the position of the one honest
    ///      participant. `MIN_BATCH_SIZE` only bounds the anonymity set if the
    ///      members are distinct parties.
    mapping(uint256 => mapping(address => bool)) private _hasIntent;

    event BatchOpened(uint256 indexed batchId, uint256 refPrice);
    event IntentSubmitted(uint256 indexed batchId, address indexed user, uint256 index);
    event IntentWithdrawn(uint256 indexed batchId, address indexed user, uint256 index);
    event BatchClosed(uint256 indexed batchId, bytes32 residualHandle, bytes32 sellSideHandle);
    event BatchSettled(
        uint256 indexed batchId, uint256 residual, bool residualIsSell, uint256 clearingPrice
    );
    event BatchCancelled(uint256 indexed batchId);
    event BatchRepriced(uint256 indexed batchId, uint256 refPrice);

    /// @notice The pool could not be read when this batch opened, so it fell
    ///         back to an inherited reference price.
    /// @dev Worth alerting on. It means either spot has been pushed away from
    ///      the mean — someone probing the band — or the pool's observation
    ///      history has become too thin to consult. Both are conditions under
    ///      which this market is pricing off history again, which is the
    ///      failure mode the oracle exists to end.
    event ReferencePriceStale(uint256 indexed batchId, uint256 refPrice);
    event MakerUpdated(address indexed maker, uint16 feeBps);
    event MakerPaid(uint256 indexed batchId, address indexed maker);
    event BatchRolledOver(uint256 indexed batchId, uint32 count);

    error BatchNotOpen();
    error BatchNotClosed();
    error NotIntentOwner();
    error BatchFull();
    error WindowNotElapsed();
    error TimeoutNotElapsed();
    error ResidualMismatch();
    error NotOwner();
    error FeeTooHigh();
    error AlreadySubmitted();
    error NotCurrentBatch();
    error SettlementPending(uint256 batchId);
    error PriceOutOfBand(uint256 clearingPrice, uint256 low, uint256 high);
    error InvalidConfig();

    constructor(
        address baseToken_,
        address quoteToken_,
        uint24 poolFee_,
        ISwapRouter02 swapRouter_,
        IUniswapV3Pool pool_,
        uint256 initialRefPrice
    ) {
        // A zero reference price makes `quoteNeeded` zero for every buyer, so
        // buys would join the batch fully collateralised by nothing. The price
        // band keeps a live market away from zero; this keeps a fresh deployment
        // from starting there.
        //
        // `initialRefPrice` is now only a fallback — `_openBatch` prices from
        // the pool — but it still has to be sane, because it is what the market
        // falls back to if the pool is unreadable at the moment of deployment.
        if (
            baseToken_ == address(0) || quoteToken_ == address(0)
                || baseToken_ == quoteToken_ || address(swapRouter_) == address(0)
                || address(pool_) == address(0) || initialRefPrice == 0
        ) revert InvalidConfig();

        // Bind the pool to this market rather than trusting the deployer to pass
        // a matching one. A pool for the wrong pair, or the right pair at the
        // wrong fee tier, would price every batch off an unrelated market while
        // looking entirely healthy — and settlement would route through the
        // correct pool regardless, so the two would silently disagree forever.
        address t0 = pool_.token0();
        address t1 = pool_.token1();
        bool pairMatches = (t0 == baseToken_ && t1 == quoteToken_)
            || (t0 == quoteToken_ && t1 == baseToken_);
        if (!pairMatches || pool_.fee() != poolFee_) revert InvalidConfig();

        baseToken = baseToken_;
        quoteToken = quoteToken_;
        poolFee = poolFee_;
        poolFeeBps = uint256(poolFee_) / 100;
        swapRouter = swapRouter_;
        pool = pool_;
        owner = msg.sender;

        // Buyers must post enough to cover the worst price `settle` will accept:
        // the top of the band, plus the pool's fee, plus the maker's spread.
        // Rounded up — rounding down would leave the last buyer a wei short of
        // the fill they are owed, which is the exact insolvency this guards.
        uint256 worst = (10_000 + uint256(MAX_PRICE_DEVIATION_BPS))
            * (10_000 + poolFeeBps)
            * (10_000 + uint256(MAX_MAKER_FEE_BPS));
        BUFFER_BPS = (worst + (1e8 - 1)) / 1e8;

        _openBatch(initialRefPrice);
    }

    // ------------------------------------------------------------------- admin

    /// @notice Configure the maker of last resort.
    /// @param maker_ Address to pay, or zero to disable the mechanism.
    /// @param feeBps Spread around the clearing price, capped at MAX_MAKER_FEE_BPS.
    ///
    /// @dev Takes effect from the next batch, and additionally applies to the
    ///      open one while it is still empty — otherwise a fresh deployment
    ///      could never configure a maker for its first batch, since the
    ///      constructor opens one.
    ///
    ///      Once anybody has submitted, that batch's terms are frozen. The owner
    ///      must not be able to install a maker, or raise its spread, against
    ///      collateral that was posted under different terms.
    function setMaker(address maker_, uint16 feeBps) external {
        if (msg.sender != owner) revert NotOwner();
        if (feeBps > MAX_MAKER_FEE_BPS) revert FeeTooHigh();

        maker = maker_;
        makerFeeBps = feeBps;

        Batch storage b = _batches[currentBatchId];
        if (b.status == Status.Open && b.count == 0) {
            b.maker = maker_;
            b.makerFeeBps = feeBps;
        }

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
    ) external nonReentrant returns (uint256 index) {
        Batch storage b = _batches[currentBatchId];
        if (b.status != Status.Open) revert BatchNotOpen();
        if (b.count >= MAX_BATCH_SIZE) revert BatchFull();
        if (_hasIntent[currentBatchId][msg.sender]) revert AlreadySubmitted();
        _hasIntent[currentBatchId][msg.sender] = true;

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
                quoteLocked: euint256.unwrap(quoteLocked)
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
    ///
    ///      The entry is removed by swapping the last one into its place rather
    ///      than being tombstoned. A tombstone leaves the slot allocated, so
    ///      repeated submit/withdraw churn would grow `_intents[batchId]` without
    ///      limit — and both `_distribute` and `cancelBatch` walk that array, so
    ///      a long enough one puts settlement *and* the refund path past the
    ///      block gas limit, stranding the collateral the timeout exists to
    ///      rescue. Swapping keeps `_intents[batchId].length == b.count`, which is
    ///      bounded by `MAX_BATCH_SIZE`.
    ///
    ///      Indices therefore shift when someone leaves. A withdrawal racing
    ///      another one can land on a stale index, but it cannot take anyone
    ///      else's intent: the owner check rejects it.
    function withdrawIntent(uint256 batchId, uint256 index) external nonReentrant {
        Batch storage b = _batches[batchId];
        if (b.status != Status.Open) revert BatchNotOpen();

        Intent[] storage list = _intents[batchId];
        Intent memory it = list[index];
        if (it.user != msg.sender) revert NotIntentOwner();

        uint256 last = list.length - 1;
        if (index != last) list[index] = list[last];
        list.pop();

        _hasIntent[batchId][msg.sender] = false;

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

    /// @notice Net the batch, publish only the residual, and open its successor.
    /// @dev O(1) — the totals were accumulated incrementally at submit time.
    ///
    ///      Refuses to close while another batch is still owed a settlement. That
    ///      is a liveness bound, not a safety one: see `pendingSettlement`. The
    ///      open batch keeps accepting orders throughout, so a wait here delays
    ///      one batch's execution rather than halting the market.
    function closeBatch() external nonReentrant {
        uint256 id = currentBatchId;
        Batch storage b = _batches[id];
        if (b.status != Status.Open) revert BatchNotOpen();
        if (pendingSettlement != 0) revert SettlementPending(pendingSettlement);
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
        pendingSettlement = id;

        emit BatchClosed(id, b.residualHandle, b.sellSideHandle);

        // Collection resumes in the same transaction that ended it. The clearing
        // price this batch is about to discover does not exist yet, so the
        // successor inherits this batch's reference and `settle` re-anchors it
        // once there is a real one — see the repricing note there.
        _openBatch(b.refPrice);
    }

    // ------------------------------------------------------------------ settle

    /// @notice Verify the published residual, swap it, and fill every participant.
    ///
    /// @param residual        Plaintext residual, from the keeper.
    /// @param residualProof   Gateway-signed proof for it.
    /// @param isSell          Plaintext direction.
    /// @param sellSideProof   Gateway-signed proof for the direction.
    ///
    /// @dev Both proofs are verified against the handles stored at close, so a
    ///      keeper reporting a false residual reverts here (invariant I7).
    ///
    ///      **The slippage bound is derived here, not supplied.** It used to be a
    ///      caller argument, which meant the caller could pass `minOut = 0` or
    ///      `maxIn = type(uint256).max` and hand the pool an unbounded order —
    ///      and `settle` is permissionless, so "the caller" is anyone. Combined
    ///      with the buyer's fixed collateral that was a drain: move the pool,
    ///      settle into it, and the contract credits sellers at a price no buyer
    ///      funded. The limits now come from the batch's own reference price and
    ///      nobody can widen them.
    ///
    ///      A batch that cannot execute inside the band does not settle at a bad
    ///      price — it reverts, and `cancelBatch` refunds everyone once the
    ///      timeout passes. Refusing to trade is always available; trading at an
    ///      unfunded price is not.
    function settle(
        uint256 batchId,
        uint256 residual,
        bytes calldata residualProof,
        bool isSell,
        bytes calldata sellSideProof
    ) external nonReentrant {
        if (batchId != pendingSettlement) revert NotCurrentBatch();

        Batch storage b = _batches[batchId];
        if (b.status != Status.Closed) revert BatchNotClosed();

        uint256 verifiedResidual =
            Nox.publicDecrypt(euint256.wrap(b.residualHandle), residualProof);
        bool verifiedIsSell = Nox.publicDecrypt(ebool.wrap(b.sellSideHandle), sellSideProof);
        if (verifiedResidual != residual || verifiedIsSell != isSell) revert ResidualMismatch();

        uint256 refPrice = b.refPrice;
        uint256 lowPrice = refPrice * (10_000 - MAX_PRICE_DEVIATION_BPS) / 10_000;
        uint256 highPrice = refPrice * (10_000 + MAX_PRICE_DEVIATION_BPS) / 10_000;

        // The band above bounds price risk. The pool also charges its own fee,
        // which is a known constant rather than a risk, so it is added here
        // instead of being silently subtracted from the band — on a 1% pool that
        // was a quarter of the whole budget, enough that an ordinary 2% market
        // move left batches unable to clear at any size. Buyers' collateral
        // covers exactly this, by construction: see `BUFFER_BPS`.
        uint256 execLow = lowPrice * (10_000 - poolFeeBps) / 10_000;
        uint256 execHigh = highPrice * (10_000 + poolFeeBps) / 10_000;

        // Mark settled before touching Uniswap. The swap is the only external
        // call in this function and the tokens are constructor parameters, so a
        // token with a transfer hook could otherwise re-enter a batch that still
        // reads as Closed and distribute it twice.
        b.status = Status.Settled;

        uint256 clearingPrice;
        if (residual * refPrice / WAD == 0) {
            // Either a perfect coincidence of wants, or a residual worth less
            // than one wei of quote. Neither can be priced by a swap — the first
            // has nothing to swap and the second rounds to nothing — so both take
            // the reference price and leave the pool untouched. The value the
            // contract absorbs by not swapping is, by this test, under one wei.
            clearingPrice = refPrice;
        } else if (isSell) {
            uint256 quoteOut = UniswapAdapter.swapExactIn(
                swapRouter,
                baseToken,
                quoteToken,
                poolFee,
                residual,
                residual * execLow / WAD, // minOut
                address(this)
            );
            clearingPrice = quoteOut * WAD / residual;
        } else {
            uint256 quoteIn = UniswapAdapter.swapExactOut(
                swapRouter,
                quoteToken,
                baseToken,
                poolFee,
                residual,
                residual * execHigh / WAD, // maxIn
                address(this)
            );
            clearingPrice = quoteIn * WAD / residual;
        }

        // The swap's own limit only bounds one side of the band; this closes the
        // other. Sells cannot execute below `lowPrice` but could in principle
        // print above `highPrice`, and buys the reverse.
        if (clearingPrice < execLow || clearingPrice > execHigh) {
            revert PriceOutOfBand(clearingPrice, execLow, execHigh);
        }

        b.residual = residual;
        b.residualIsSell = isSell;
        b.clearingPrice = clearingPrice;
        pendingSettlement = 0;

        _distribute(batchId, clearingPrice);
        _reprice(clearingPrice);

        emit BatchSettled(batchId, residual, isSell, clearingPrice);
    }

    /// @dev Point the open batch at the price that was just discovered.
    ///
    ///      `closeBatch` has to open the successor before this price exists, so
    ///      it seeds it with the closing batch's reference. That reference is one
    ///      batch stale by construction, and staleness is precisely what makes a
    ///      batch unsettleable: the band in `settle` is drawn around `refPrice`,
    ///      and a pool that has moved further than the band is wide can no longer
    ///      be traded against. Left uncorrected, the reference would stop
    ///      tracking the market entirely — every batch inheriting the last
    ///      *opening* price rather than the last *traded* one.
    ///
    ///      Only while the batch is still empty. `submitIntent` sizes a buyer's
    ///      collateral off `refPrice` at the moment they commit, and `settle`
    ///      relies on that collateral covering anything inside the band drawn
    ///      around the same number. Moving it under someone who has already
    ///      posted would break that pairing and, on a downward move, leave the
    ///      buyer holding a lock too small for the fill they are owed.
    ///      A batch that has taken an order keeps the reference it advertised.
    function _reprice(uint256 clearingPrice) private {
        Batch storage open_ = _batches[currentBatchId];
        if (open_.status != Status.Open || open_.count != 0) return;
        open_.refPrice = clearingPrice;
        emit BatchRepriced(currentBatchId, clearingPrice);
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
        Batch storage b = _batches[batchId];

        // Shared encrypted constants live in a memory struct so the per-intent
        // work can sit in its own stack frame. Inlining it all blows the Yul
        // stack limit — every Nox op holds a live local, and there are a dozen
        // per fill.
        //
        // The maker terms come from the batch snapshot, not from live storage:
        // participants are charged what was advertised when they committed.
        FillCtx memory c = FillCtx({
            zero: Nox.toEuint256(0),
            priceWad: Nox.toEuint256(clearingPrice),
            wad: Nox.toEuint256(WAD),
            bps: Nox.toEuint256(10_000),
            feeRate: Nox.toEuint256(b.makerFeeBps),
            mk: b.maker,
            feeBps: b.makerFeeBps
        });

        euint256 accrued = c.zero;
        bool anyFee = false;

        // Withdrawn intents are removed from the array outright, so every entry
        // here is live.
        for (uint256 i = 0; i < list.length; i++) {
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
        //
        // `settle` rejects any clearing price the buffer does not cover, so
        // `buyerOwes <= quoteLocked` holds and this subtraction succeeds. What
        // remains is rounding: `quoteLocked` floors the buffered price once,
        // while `buyerOwes` floors the fill and the fee separately, which can
        // leave the two off by a wei at the boundary. The clamp absorbs that.
        //
        // It is NOT a solvency backstop, and must not be relied on as one — when
        // it fires the buyer is still credited their full base, so a genuine
        // overshoot would be paid out of quote the contract does not have. The
        // band is what keeps the vault solvent; this is dust handling.
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
    function cancelBatch(uint256 batchId) external nonReentrant {
        if (batchId != pendingSettlement) revert NotCurrentBatch();

        Batch storage b = _batches[batchId];
        if (b.status != Status.Closed) revert BatchNotClosed();
        if (block.timestamp < b.closedAt + SETTLE_TIMEOUT) revert TimeoutNotElapsed();

        b.status = Status.Cancelled;
        pendingSettlement = 0;

        Intent[] storage list = _intents[batchId];
        euint256 zero = Nox.toEuint256(0);

        for (uint256 i = 0; i < list.length; i++) {
            Intent storage it = list[i];

            euint256 amount = euint256.wrap(it.amount);
            ebool isBuy = ebool.wrap(it.isBuy);

            // Return exactly what was posted: base for sellers, locked quote for
            // buyers. No swap happened, so nothing is netted.
            _credit(baseToken, it.user, Nox.select(isBuy, zero, amount));
            _credit(quoteToken, it.user, euint256.wrap(it.quoteLocked));
        }

        // No successor to open — `closeBatch` already did that — and no price to
        // re-anchor to, since nothing traded. The open batch keeps the reference
        // it inherited, which is the same one that just failed to settle. A
        // cancel caused by drift will therefore usually be followed by another,
        // until a batch clears and `_reprice` catches the market up.
        emit BatchCancelled(batchId);
    }

    // ---------------------------------------------------------------- internals

    /// @param inherited Reference price to use if the pool cannot be read: the
    ///        clearing price after a settle, the outgoing batch's reference
    ///        after a cancel, `initialRefPrice` at deployment.
    ///
    /// @dev The reference now comes from the pool, and `inherited` is only a
    ///      fallback. Inheriting was the whole disease: a reference derived from
    ///      this contract's own last successful trade froze the moment trading
    ///      stopped, and a frozen reference is exactly what stops trading. A
    ///      cancelled batch handed its stale price to its successor, so one
    ///      unsettleable batch begat the next indefinitely.
    ///
    ///      Falling back rather than reverting is deliberate. This runs inside
    ///      `settle` and `cancelBatch`, so a revert here would let anyone who
    ///      can briefly disturb the pool wedge a batch that is trying to clear
    ///      or, worse, one that is trying to refund. A stale price is a bad
    ///      price; an unrefundable batch is a broken contract.
    function _openBatch(uint256 inherited) private {
        (bool ok, uint256 fromPool) = PoolOracle.refPrice(pool, baseToken);
        uint256 refPrice = (ok && fromPool != 0) ? fromPool : inherited;
        if (!ok) emit ReferencePriceStale(currentBatchId + 1, inherited);

        uint256 id = ++currentBatchId;
        Batch storage b = _batches[id];
        b.openedAt = uint64(block.timestamp);
        b.status = Status.Open;
        b.refPrice = refPrice;

        // Freeze the maker terms for the life of this batch. Reading them live
        // at settlement would let the owner install a maker, or raise its fee,
        // after participants had already posted collateral against the terms
        // they saw.
        b.maker = maker;
        b.makerFeeBps = makerFeeBps;

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
