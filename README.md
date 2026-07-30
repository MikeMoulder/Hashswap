# HashSwap

**Confidential batch-netting over unmodified Uniswap v3 pools, built on [Nox](https://docs.noxprotocol.io).**

Orders are sealed before they leave your browser. HashSwap collects them into a
batch, crosses offsetting orders against each other privately, and sends **only
the net difference** to Uniswap. Everyone in the batch clears at that one price.

> Built for the iExec **WTF Hackathon — Summer Edition**.

---

## The problem

Every swap on Uniswap is public before it executes.

- **MEV.** Your pending order sits in the mempool with its amount visible. Bots
  trade ahead of it.
- **Leakage.** Your address, size and direction are permanently legible.
- **No private execution.** Uniswap has no confidential mode.

Existing attempts either fork the AMM — breaking composability — or merely relay
transactions, hiding the sender but not the amount, and doing nothing about MEV.

## The idea

**Privacy and better execution are the same feature.** If orders are sealed until
settlement there is nothing to front-run. And if you batch sealed orders, most of
them cancel out before touching the pool — so the majority of volume never
becomes public at all.

---

## Live on Sepolia

Three markets, each a separate HashSwap deployment, each settling against a
**pre-existing Uniswap v3 pool we neither created nor control**.

| Market | HashSwap | Uniswap pool | Fee |
|---|---|---|---|
| **WETH / LINK** | [`0x5b4ec99d…8ae1bf`](https://sepolia.etherscan.io/address/0x5b4ec99d6db1b3368b0d99f055fd3056128ae1bf) | [`0xA470a353…58B88a`](https://sepolia.etherscan.io/address/0xA470a353577901AA8cDCb828BB616ef41d58B88a) | 1% |
| WETH / DAI | [`0x908a1df1…8189a0`](https://sepolia.etherscan.io/address/0x908a1df1e6fb011b12a2aac7d47bb0100e8189a0) | [`0x60439363…906d2C`](https://sepolia.etherscan.io/address/0x60439363146Fc0F633388B4402082Cd673906d2C) | 1% |
| LINK / USDC | [`0x38cc21d6…7cde67`](https://sepolia.etherscan.io/address/0x38cc21d63084a59a3571116e8f097f41617cde67) | [`0x2d021e62…3d49C2c`](https://sepolia.etherscan.io/address/0x2d021e62D1aE41946846462d4bD8A85BB3d49C2c) | 0.3% |

Settlement routes through Uniswap's canonical
[`SwapRouter02`](https://sepolia.etherscan.io/address/0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E)
and prices through their
[`QuoterV2`](https://sepolia.etherscan.io/address/0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3).
Real tokens throughout — canonical Sepolia WETH, LINK, DAI, USDC.

**A batch that actually settled**, against the real WETH/LINK pool:

```
sell 0.006 WETH   gas 766,504
sell 0.004 WETH   gas 754,364
buy  0.008 WETH   gas 754,376
closed
residual          0.002 WETH, sell
settled           gas 947,648

gross order flow  0.018 WETH
reached the pool  0.002 WETH
internalised      88.9%
clearing price    231.28 LINK
```

The pool's balance moved by **exactly the residual**. The other 88.9% settled
between traders inside the contract at the same price, paying neither slippage
nor the LP fee.

---

## How it works

```
1  DEPOSIT   you → HashSwap      real tokens in, credited as an encrypted balance

2  ORDER     you → HashSwap      amount + side sealed at the Nox gateway.
                                 Encrypted balance debited, folded into
                                 encrypted running totals.  NO TOKENS MOVE.

3  CLOSE     keeper              crossed  = min(buys, sells)
                                 residual = |buys − sells|
                                 only the residual is made decryptable

4  RESOLVE   keeper              fetches the residual + a gateway signature (~7s)

5  SETTLE    HashSwap → Uniswap  signature verified on-chain FIRST, then ONE
                                 exactInputSingle for the residual.
                                 Price paid becomes everyone's price.

6  FILL      HashSwap            all participants credited at that price,
                                 encrypted — only they can read their own
```

Steps 1–4 are bookkeeping over ciphertext; Uniswap has no idea we exist. Only
step 5 touches it, once, with the leftover.

### Settlement is two transactions

`exactInputSingle` takes a plain `uint256`, so the residual must be decrypted.
That is the design, not a leak:

> **The net residual is the only number that ever becomes public. Individual
> orders never are.**

`settle()` verifies a gateway signature via `Nox.publicDecrypt` **before**
touching Uniswap, so a keeper reporting a false residual reverts.

### The clearing price

The batch executes residual `R` for `Q` quote tokens and prices the whole batch
at `P_clear = Q · WAD / R`. Conservation is exact: quote in from buyers minus
quote out to sellers equals `(B − S)·P_clear = Q`, precisely what the pool
exchanged.

**When `R = 0`** — a perfect coincidence of wants — no Uniswap trade happens at
all and the batch leaves zero trace in the pool.

**`P_clear` is bounded, and the bound is what keeps the vault solvent.** Buyers
lock 105% of the reference cost (`BUFFER_BPS`) when they submit, because the
clearing price does not exist yet. Sellers are credited at the realized price. If
the realized price could exceed what buyers funded, the contract would credit
more quote than it holds — so `settle` refuses any price more than
`MAX_PRICE_DEVIATION_BPS` (±4%) from the batch's reference, and derives the swap's
own `minOut` / `maxIn` from that band rather than accepting them as arguments.
The width is not arbitrary:

```
(10_000 + 400) · (10_000 + 50)  ≤  10_500 · 10_000      // band · max maker fee ≤ buffer
              104,520,000       ≤  105,000,000
```

A batch that cannot execute inside the band **does not settle at a bad price** —
it reverts, and `cancelBatch` refunds everyone after the timeout. Refusing to
trade is always available; trading at a price nobody funded is not.

### Matching is branchless Solidity

Nox is **TEE-based, not FHE**. The Runner is a generic arithmetic service, not a
place you deploy code — so the netting algorithm is ordinary Solidity over
encrypted types, every conditional expressed as `Nox.select`. You can read the
matching logic and check it; its confidentiality comes from an attested Intel TDX
enclave, not from trusting us.

```solidity
// contracts/lib/BatchMath.sol — the whole netting primitive
sellSide = Nox.lt(totalBuy, totalSell);
crossed  = Nox.select(sellSide, totalBuy, totalSell);
residual = Nox.add(Nox.sub(totalBuy, crossed), Nox.sub(totalSell, crossed));
```

Because `crossed` is the minimum, exactly one of those subtractions is zero — so
adding them yields `|B−S|` with no second comparison and no underflow.

---

## Nox primitives used

| Primitive | Where |
|---|---|
| **Handles** (`euint256`, `ebool`) | Every order amount, side, balance, fill |
| **`fromExternal` + input proofs** | `submitIntent` — plaintext never enters calldata |
| **Branchless `select`/`lt`/`add`/`sub`** | `BatchMath.netOf`, the matching engine |
| **`mul`/`div`** | Quote locking, per-user fills, maker spread |
| **`safeSub`** (→ `ebool` success) | Solvency checks that neither revert nor leak |
| **ACLs** (`allowThis`, `allow`) | Re-granted on every derived handle, every tx |
| **`allowPublicDecryption`** | The residual and its direction, at close |
| **`Nox.publicDecrypt(handle, proof)`** | On-chain verification of the keeper's claim |
| **Handle Gateway SDK** | `encryptInput` in the browser, `publicDecrypt` in the keeper |

## What we did *not* modify

**Uniswap is untouched.** Not forked, not redeployed, not wrapped. The pools were
already there — created by strangers, used by strangers. In the last few thousand
blocks the WETH/LINK pool saw swaps from unrelated addresses alongside ours.

The entire integration surface is one file —
[`contracts/lib/UniswapAdapter.sol`](contracts/lib/UniswapAdapter.sol), ~40 lines
— exposing two calls: `exactInputSingle` for a net-sell residual and
`exactOutputSingle` for a net-buy, since the residual is denominated in base units.

Uniswap interfaces in `contracts/interfaces/` are hand-written and minimal. Not
stylistic: Uniswap v3-periphery is pinned to Solidity 0.7.6 and Nox requires
`^0.8.35`, so the packages cannot coexist.

---

## Privacy: what is hidden, what is not

**Hidden.** Order amounts. Order direction. Per-user fills. Per-user balances.
Which participant contributed to which side.

**Public.** The net residual and its direction. The clearing price. That an
address took part. Deposit and withdrawal amounts.

### Why orders move no tokens

This is the failure mode that would otherwise sink the design. If `submitIntent`
pulled funds with `transferFrom(user, amount)`, the ERC-20 `Transfer` event would
publish the amount, and *which* token moved would publish the direction. Every
handle in the system would be decoration — one `eth_getLogs` would reconstruct
the order book.

So funding is decoupled from trading. Users deposit ahead of time and orders
debit an encrypted balance. `submitIntent` moves no tokens at all.

### Verified on live Sepolia, two independent wallets

```
I5  ✓ order amount absent from calldata
    ✓ order amount absent from logs
    calldata is 516 bytes: a selector, two handles, two proofs

I6  A's balance handle admins: HashSwap, A
    B's balance handle admins: HashSwap, B
    ✓ B has no rights over A's balance      ✓ A has no rights over B's
    ✓ A decrypted its own balance           ✓ A cannot read B's
```

Run it yourself: `npx hardhat run scripts/privacy-audit.ts --network sepolia`

---

## Market maker of last resort

A batch needs three orders before it can clear, which is fine at volume and
painful on day one. `setMaker(address, feeBps)` installs a maker paid a spread
around the clearing price — sellers receive slightly less, buyers pay slightly
more, the difference accrues to the maker. Capped at 50 bps; zero address
disables it entirely. `scripts/maker.ts` posts balanced two-sided clips when a
batch is about to expire under-filled, ending roughly flat.

**This buys liveness, not privacy — and the distinction matters.** A maker
padding a batch that contains one real user can subtract its own known orders and
derive that user's position exactly. The public still learns nothing; the maker
learns everything. That is the bargain an RFQ dealer offers. It is a legitimate
product and an illegitimate thing to leave unsaid.

---

## Known limitations

**Privacy is bounded by batch size.** The anonymity set *is* the batch. At N=1 the
residual would equal that user's entire trade, which is why `MIN_BATCH_SIZE` is 3
and under-filled batches roll over rather than settle. The contract allows one
live intent per address per batch, so a single wallet cannot be the whole crowd —
but sybils can, as they can anywhere without identity. No contract check can
manufacture other people's flow.

**The cold-start problem is real.** At low volume users wait on strangers who may
never arrive. The maker above is the mitigation; the proper fix is a shielded
deposit pool, where the anonymity set accumulates over time instead of having to
coincide. That needs note-based balances and zk membership proofs — Nox's Runner
is not programmable, so there is no TEE shortcut. Estimated 2–4 weeks, not a
patch.

**Uniform pricing is fair, not free.** All participants clear at one price, which
removes any intra-batch ordering advantage. It does **not** guarantee everyone
beats a solo trade: in a one-sided batch (`crossed == 0`) a small trader pays the
aggregate's average price, which is worse than trading alone. Crossed volume
always wins; the residual is fair, not free.

**Keeper honesty is enforced; keeper ordering is bounded but not eliminated.** The
keeper cannot forge a residual — `Nox.publicDecrypt` verifies a gateway signature
on-chain — and it cannot choose the execution price either, since `settle` takes
no slippage argument and computes its own bounds. What it still chooses is *when*
to submit, and `settle` is permissionless, so anyone can.

The band bounds what that ordering is worth, but it is measured against the
**previous** batch's clearing price, which is a lagging reference. A patient
attacker can still ratchet it ~4% per batch by paying for real swaps. That caps
the damage per batch; it does not make the price manipulation-resistant. Reading
the pool's `observe()` TWAP is the correct fix and is **not built** — do it before
real value. Removing the ordering trust entirely needs commit-reveal or a
permissionless keeper set.

**Sub-dust residuals stall rather than settle.** A residual too small for the pool
to price (a few wei of an 18-decimal base) cannot meet the derived `minOut`, so
settlement refuses and the batch refunds after the timeout. Funds are safe; the
batch is lost. A residual worth less than one wei of quote is absorbed instead.
Closing the gap between those two needs a decimals-aware dust floor as a
deployment parameter.

**Gas.** `submitIntent` costs ~760k — roughly 17 Nox ops at ~45k each, since every
operation is an external call into the NoxCompute singleton. `closeBatch` is O(1)
(240k regardless of batch size) because aggregation happens incrementally at
submit time. `settle` is ~950k for three orders.

**One market per deployment.** `baseToken`, `quoteToken` and `poolFee` are
immutable, so each market is its own instance behind a registry.

**Testnet pools are priced arbitrarily.** WETH/DAI genuinely thinks 1 WETH is 6.2M
DAI. The markets function correctly; the rates are not real-world. The UI flags
those with an `ODD RATE` badge rather than hiding it.

**Viewer grants are irrevocable.** Nox ACLs have no revocation — cutting off
access requires rotating to a fresh handle.

**Encryption is server-side.** `encryptInput` sends plaintext to the Handle
Gateway over an attested channel; ECIES happens inside the TEE. The guarantee is
Intel TDX attestation, not client-held keys.

**The Nox gateway is intermittently flaky.** Both `encryptInput` and `decrypt`
occasionally fail transiently and succeed on retry.

---

## Testing

```bash
npx hardhat test          # 66 passing
```

Tests run against `MockNoxCompute`, a plaintext implementation of the
`INoxCompute` interface etched at the local NoxCompute address, so `Nox.sol`
executes unmodified without Docker. It models transient ACL semantics via
`tstore`/`tload`, which is what lets it catch the most common Nox bug — a missing
`Nox.allowThis` after an operation.

**It does not model confidentiality, gas, async handle resolution, or proof
verification.** Those were verified separately on Sepolia:

| | |
|---|---|
| Handle resolution latency | ~7s |
| Gas per Nox op | ~45k |
| Proof verification on-chain | ✅ real gateway signature accepted by `settle` |
| Netting result | matched the local prediction exactly |

Notable coverage: a failed debit leaves the balance untouched (`safeSub` returns
`(false, 0)`, not the original — assigning it unconditionally would wipe
balances); an unfunded order contributes zero without bricking the batch; an
unsettled batch refunds everyone after a timeout; an order can be withdrawn from
a batch that never fills; a withdrawn order is neither filled nor double-refunded;
the maker does not pay the spread it earns.

### Security regressions

`test/03-hardening.spec.ts` holds 15 tests written as *attacks* rather than as
feature checks, so a regression reads as "the attack worked again". They came out
of a full audit pass over the contracts, keeper and frontend, in which two drains
were found, reproduced with working exploits, and fixed:

* **An unbounded clearing price made the vault insolvent.** Past the buyers'
  buffer the contract credited buyers their full base and sellers their full
  quote while holding neither — reproduced at a **414,245 token shortfall**, and
  triggerable by anyone, since `settle` is permissionless and took its own
  slippage bound as a caller argument. Fixed by the price band above.
* **A dust residual drove the clearing price to zero**, which propagated into the
  next batch's reference price and made buys need no collateral at all —
  reproduced at **500 base tokens taken from an honest seller for nothing**.
  Fixed by the band's lower half plus constructor validation.

Also covered: one address cannot hold the whole batch; submit/withdraw churn
cannot grow the intent array past the gas limit (which would have bricked both
settlement *and* the refund path); maker terms cannot change after a participant
has committed; deposits credit the amount received rather than the amount
requested.

The audit found nothing wrong with the confidential machinery — ACL discipline,
the `safeSub` select-pattern, handle confidentiality, and keeper-cannot-lie all
held up under direct attack. Every finding was in the seam where an encrypted
value becomes a plaintext one and touches the pool.

## Running it

```bash
npm install
cp .env.example .env      # SEPOLIA_RPC_URL + DEPLOYER_PRIVATE_KEY

npx hardhat test                                            # local suite
npx hardhat run scripts/demo/run-both.ts                    # sandwich comparison
MARKET=WETH-LINK npx hardhat run scripts/run-market.ts --network sepolia
npx hardhat run scripts/privacy-audit.ts --network sepolia
npx hardhat run scripts/keeper.ts --network sepolia         # settles all markets
npx hardhat run scripts/maker.ts  --network sepolia         # fills thin batches

cd app && npm run dev                                       # the interface
```

Run the keeper in a real terminal — node block-buffers stdout when piped, and a
redirected keeper looks dead while it is working.

## Layout

```
contracts/
  HashSwap.sol            batch lifecycle, netting, settlement, maker, cancel
  HashSwapVault.sol       confidential balances, two-phase withdrawal
  lib/BatchMath.sol       branchless netting primitives
  lib/UniswapAdapter.sol  ← the entire Uniswap integration
  interfaces/             minimal hand-written Uniswap interfaces
  mocks/                  MockNoxCompute, MockSwapRouter, MockERC20, MockFeeToken
scripts/
  deploy-markets.ts  acquire-tokens.ts  run-market.ts
  keeper.ts  maker.ts  privacy-audit.ts  fill-batch.ts
  demo/run-both.ts        the sandwich comparison
app/                      Next.js interface — landing + swap
test/                     66 tests
  03-hardening.spec.ts    security regressions, written as attacks
```
