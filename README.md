# HashSwap

**Private trading on a Uniswap v3 pool we did not build, fork, or change.**

Your order is encrypted before it leaves the browser. HashSwap collects orders
into a batch, cancels opposing ones against each other in private, and sends only
the leftover difference to Uniswap. Everyone in the batch gets the same price.

Same trade, same block, same pool. Through plain Uniswap, a sandwich bot took
**4,789 DAI**. Through HashSwap: **0.00**.

> Built for the iExec WTF Hackathon, Summer Edition, on [Nox](https://docs.noxprotocol.io).

---

## The problem

Every Uniswap swap announces itself before it happens. Your size and direction sit
in the mempool for anyone to read, then stay in the logs forever. That is what MEV
bots run on.

The usual answers ask you to leave the pool: private relays, batch auctions
elsewhere, forked AMMs. All of them split liquidity and ask everyone to move.

## How it works

```
1  DEPOSIT   you  →  HashSwap    real tokens in, credited as an encrypted balance

2  ORDER     you  →  HashSwap    amount and side encrypted at the Nox gateway.
                                 Encrypted balance debited. NO TOKENS MOVE.

3  CLOSE     keeper              crossed  = min(buys, sells)
                                 residual = |buys - sells|
                                 only the residual becomes readable

4  SETTLE    HashSwap → Uniswap  proof checked on-chain FIRST, then ONE swap
                                 for the residual. That price becomes
                                 everyone's price.

5  FILL      HashSwap            everyone credited at that price, encrypted.
                                 Only you can read your own fill.
```

Ten ETH of buys meeting eight ETH of sells means eight ETH matches internally and
never touches the pool. Only the remaining two ETH is swapped.

**The leftover is the only number that ever becomes public.** It has to be:
Uniswap's `exactInputSingle` takes a plain number, so something must be decrypted.
Individual orders never are.

A keeper reports that number, and it cannot lie about it. `settle` verifies a
gateway signature on-chain before touching Uniswap, so a false figure reverts.

## A batch that actually settled

Real WETH/LINK pool on Sepolia, three separate wallets:

```
seller-1   sell 0.006000 WETH
seller-2   sell 0.004002 WETH
buyer      buy  0.007998 WETH

gross order flow    0.018 WETH
reached the pool    0.002004 WETH
stayed private      88.9%
clearing price      237.95 LINK   (reference 237.66, inside the 4% band)
```

The pool's balance moved by exactly the leftover. The other 88.9% settled between
traders inside the contract, paying neither slippage nor the LP fee.

Three separate wallets matters. The contract allows one order per address per
batch, so the minimum batch size counts real distinct people. A three-order batch
from one key would hide nobody, and is rejected.

## Live on Sepolia

Three markets, each its own deployment, each settling against a Uniswap v3 pool
that already existed and that we do not control.

| Market | HashSwap | Uniswap pool | Fee |
|---|---|---|---|
| **WETH / LINK** | [`0xe866c380…58de75`](https://sepolia.etherscan.io/address/0xe866c38005376d1cc55c62fcc4ebf3ea4258de75) | [`0xA470a353…58B88a`](https://sepolia.etherscan.io/address/0xA470a353577901AA8cDCb828BB616ef41d58B88a) | 1% |
| WETH / DAI | [`0x79a33856…f2d93f`](https://sepolia.etherscan.io/address/0x79a338569ce3f7bc1bd54fd535b9d52bb6f2d93f) | [`0x60439363…906d2C`](https://sepolia.etherscan.io/address/0x60439363146Fc0F633388B4402082Cd673906d2C) | 1% |
| LINK / USDC | [`0xfdbe193f…ffe838`](https://sepolia.etherscan.io/address/0xfdbe193fce0d46bf7042471ad6a76a8a45ffe838) | [`0x2d021e62…3d49C2c`](https://sepolia.etherscan.io/address/0x2d021e62D1aE41946846462d4bD8A85BB3d49C2c) | 0.3% |

Settlement goes through Uniswap's own
[SwapRouter02](https://sepolia.etherscan.io/address/0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E),
prices come from their
[QuoterV2](https://sepolia.etherscan.io/address/0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3),
and the tokens are the canonical Sepolia WETH, LINK, DAI and USDC.

## Uniswap is untouched

Not forked, not redeployed, not wrapped. The pools were already there, created and
used by strangers.

The whole integration is one file,
[`contracts/lib/UniswapAdapter.sol`](contracts/lib/UniswapAdapter.sol), 86 lines,
two calls. It is isolated on purpose, so the claim takes thirty seconds to check
rather than being taken on trust.

The Uniswap interfaces in `contracts/interfaces/` are hand-written and minimal.
That is necessity, not taste: Uniswap v3-periphery is pinned to Solidity 0.7.6
and Nox needs 0.8.35, so the two packages cannot be installed together.

## Privacy: what is hidden, what is not

**Hidden.** Order amounts. Order direction. Per-user fills. Per-user balances.
Which side of the batch you were on.

**Public.** The leftover residual and its direction. The clearing price. That an
address took part. Deposit and withdrawal amounts.

**Why orders move no tokens.** If placing an order pulled funds with
`transferFrom`, the transfer event would publish the amount and which token moved
would publish the direction. Every encrypted value in the system would be
decoration. So funding is separated from trading: you deposit ahead of time, and
orders draw down an encrypted balance without moving anything.

Privacy comes from that separation, not from hiding that you exist. Deposit
exactly 10 ETH and immediately place a 10 ETH order and you have linked them
yourself. No cryptography fixes that.

Checked on live Sepolia with two independent wallets: the order amount is absent
from both calldata and logs (516 bytes of selector, handles and proofs), and
neither wallet can read the other's balance while each can read its own. Run it
yourself with `npx hardhat run scripts/privacy-audit.ts --network sepolia`.

## The interface

A Next.js app in [`app/`](app). Connect a wallet, deposit, place an order.

**Placing an order is one action.** If your vault is short, it approves, deposits
and submits in one go rather than making you press the button twice.

**Your order survives a refresh.** Nothing is kept in the browser. The Orders tab
reads your live order back from the chain, so a reload, a second tab, or coming
back an hour later all show the same thing.

**You can pull an order back out.** A batch needs three orders before it can
settle safely, and in a quiet market it may sit there waiting. Rather than leave
your collateral stuck, the Orders tab lets you withdraw the order and get back
exactly what you put in. Leaving a batch is publicly visible, but the amount and
side are not.

The order lifecycle is drawn out step by step as it happens, and each step states
what the chain can see at that point. Three of the eight are public. The rest
never leave the enclave.

## How the encryption is used

Nox is **TEE-based, not FHE**. The Runner is a generic arithmetic service, not
somewhere you deploy code, so the matching logic is ordinary Solidity over
encrypted types with every branch written as `Nox.select`. You can read it and
check it. Its confidentiality comes from an attested Intel TDX enclave, not from
trusting us.

```solidity
// contracts/lib/BatchMath.sol, the entire netting primitive
sellSide = Nox.lt(totalBuy, totalSell);
crossed  = Nox.select(sellSide, totalBuy, totalSell);
residual = Nox.add(Nox.sub(totalBuy, crossed), Nox.sub(totalSell, crossed));
```

Since `crossed` is the smaller of the two, exactly one of those subtractions is
zero, so adding them gives the absolute difference with no second comparison and
no underflow.

| Nox primitive | Where it is used |
|---|---|
| `euint256`, `ebool` | Every order amount, side, balance and fill |
| `fromExternal` + input proofs | Order submission. Plaintext never enters calldata |
| `select`, `lt`, `add`, `sub` | The matching engine, branchless throughout |
| `mul`, `div` | Quote locking and per-user fills |
| `safeSub` | Solvency checks that neither revert nor leak a balance |
| `allowThis`, `allow` | Re-granted on every derived value, every transaction |
| `allowPublicDecryption` | The residual and its direction, and nothing else |
| `publicDecrypt` | On-chain check of the keeper's claim before settling |
| Handle Gateway SDK | Encrypting in the browser, decrypting in the keeper |

## Security

```bash
npx hardhat test          # 66 passing
```

Fifteen of those are written as **attacks** rather than feature checks, so a
regression reads as "the exploit worked again".

**We audited ourselves and found two ways to drain the vault.** Both were
reproduced with working exploits before being fixed:

- **An unbounded clearing price.** Past the buyers' funding buffer the contract
  credited more than it held. Reproduced at a **414,245 token shortfall**, and
  anyone could trigger it, since `settle` is permissionless and used to take its
  own slippage bound as a caller argument.
- **A dust residual drove the price to zero**, which carried into the next batch's
  reference and let buys through with no collateral at all. Reproduced at **500
  base tokens taken from an honest seller for nothing.**

Both are fixed by a price band. `settle` now refuses any clearing price more than
4% from the batch's reference and works out its own swap limits instead of
trusting the caller. A batch that cannot trade inside the band does not settle at
a bad price. It reverts, and everyone is refunded after a timeout.

The audit found nothing wrong with the confidential machinery itself. Access
control, handle confidentiality and keeper-cannot-lie all held up under direct
attack. Every finding was in the seam where an encrypted value becomes a plain
one and touches the pool.

Also covered: one address cannot occupy a whole batch; repeated submit and
withdraw cannot grow it past the gas limit; an unsettled batch refunds everyone
after a timeout; a withdrawn order is neither filled nor double-refunded; deposits
credit what arrived rather than what was asked for.

Tests run against a plaintext mock of Nox, so they do not model confidentiality,
gas, or proof verification. Those were checked separately on Sepolia: proofs
verify, netting matched the local prediction exactly, and handle resolution takes
7 to 15 seconds.

**Gas.** Placing an order costs around 790k, since each encrypted operation is a
separate call into Nox. Closing a batch is 240k regardless of size, because totals
accumulate as orders arrive. Settling is around 990k.

## Known limitations

Stated up front rather than found later.

**Privacy is bounded by batch size.** The crowd you hide in is the batch. At one
order the residual would be that person's whole trade, which is why the minimum is
three and thin batches wait rather than settle. One order per address stops a
single wallet being the whole crowd. Sybils can, as they can anywhere without
identity.

**One price for everyone is fair, not free.** It removes any advantage from your
position in the batch. It does not guarantee you beat trading alone: where nothing
offsets, a small trader pays the group's average price, which can be worse.
Crossed volume always wins. The leftover is fair, not free.

**The price reference lags by one batch.** The 4% band is measured against the
previous batch's price, so a patient attacker can nudge it a few percent at a
time. That caps damage per batch but is not manipulation-proof. Reading the pool's
own time-weighted price is the correct fix and is **not built**.

**The keeper's timing is not constrained.** It cannot forge the residual or pick
the execution price, but it does choose when to submit. Fixing that needs
commit-reveal or a permissionless keeper set. Anyone can call `settle`.

**Cold start is real.** At low volume you wait for counterparties who may not
arrive. The proper fix is a pool where the anonymity set builds up over time
instead of having to coincide, which needs note-based balances and zk membership
proofs. Nox's Runner is not programmable, so there is no shortcut through the TEE.

**Encryption happens server-side.** Encrypting an order sends plaintext to the
Handle Gateway over an attested channel, and encryption happens inside the TEE.
The guarantee is Intel TDX attestation, not keys held in your browser.

Also worth knowing: each market is its own deployment, since the token pair is
fixed at construction; testnet pools are priced arbitrarily, so some rates are
nonsense and the UI flags them rather than hiding it; access grants cannot be
revoked, only rotated away from; and the Nox gateway occasionally fails and
succeeds on retry.

## Running it

```bash
npm install
cp .env.example .env      # SEPOLIA_RPC_URL + DEPLOYER_PRIVATE_KEY

npx hardhat test                                            # local suite
npx hardhat run scripts/demo/run-both.ts                    # sandwich comparison
MARKET=WETH-LINK npx hardhat run scripts/run-market.ts --network sepolia
npx hardhat run scripts/privacy-audit.ts --network sepolia
npx hardhat run scripts/keeper.ts --network sepolia         # settles all markets

cd app && npm run dev                                       # the interface
```

The keeper is what closes and settles batches, so it needs to be running for
anything to clear. Run it in a real terminal: node buffers output when piped, and
a redirected keeper looks dead while it is working.

## Layout

```
contracts/
  HashSwap.sol            batch lifecycle, netting, settlement, cancel
  HashSwapVault.sol       confidential balances, two-phase withdrawal
  lib/BatchMath.sol       branchless netting
  lib/UniswapAdapter.sol  the entire Uniswap integration
  interfaces/             minimal hand-written Uniswap interfaces
  mocks/                  MockNoxCompute, MockSwapRouter, MockERC20
scripts/
  deploy-markets.ts  run-market.ts  keeper.ts
  privacy-audit.ts   fill-batch.ts  demo/run-both.ts
app/                      Next.js interface
test/                     66 tests, 03-hardening.spec.ts written as attacks
```
