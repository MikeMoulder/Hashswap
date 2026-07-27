# HashSwap

**Confidential batch-netting over an unmodified Uniswap v3 pool, built on [Nox](https://docs.noxprotocol.io).**

Users submit encrypted swap intents. HashSwap aggregates them into an encrypted
batch, crosses offsetting orders against each other inside Nox, and decrypts and
settles **only the net residual** against the real pool. Everyone clears at one
uniform price.

> Built for the iExec **WTF Hackathon — Summer Edition**.

---

## The problem

Every swap on Uniswap is public before it executes, and that single fact causes
three compounding harms:

- **MEV.** Your pending swap sits in the mempool with its amount and slippage
  visible. Bots front-run and back-run it.
- **Information leakage.** Your address, size, and direction are permanently
  legible. Positions get inferred, strategies leak.
- **No private execution.** Uniswap has no confidential mode and no hidden
  resting orders.

Existing "private swap" attempts either fork the AMM — breaking composability —
or merely relay transactions, hiding the sender but not the amount, and doing
nothing about MEV.

## The idea

**Privacy and better execution are the same feature.** If swaps are encrypted
until settlement, there is nothing to sandwich. And if you batch encrypted
swaps, you can net offsetting orders against each other before touching the
pool, so most volume never becomes public at all.

---

## Live on Sepolia

| Contract | Address |
|---|---|
| **HashSwap** | [`0xa7254e5bea6f74582f967710e122d95c9fba4928`](https://sepolia.etherscan.io/address/0xa7254e5bea6f74582f967710e122d95c9fba4928) |
| Base token | [`0x511f3d68d189f7e7704685dc94a511429ebb3455`](https://sepolia.etherscan.io/address/0x511f3d68d189f7e7704685dc94a511429ebb3455) |
| Quote token | [`0xf9a44d20901e270be2ee3f6c527ae0f9eb62bc53`](https://sepolia.etherscan.io/address/0xf9a44d20901e270be2ee3f6c527ae0f9eb62bc53) |
| Pool | [`0xaa6ae9562580a7974a6105c2ad8134b6763608eb`](https://sepolia.etherscan.io/address/0xaa6ae9562580a7974a6105c2ad8134b6763608eb) |

Two batches have settled against the **real NoxCompute singleton and the real
Handle Gateway** — the second one settled autonomously by the keeper daemon with
no manual intervention:

```
batch 1: Settled  count=3  residual=2.0  clearing price 1990.03
batch 2: Settled  count=3  residual=2.0  clearing price 1982.12   ← keeper
```

Each batch: three encrypted intents totalling 18 base of gross volume, of which
**2 base reached the pool.**

---

## The demo

```bash
npm install
npx hardhat run scripts/demo/run-both.ts
```

The same trade, twice — once naked, once through HashSwap:

```
  LANE A — naked swap on Uniswap
  ────────────────────────────────────────────────────────────
  fair value (empty block)        19,743.16 QUOTE
  actually received               14,953.76 QUOTE
  extracted by sandwich            4,789.40 QUOTE
  attacker profit                    1.6498 BASE

  LANE B — encrypted intent through HashSwap
  ────────────────────────────────────────────────────────────
  what the mempool sees      0x0000007a692301000000…
  gross batch volume                  18.00 BASE
  reached the pool                     2.00 BASE
  received                        19,900.32 QUOTE
  extracted by sandwich                0.00 QUOTE

  SAVED  4,946.55 QUOTE
  89% of batch volume never touched the public pool
```

In Lane B the attacker's bot inspects the mempool and finds a 32-byte handle.
There is nothing to act on.

---

## How it works

```
encrypted intents ──▶ HashSwap  (incremental encrypted aggregation)
                          │
                   closeBatch()   C = min(B,S)      R = |B−S|
                          │       allowPublicDecryption(R)
                          ▼
              keeper: publicDecrypt(R) → { value, gateway proof }
                          │
                   settle(R, proof)  ← Nox.publicDecrypt verifies on-chain
                          │
                   ONE swap of R on real Uniswap  ──▶  P_clear = Q_uni·WAD/R
                          │
                   encrypted per-user fills at P_clear
```

### Settlement is two transactions

Uniswap's `exactInputSingle` takes a plain `uint256`, so the residual must be
decrypted before settlement. That is the design, not a leak:

> **The net residual is the only number that ever becomes public. Individual
> intent amounts and sides never are.**

`closeBatch()` computes `R` privately and marks it publicly decryptable. An
off-chain keeper fetches the plaintext plus a gateway signature and calls
`settle()`, which verifies that signature on-chain via `Nox.publicDecrypt`
**before** touching Uniswap. A keeper reporting a false residual reverts.

### The clearing price

The batch executes `R` on Uniswap for `Q_uni` quote and prices the whole batch at

```
P_clear = Q_uni · WAD / R
```

Conservation is exact by construction: quote in from buyers minus quote out to
sellers equals `(B − S)·P_clear = Q_uni`, precisely what the pool exchanged.

Crossed volume `C` skips pool slippage *and* the LP fee entirely — that is the
netting surplus, delivered through the price rather than a separate rebate
mechanism.

**When `R = 0`** — a perfect coincidence of wants — no Uniswap trade happens at
all, and the batch leaves zero on-chain trace in the pool.

### Matching is branchless Solidity

Nox is **TEE-based, not FHE**. The Runner is a generic arithmetic service, not a
place you deploy code — so the netting algorithm is ordinary Solidity over
encrypted types, with every conditional expressed as `Nox.select`. You can read
the matching logic and check it yourself; its confidentiality comes from an
attested Intel TDX enclave rather than from trusting us.

```solidity
// contracts/lib/BatchMath.sol — the whole netting primitive, 3 lines
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
| **Handles** (`euint256`, `ebool`) | Every intent amount, side, balance, and fill |
| **`fromExternal` + input proofs** | `submitIntent` — plaintext never enters calldata |
| **Branchless `select`/`lt`/`add`/`sub`** | `BatchMath.netOf` — the matching engine |
| **`mul`/`div`** | Quote locking and per-user fill computation |
| **`safeSub`** (→ `ebool` success) | Solvency checks that cannot revert or leak |
| **ACLs** (`allowThis`, `allow`) | Re-granted on every derived handle, every tx |
| **`allowPublicDecryption`** | The residual and its direction, at close |
| **`Nox.publicDecrypt(handle, proof)`** | On-chain verification of the keeper's claim |
| **Handle Gateway SDK** | `encryptInput` client-side, `publicDecrypt` in the keeper |

## What we did *not* modify

**Uniswap is untouched.** Not forked, not redeployed, not wrapped in a custom
pool, and entirely unaware HashSwap exists.

The entire integration surface is one file —
[`contracts/lib/UniswapAdapter.sol`](contracts/lib/UniswapAdapter.sol), about 40
lines — exposing two calls:

- `exactInputSingle` for a net-sell residual
- `exactOutputSingle` for a net-buy residual (the residual is denominated in base
  units, so a buy needs exact-output)

The Uniswap interfaces in `contracts/interfaces/` are hand-written and minimal.
That is not stylistic: Uniswap v3-periphery is pinned to Solidity 0.7.6 and Nox
requires `^0.8.35`, so the packages cannot coexist in one project.

---

## Privacy: what is hidden, and what is not

**Hidden.** Intent amounts. Intent sides. Per-user fills. Per-user balances.
Which participant contributed to which side of the batch.

**Public, by design or necessity.**

- **The net residual and its direction.** Uniswap requires a plaintext amount.
  This is the single value the system reveals per batch.
- **The clearing price.** The residual swap is a public transaction, so its
  realized price is public regardless.
- **Participation.** `submitIntent` is a transaction from a public address.
  Encryption hides *what* you traded, not *that* you traded.
- **Deposits and withdrawals.** Amounts are public; the link between a deposit
  and any specific intent is what breaks.

### Why intents move no tokens

This is the failure mode that would otherwise sink the whole design. If
`submitIntent` pulled funds with `transferFrom(user, amount)`, the ERC-20
`Transfer` event would publish the exact amount, and *which* token moved would
publish the direction. Every encrypted handle would be decoration — one
`eth_getLogs` call would reconstruct the order book.

So funding is decoupled from trading. Users deposit into a confidential balance
ahead of time, and intents debit that encrypted balance via `Nox.safeSub`.
`submitIntent` moves no tokens at all.

---

## Known limitations

Stated plainly, because every one of these is a real constraint a reviewer would
find anyway.

**Privacy is bounded by batch size.** The anonymity set *is* the batch. At N=1
the residual would equal that user's entire trade, which is why `MIN_BATCH_SIZE`
is enforced at 3 and under-filled batches roll over rather than settle. Privacy
scales with participation, as in every batch-privacy system. Our contribution is
that the per-batch leak is exactly one number instead of every order.

**Uniform pricing is fair, not free.** All participants clear at one price, which
removes any intra-batch ordering advantage — the CoW Protocol fairness model. It
does **not** guarantee every participant beats a solo trade. In a one-sided batch
(`crossed == 0`) a small trader pays the aggregate's average price, which is
worse than trading alone. Crossed volume always wins; the residual is fair, not
free. Encrypted limit prices are the intended fix and are not yet implemented.

**Keeper honesty is enforced; keeper ordering is not.** The keeper cannot forge a
residual — `Nox.publicDecrypt` verifies a gateway signature on-chain. But it
learns `R` in plaintext before submitting, so it could position its own
transaction around the settlement swap. The `minOut` bound limits the damage;
removing the trust entirely needs commit-reveal or a permissionless keeper set.
The demo keeper currently passes an unbounded limit, which is safe against the
mock pool and **would not be safe against a real one**.

**Gas.** `submitIntent` costs ~760k gas — about 17 Nox ops at ~45k each, since
every operation is an external call into the NoxCompute singleton. The
quote-locking `mul`+`div` is a meaningful share and is the obvious optimisation
target. `closeBatch` is O(1) by design (240k regardless of batch size) because
aggregation happens incrementally at submit time.

**`MAX_BATCH_SIZE` is 8.** `settle` costs ~910k for 3 intents and extrapolates to
~2.2M at 8 — comfortably inside a block, but the ceiling is real.

**Viewer grants are irrevocable.** Nox ACLs have no revocation. Cutting off
access requires rotating to a fresh handle.

**Buyers lock a buffered quote amount** (105% of a public reference price) and are
refunded the remainder at settlement. If the clearing price moves beyond the
buffer, the refund clamps rather than making the vault insolvent — the buyer is
under-refunded instead.

**Encryption is server-side.** `encryptInput` sends plaintext to the Handle
Gateway over an attested HTTPS channel; ECIES encryption happens inside the TEE.
The guarantee rests on Intel TDX attestation, not on the client holding keys.

**The pool in this deployment is a mock.** `MockSwapRouter` is a constant-product
stand-in, deliberately kept in place so the Sepolia deployment isolates one
variable — real Nox — rather than two. Real Uniswap v3 integration is covered by
the local test suite and the adapter is written against the stock router
interface.

---

## Testing

```bash
npx hardhat test          # 43 passing
```

Tests run against `MockNoxCompute`, a plaintext implementation of the
`INoxCompute` interface etched at the local NoxCompute address, so `Nox.sol`
executes unmodified without Docker. It faithfully models transient ACL semantics
via `tstore`/`tload`, which is what lets it catch the most common Nox bug —
forgetting `Nox.allowThis` after an operation.

**It does not model confidentiality, gas, async handle resolution, or proof
verification.** Those were verified separately on Sepolia:

| | |
|---|---|
| Handle resolution latency | ~7s (2 polls) |
| Gas per Nox op | ~45k |
| Proof verification on-chain | ✅ real gateway signature accepted by `settle` |
| Netting result | 2 base residual — identical to the local prediction |

Notable coverage: a failed debit leaves the balance untouched (`safeSub` returns
`(false, 0)`, not the original — assigning it unconditionally would wipe
balances); an unfunded intent contributes zero without bricking the batch; an
unsettled batch refunds everyone after a timeout; an intent can be withdrawn from
a batch that never fills; a withdrawn intent is neither filled nor
double-refunded.

## Running it yourself

```bash
npm install
cp .env.example .env          # add SEPOLIA_RPC_URL + DEPLOYER_PRIVATE_KEY

npx hardhat test                                          # local suite
npx hardhat run scripts/demo/run-both.ts                  # the demo
npx hardhat run scripts/deploy.ts       --network sepolia # deploy
npx hardhat run scripts/submit-batch.ts --network sepolia # submit + close
npx hardhat run scripts/keeper.ts       --network sepolia # settle
```

Run the keeper in a real terminal — node block-buffers stdout when piped, and a
redirected keeper looks dead while it is in fact working.

## Layout

```
contracts/
  HashSwap.sol          batch lifecycle, netting, settlement, cancel
  HashSwapVault.sol     confidential balances, two-phase withdrawal
  lib/BatchMath.sol     branchless netting primitives
  lib/UniswapAdapter.sol  ← the entire Uniswap integration
  interfaces/           minimal hand-written Uniswap interfaces
  mocks/                MockNoxCompute, MockSwapRouter, MockERC20
scripts/
  deploy.ts  keeper.ts  submit-batch.ts  probe-sepolia.ts
  demo/run-both.ts      the side-by-side comparison
test/                   43 tests
```
