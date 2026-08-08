"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BUFFER_BPS_FALLBACK,
  cryptoUnavailable,
  explain,
  readHandle,
  type Session,
} from "@/lib/hashswap";
import { formatUnits, parseUnits, type Market } from "@/lib/markets";
import type { BatchLimits, BatchView } from "@/lib/useBatch";
import { TokenPanel, type VaultBalance } from "./TokenPanel";
import { MarketPicker } from "./MarketPicker";
import { SwapFlow, buildFlow, type LocalStage } from "./SwapFlow";

const ONE = 10n ** 18n;

export function SwapCard({
  session,
  onActivity,
  refPrice,
  onConnect,
  connecting,
  market,
  onSelectMarket,
  batch,
  currentBatch,
  liveOrder,
  limits,
  secondsLeft,
  settlementSecondsLeft,
  onWatchBatch,
  onViewOrder,
  verifyCanPlace,
}: {
  session: Session | null;
  onActivity: () => void;
  refPrice: bigint | null;
  onConnect?: () => void;
  connecting?: boolean;
  market: Market;
  onSelectMarket: (id: string) => void;
  /// The batch this order is in, once there is one, otherwise the open batch.
  batch: BatchView | null;
  /// The batch a *new* order would join. Distinct from `batch`, which follows
  /// the order already placed — after submission the two diverge, and it is this
  /// one that decides whether another order can be placed at all.
  currentBatch: BatchView | null;
  /// This wallet's live order, if the chain has one. Not the same as `myBatch`
  /// below: this survives a refresh, that does not.
  liveOrder: boolean;
  limits: BatchLimits | null;
  secondsLeft: number;
  settlementSecondsLeft: number;
  onWatchBatch: (id: bigint | null) => void;
  onViewOrder: () => void;
  /// Authoritative re-check, run before anything is signed. `liveOrder` is a
  /// poll result and is therefore stale twice: for a second or so after the page
  /// loads, and for up to one interval after another tab places an order. Both
  /// windows end with the user paying for a deposit and then meeting a revert.
  verifyCanPlace: () => Promise<string | null>;
}) {
  const [sellBase, setSellBase] = useState(true);
  const [amount, setAmount] = useState("");
  const [stage, setStage] = useState<LocalStage>("idle");
  const [failedAt, setFailedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /// Set once an intent of ours is in `batch`. The page owns the id it polls;
  /// this is the card's own record that the order is actually ours.
  const [myBatch, setMyBatch] = useState<bigint | null>(null);
  /// Whether this order paid for its own collateral.
  ///
  /// The moment the deposit lands the vault covers the order, so `alreadyFunded`
  /// flips true and the two funding steps would redraw as "skipped" — the
  /// timeline erasing work the user just watched happen. This remembers they ran.
  const [fundedNow, setFundedNow] = useState(false);

  // Public, straight off the ERC-20. Always available, never needs a signature.
  const [baseWallet, setBaseWallet] = useState<bigint | null>(null);
  const [quoteWallet, setQuoteWallet] = useState<bigint | null>(null);

  // Encrypted, behind the Handle Gateway.
  const [baseVault, setBaseVault] = useState<VaultBalance>({ kind: "idle" });
  const [quoteVault, setQuoteVault] = useState<VaultBalance>({ kind: "idle" });

  const sellToken = sellBase ? market.base : market.quote;
  const buyToken = sellBase ? market.quote : market.base;

  // ------------------------------------------------------------- balances

  const loadWallets = useCallback(async () => {
    if (!session) return;
    try {
      const [b, q] = await Promise.all([
        session.base.balanceOf(session.address),
        session.quote.balanceOf(session.address),
      ]);
      setBaseWallet(b);
      setQuoteWallet(q);
    } catch {
      /* RPC hiccup; the next stage change retries */
    }
  }, [session]);

  /// Read both encrypted vault balances.
  ///
  /// Sequential on purpose. The first `decrypt` of the hour asks the wallet to
  /// sign an EIP-712 data-access authorisation; the SDK caches it, so the second
  /// read is free. Running the pair concurrently — which is what this did — put
  /// two signature requests up at once, wallets dropped the second, and both
  /// balances came back unreadable with nothing on screen to say why.
  ///
  /// A declined signature stops the sequence rather than prompting again for the
  /// other token, since the answer is not going to be different.
  const loadVaults = useCallback(async () => {
    if (!session) return;

    const toBalance = (r: Awaited<ReturnType<typeof readHandle>>): VaultBalance =>
      r.status === "ok"
        ? { kind: "ready", value: r.value }
        : r.status === "locked"
          ? { kind: "locked", reason: r.reason }
          : r.status === "denied"
            ? { kind: "denied", reason: r.reason }
            : { kind: "error", reason: r.reason };

    setBaseVault({ kind: "loading" });
    setQuoteVault({ kind: "loading" });

    const baseHandle = await session.hashswap.balanceHandleOf(market.base.address, session.address);
    const b = await readHandle(session.handleClient, baseHandle);
    setBaseVault(toBalance(b));

    if (b.status === "locked") {
      setQuoteVault({ kind: "locked", reason: b.reason });
      return;
    }

    const quoteHandle = await session.hashswap.balanceHandleOf(market.quote.address, session.address);
    setQuoteVault(toBalance(await readHandle(session.handleClient, quoteHandle)));
  }, [session, market.base.address, market.quote.address]);

  useEffect(() => {
    if (!session) {
      setBaseWallet(null);
      setQuoteWallet(null);
      setBaseVault({ kind: "idle" });
      setQuoteVault({ kind: "idle" });
      setMyBatch(null);
      setStage("idle");
      return;
    }
    loadWallets();
    loadVaults().catch(() => {
      /* readHandle does not throw; this guards the contract reads */
      setBaseVault({ kind: "error", reason: "Could not reach the contract" });
      setQuoteVault({ kind: "error", reason: "Could not reach the contract" });
    });
  }, [session, loadWallets, loadVaults]);

  // Both sides move on every settled transaction, so refresh when one lands.
  useEffect(() => {
    if (stage === "idle" || stage === "queued") {
      loadWallets();
      loadVaults().catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);

  // ---------------------------------------------------------- derived math

  const parsed = (() => {
    try {
      return amount ? parseUnits(amount, sellToken.decimals) : 0n;
    } catch {
      return 0n;
    }
  })();

  const sellWallet = sellBase ? baseWallet : quoteWallet;
  const sellVault = sellBase ? baseVault : quoteVault;
  const vaultHeld = sellVault.kind === "ready" ? sellVault.value : null;

  /// What `submitIntent` will actually try to debit, which is not always what
  /// was typed.
  ///
  /// Sellers post base collateral one for one. Buyers lock quote at the
  /// reference price plus `BUFFER_BPS`, since the clearing price does not exist
  /// yet. Checking the face amount for a buy therefore under-counts by 5%, and
  /// `_debit` does not revert on a shortfall — it contributes zero and lets the
  /// intent join the batch anyway. The order would look placed and do nothing.
  const bufferBps = limits?.bufferBps ?? BUFFER_BPS_FALLBACK;
  const required = sellBase ? parsed : (parsed * bufferBps) / 10_000n;

  /// The buffer as a percentage, for prose. Derived rather than written as "5%"
  /// so the copy cannot drift from the constant the contract actually charges.
  const bufferPct = `${+(Number(bufferBps - 10_000n) / 100).toFixed(2)}%`;

  /// How much still has to be deposited before this order can be placed.
  ///
  /// When the vault balance is unreadable we assume nothing is in there. That is
  /// the safe direction to be wrong in: the worst case is a deposit the user did
  /// not strictly need, rather than a submitted intent with no collateral behind
  /// it, which is what happened when an unreadable balance silently disabled the
  /// deposit path altogether.
  const topUp =
    required === 0n ? 0n : vaultHeld === null ? required : required > vaultHeld ? required - vaultHeld : 0n;
  const needsDeposit = topUp > 0n;
  const alreadyFunded = parsed > 0n && !needsDeposit;
  const cannotAfford = needsDeposit && sellWallet !== null && topUp > sellWallet;

  // Live estimate from Uniswap's QuoterV2, debounced so typing does not spam
  // the RPC. This is what the trade would fetch executed alone right now; the
  // batch clearing price is normally better, because netted volume pays neither
  // slippage nor the LP fee.
  //
  // `staticCall` is required: QuoterV2 simulates the swap and returns its answer
  // by reverting with it, so a normal call would cost gas and throw.
  const [estimate, setEstimate] = useState<bigint | null>(null);
  useEffect(() => {
    if (!session || parsed === 0n) {
      setEstimate(null);
      return;
    }
    let dead = false;
    const t = setTimeout(async () => {
      try {
        const [amountOut] = await session.quoter.quoteExactInputSingle.staticCall({
          tokenIn: sellBase ? market.base.address : market.quote.address,
          tokenOut: sellBase ? market.quote.address : market.base.address,
          amountIn: parsed,
          fee: market.fee,
          sqrtPriceLimitX96: 0n,
        });
        if (!dead) setEstimate(amountOut as bigint);
      } catch {
        // Pool unreachable or the amount exceeds available liquidity, so fall
        // back to the reference price and never leave the field blank.
        if (!dead && refPrice) {
          setEstimate(sellBase ? (parsed * refPrice) / ONE : (parsed * ONE) / refPrice);
        }
      }
    }, 280);
    return () => {
      dead = true;
      clearTimeout(t);
    };
  }, [session, parsed, sellBase, refPrice, market]);

  // ------------------------------------------------------------- actions

  const fail = (step: string, e: any) => {
    setError(explain(e));
    setFailedAt(step);
    setStage("idle");
  };

  /// Approve then deposit, as two visible steps. They are two transactions and
  /// either can be rejected on its own, so the flow names whichever one it is.
  ///
  /// Returns whether funding succeeded, because the caller runs straight on into
  /// sealing the order and needs to know not to.
  async function fund(): Promise<boolean> {
    if (!session || topUp === 0n) return false;
    setError(null);
    setFailedAt(null);

    const token = sellBase ? session.base : session.quote;
    const addr = sellBase ? market.base.address : market.quote.address;

    try {
      // Real Sepolia tokens, with no mint to fall back on, so a short wallet
      // balance has to be surfaced rather than papered over.
      const held: bigint = await token.balanceOf(session.address);
      if (held < topUp) {
        throw new Error(
          `You hold ${formatUnits(held, sellToken.decimals, 4)} ${sellToken.symbol}, and this needs ${formatUnits(topUp, sellToken.decimals, 4)}. Acquire more before depositing.`,
        );
      }
    } catch (e: any) {
      fail("approving", e);
      return false;
    }

    try {
      setStage("approving");

      // Skip a redundant approval. An allowance left over from an attempt that
      // failed at the deposit step is still perfectly good, and asking for a
      // second signature to set it to the same value is just friction.
      const existing: bigint = await token.allowance(session.address, market.hashswap);
      if (existing < topUp) {
        await (await token.approve(market.hashswap, topUp)).wait();

        // Then wait until the allowance actually reads back.
        //
        // This is what was breaking the deposit. Having the receipt is not the
        // same as every RPC node having the state: Sepolia behind a load
        // balancer will happily serve the pre-approval allowance for a second
        // or two afterwards. The wallet estimates gas for `deposit` against
        // that stale view, sees ERC20InsufficientAllowance, and warns that the
        // transaction will fail — which is the point at which it gets
        // cancelled.
        let seen = existing;
        for (let i = 0; i < 12 && seen < topUp; i++) {
          await new Promise((r) => setTimeout(r, 700));
          seen = await token.allowance(session.address, market.hashswap);
        }
        if (seen < topUp) {
          throw new Error(
            "The approval is confirmed but this RPC endpoint has not caught up yet. Wait a moment and press Deposit again.",
          );
        }
      }
    } catch (e: any) {
      fail("approving", e);
      return false;
    }

    try {
      setStage("depositing");

      // Simulate first.
      //
      // Without this the first sign that anything is wrong is the wallet
      // warning that the transaction will fail, with no reason attached, and the
      // only sensible response is to cancel it — which is exactly the dead end
      // this kept hitting. `staticCall` runs the same code against the same
      // state and hands back the revert reason, before anyone is asked to sign.
      try {
        await session.hashswap.deposit.staticCall(addr, topUp);
      } catch (sim: any) {
        throw new Error(`The deposit would revert: ${explain(sim)}`);
      }

      await (await session.hashswap.deposit(addr, topUp)).wait();
      // Deliberately not back to "idle" — the caller seals next, and dropping
      // through idle would blank the timeline's active step between the two.
      onActivity();
      return true;
    } catch (e: any) {
      fail("depositing", e);
      return false;
    }
  }

  async function submit() {
    if (!session || parsed === 0n) return;
    setError(null);
    setFailedAt(null);
    // A new order starts the lifecycle over rather than appending to the last
    // one's finished state.
    setMyBatch(null);
    onWatchBatch(null);

    let amt: any;
    let side: any;
    try {
      setStage("sealing");
      const isBuy = !sellBase;
      const baseAmount = isBuy && refPrice ? (parsed * ONE) / refPrice : parsed;

      amt = await session.handleClient.encryptInput(baseAmount, "uint256", market.hashswap);
      side = await session.handleClient.encryptInput(isBuy, "bool", market.hashswap);
    } catch (e: any) {
      return fail("sealing", e);
    }

    try {
      setStage("submitting");
      // Captured before the call: this is the batch the intent lands in, and it
      // is what the lifecycle follows afterwards. Reading it later would race
      // the batch closing and start tracking the wrong one.
      const target: bigint = await session.hashswap.currentBatchId();
      await (
        await session.hashswap.submitIntent(amt.handle, amt.handleProof, side.handle, side.handleProof)
      ).wait();

      setMyBatch(target);
      onWatchBatch(target);
      setStage("queued");
      setAmount("");
      onActivity();
    } catch (e: any) {
      return fail("submitting", e);
    }
  }

  /// Why a new order cannot be placed right now, or null.
  ///
  /// Both cases are `submitIntent` reverting, caught before anyone signs
  /// anything. Without this the user is walked through an approval and a deposit
  /// — real money, real gas — and only meets the refusal at the final step, with
  /// collateral already sitting in the vault.
  ///
  /// There is no third case. `_openBatch` runs only from `settle` and
  /// `cancelBatch`, so `currentBatchId` advances only once every intent in the
  /// outgoing batch has been filled or refunded: while you hold a live order,
  /// one of these two always applies.
  const blocked = !session
    ? null
    : liveOrder
      ? // HashSwap.sol:271 — one intent per address per batch, so that the
        // anonymity set counts distinct parties rather than repeated ones.
        {
          label: `Order in batch ${String(currentBatch?.id ?? 0n).padStart(3, "0")}`,
          note: "You already have an order in this batch. It has to clear before you can place another.",
        }
      : currentBatch && currentBatch.status !== 0
        ? // HashSwap.sol:269 — the batch is Closed and the next one does not open
          // until the keeper settles this one.
          {
            label: "Batch is clearing",
            note: "This batch has closed and is settling. The next one opens as soon as it does.",
          }
        : null;

  /// Place the order, funding it first if the vault is short.
  ///
  /// One click, one intent. The button used to change its own job — press it
  /// once to deposit, watch it land, then press the same button again to
  /// actually trade — which reads as the app having stalled halfway, and left
  /// collateral sitting in the vault whenever the second press never came.
  /// Depositing is a precondition of the order, not a separate thing the user
  /// asked for, so it happens inside the same action. The only thing that stops
  /// the run is a failure, which the timeline already names.
  async function placeOrder() {
    if (!session || parsed === 0n || blocked) return;

    setError(null);
    setFailedAt(null);

    const why = await verifyCanPlace().catch(() => null);
    if (why) {
      setError(why);
      return;
    }

    setFundedNow(needsDeposit);
    if (needsDeposit && !(await fund())) return;
    await submit();
  }

  // --------------------------------------------------------------- render

  const busy = stage === "approving" || stage === "depositing" || stage === "sealing" || stage === "submitting";

  // Stage labels come before `blocked`, because the order placed by this very
  // click shows up as a live order the moment it lands — and reporting the tail
  // of a successful submission as a refusal is worse than saying nothing.
  const label = connecting
    ? "Connecting"
    : !session
      ? "Connect wallet"
      : stage === "approving"
        ? "Approving"
        : stage === "depositing"
          ? "Depositing"
          : stage === "sealing"
            ? "Sealing order"
            : stage === "submitting"
              ? "Submitting"
              : blocked
                ? blocked.label
                : parsed === 0n
                  ? "Enter an amount"
                  : cannotAfford
                    ? `Not enough ${sellToken.symbol}`
                    : "Place private order";

  const submitted = myBatch !== null;
  const showFlow = stage !== "idle" || parsed > 0n || submitted;

  // Evaluated on the client only; `cryptoUnavailable` returns null during SSR so
  // the first paint matches.
  const insecure = cryptoUnavailable();

  /// What to say about an order that is already in. Follows the batch rather
  /// than freezing on whatever was true at the moment of submission.
  const receipt = !submitted
    ? null
    : batch?.status === 2
      ? {
          text: `Filled at ${formatUnits(batch.clearingPrice, 18, 4)}. Your fill stays encrypted.`,
          tone: "var(--green)",
        }
      : batch?.status === 1
        ? {
            text: `Batch closed. The keeper is retrying the protected Uniswap settlement; it refunds automatically in ${formatWait(settlementSecondsLeft)} if it cannot clear.`,
            tone: "var(--muted)",
          }
        : batch?.status === 3
          ? { text: "That batch was cancelled and your collateral was returned.", tone: "var(--amber)" }
          : { text: "Order placed. It clears when the batch closes.", tone: "var(--green)" };

  const steps = buildFlow({
    stage,
    market,
    sellSymbol: sellToken.symbol,
    amount,
    alreadyFunded,
    fundedNow,
    failedAt,
    submitted,
    batch,
    limits,
    secondsLeft,
    settlementSecondsLeft,
  });

  return (
    <div className="glass-strong" style={{ width: "100%", maxWidth: 440 }}>
      <div className="flex items-center justify-between px-5 pt-5">
        <h2 className="text-[16px] font-bold tracking-tight">Swap</h2>
        <span className="tag">
          <span className="dot" /> Private
        </span>
      </div>

      <div className="p-5">
        {/* Nothing below this works without Web Crypto, so it is said once, at
            the top, rather than as four identical failures further down. */}
        {insecure && (
          <div
            className="surface px-3 py-2.5 mb-3 text-[11px] leading-relaxed"
            style={{ color: "var(--amber)", borderColor: "var(--red-dim)" }}
          >
            {insecure}
          </div>
        )}

        <div className="mb-3">
          <MarketPicker market={market} onSelect={onSelectMarket} disabled={busy} />
        </div>

        {/* One asset in, another out, with a flip between them: the AMM idiom.
            There is no order book here to buy or sell into, so buy/sell tabs
            were describing the contract's internal side flag rather than
            anything the trader does. */}
        <div className="relative">
          <TokenPanel
            label="You pay"
            token={sellToken}
            value={amount}
            onChange={setAmount}
            wallet={sellWallet}
            vault={sellVault}
            onUnlock={() => loadVaults().catch(() => undefined)}
            busy={stage === "sealing"}
          />

          <div className="relative" style={{ height: 6 }}>
            <button
              className="flip"
              aria-label="Switch direction"
              onClick={() => {
                setSellBase((s) => !s);
                setAmount("");
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <path
                  d="M7 4.5v14M7 18.5l-3.5-3.5M17 19.5v-14M17 5.5l3.5 3.5"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>

          <TokenPanel
            label="You receive"
            token={buyToken}
            sealed
            estimate={estimate}
            wallet={sellBase ? quoteWallet : baseWallet}
            vault={sellBase ? quoteVault : baseVault}
            onUnlock={() => loadVaults().catch(() => undefined)}
          />
        </div>

        <div className="mt-5 space-y-2.5 text-[13px]">
          <Row
            label="Estimated"
            value={
              estimate ? (
                <>
                  {formatUnits(estimate, buyToken.decimals, 4)} {buyToken.symbol}
                </>
              ) : (
                <span style={{ color: "var(--faint)" }}>Enter an amount</span>
              )
            }
          />
          {/* Where the money comes from. `submitIntent` moves no tokens — it
              debits the vault — so with a funded vault the trade takes two
              clicks and no transfer, and it is not obvious what paid for it. */}
          {parsed > 0n && (
            <Row
              label={sellBase ? "Collateral" : "Collateral (refundable)"}
              value={
                <span style={{ color: alreadyFunded ? "var(--muted)" : "var(--amber)" }}>
                  {sellBase ? "" : "max "}
                  {formatUnits(required, sellToken.decimals, 4)} {sellToken.symbol}
                  {alreadyFunded ? " from your vault" : " to deposit"}
                </span>
              }
              /* The 5% is the single most confusing number on this card: it reads
                 as a price increase when it is collateral against a clearing
                 price that does not exist yet. Say what is expected to be spent,
                 and say the rest comes back — `_fill` credits the unspent lock to
                 the vault at settlement. */
              note={
                sellBase ? undefined : (
                  <>
                    ≈{formatUnits(parsed, sellToken.decimals, 4)} {sellToken.symbol} at the reference
                    price. The extra {bufferPct} covers the clearing price moving; whatever you do not
                    spend is refunded to your vault when the batch clears.
                  </>
                )
              }
            />
          )}
          <Row label="Final price" value="Set when the batch clears" />
          <Row
            label="Settles in"
            value={limits ? `~${limits.win}s once the batch fills` : "~90 seconds"}
          />
          <Row label="Front-running risk" value={<span style={{ color: "var(--red)" }}>None</span>} />
        </div>

        {/* One button, one intent. Connect, then place the order — funding it
            on the way through if the vault is short. Disabling it while
            disconnected would strand the user with no obvious next step, which
            is why the card owns connection too. */}
        <button
          className="btn btn-red mt-5"
          disabled={session ? parsed === 0n || cannotAfford || busy || blocked !== null : connecting}
          onClick={session ? placeOrder : onConnect}
        >
          {label}
        </button>

        {/* Say why, and where the existing order went. A disabled button with a
            terse label is the same dead end as the revert it is replacing.
            Suppressed once this session has placed the order, because the
            receipt below already says so in better words. */}
        {blocked && !busy && !submitted && (
          <p className="text-[12px] mt-3 text-center leading-relaxed" style={{ color: "var(--faint)" }}>
            {blocked.note}
            {liveOrder && (
              <>
                {" "}
                <button className="link" onClick={onViewOrder}>
                  View it
                </button>
              </>
            )}
          </p>
        )}

        {/* Status-aware, because "It clears when the batch closes" was still on
            screen long after the batch had closed, cleared and settled. */}
        {submitted && receipt && (
          <p className="fade-up text-[13px] mt-4 text-center" style={{ color: receipt.tone }}>
            {receipt.text}
            {/* The order outlives this card — on a refresh the tab is the only
                place it still exists, so point at it while it is still here. */}
            {liveOrder && (
              <>
                {" "}
                <button className="link" onClick={onViewOrder}>
                  View order
                </button>
              </>
            )}
          </p>
        )}

        {error && (
          <p className="text-[12px] mono mt-4" style={{ color: "var(--red)" }}>
            {error}
          </p>
        )}

        {showFlow && (
          <div className="mt-6">
            <SwapFlow steps={steps} />
          </div>
        )}
      </div>
    </div>
  );
}

function formatWait(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0 ? `${minutes}m ${String(rest).padStart(2, "0")}s` : `${rest}s`;
}

function Row({
  label,
  value,
  note,
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <span style={{ color: "var(--faint)" }}>{label}</span>
        <span className="tnum">{value}</span>
      </div>
      {note && (
        <p className="text-[11px] mt-1 leading-relaxed text-right" style={{ color: "var(--faint)" }}>
          {note}
        </p>
      )}
    </div>
  );
}
