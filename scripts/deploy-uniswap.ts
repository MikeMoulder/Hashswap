import { writeFileSync, mkdirSync } from "node:fs";
import { network } from "hardhat";
import { getContract, parseAbi } from "viem";

/// Deploy HashSwap against a REAL Uniswap v3 pool on Sepolia.
///
///   npx hardhat run scripts/deploy-uniswap.ts --network sepolia
///
/// Replaces MockSwapRouter with the genuine article: a pool created through
/// Uniswap's own factory, liquidity minted through their position manager, and
/// settlement routed through the canonical SwapRouter02. The tokens stay
/// synthetic because no testnet pair has usable depth, but every Uniswap
/// contract in the path is the real deployment.
///
/// This is what makes "integrates with unmodified Uniswap" checkable rather
/// than merely claimed.

/// Canonical Uniswap v3 on Ethereum Sepolia.
const UNISWAP = {
  factory: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
  positionManager: "0x1238536071E1c677A632429e3655c799b22cDA52",
  swapRouter02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  quoterV2: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
} as const;

const ONE = 10n ** 18n;
const FEE = 3000; // 0.3% tier, tick spacing 60
const REF_PRICE = 2000n * ONE; // quote per base

/// Liquidity to seed. Generous because full-range positions spread capital
/// thinly — we mint our own tokens, so depth is free.
const BASE_LIQ = 5_000n * ONE;
const QUOTE_LIQ = 10_000_000n * ONE;

/// Widest range aligned to tick spacing 60.
const MIN_TICK = -887220;
const MAX_TICK = 887220;

const FACTORY_ABI = [
  "function getPool(address,address,uint24) view returns (address)",
] as const;

const NPM_ABI = [
  "function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)",
  "function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
] as const;

const POOL_ABI = [
  "function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)",
  "function liquidity() view returns (uint128)",
] as const;

/// Integer square root (Newton). Needed because sqrtPriceX96 is a Q64.96 fixed
/// point value and JS floats lose precision well before 96 bits.
function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/// sqrt(price) * 2^96, where price is token1 per token0.
function sqrtPriceX96(num: bigint, den: bigint): bigint {
  return isqrt((num * (1n << 192n)) / den);
}

async function main() {
  const { viem } = (await network.connect()) as any;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const me = wallet.account.address as `0x${string}`;
  const chainId = await publicClient.getChainId();

  if (chainId !== 11155111) throw new Error(`expected Sepolia, got chain ${chainId}`);

  console.log(`\ndeployer  ${me}`);
  console.log(`balance   ${Number(await publicClient.getBalance({ address: me })) / 1e18} ETH\n`);

  const send = async (label: string, p: Promise<`0x${string}`>) => {
    const r = await publicClient.waitForTransactionReceipt({ hash: await p });
    console.log(`  ${label.padEnd(30)} gas ${r.gasUsed}`);
    return r;
  };

  // ---- tokens -----------------------------------------------------------
  console.log("tokens");
  const base = await viem.deployContract("MockERC20", ["HashSwap Base", "hBASE", 18]);
  const quote = await viem.deployContract("MockERC20", ["HashSwap Quote", "hQUOTE", 18]);
  console.log(`  base   ${base.address}`);
  console.log(`  quote  ${quote.address}`);

  // Uniswap orders pool tokens by address, and the price is always expressed as
  // token1 per token0 — so the reference price has to be inverted when our base
  // token sorts second. Getting this backwards initialises the pool at
  // 1/2000 instead of 2000, which is silently wrong until the first swap.
  const baseIsToken0 = BigInt(base.address) < BigInt(quote.address);
  const token0 = baseIsToken0 ? base.address : quote.address;
  const token1 = baseIsToken0 ? quote.address : base.address;

  const sqrtP = baseIsToken0
    ? sqrtPriceX96(REF_PRICE, ONE) // quote per base
    : sqrtPriceX96(ONE, REF_PRICE); // base per quote

  console.log(`\n  token0 ${baseIsToken0 ? "base" : "quote"}, sqrtPriceX96 ${sqrtP}`);

  // ---- mint balances ----------------------------------------------------
  console.log("\nfunding");
  await send("mint base", base.write.mint([me, BASE_LIQ * 2n]));
  await send("mint quote", quote.write.mint([me, QUOTE_LIQ * 2n]));

  // ---- create the pool through Uniswap's own factory --------------------
  console.log("\ncreating the Uniswap v3 pool");
  const npm = getContract({
    address: UNISWAP.positionManager as `0x${string}`,
    abi: parseAbi(NPM_ABI as unknown as string[]),
    client: { public: publicClient, wallet },
  });

  await send(
    "createAndInitializePool",
    (npm as any).write.createAndInitializePoolIfNecessary([token0, token1, FEE, sqrtP]),
  );

  const factory = getContract({
    address: UNISWAP.factory as `0x${string}`,
    abi: parseAbi(FACTORY_ABI as unknown as string[]),
    client: { public: publicClient },
  });
  const pool = (await (factory as any).read.getPool([token0, token1, FEE])) as `0x${string}`;
  console.log(`  pool   ${pool}`);

  // ---- seed liquidity ---------------------------------------------------
  console.log("\nseeding liquidity");
  await send("approve base -> NPM", base.write.approve([UNISWAP.positionManager, BASE_LIQ * 2n]));
  await send("approve quote -> NPM", quote.write.approve([UNISWAP.positionManager, QUOTE_LIQ * 2n]));

  const amount0 = baseIsToken0 ? BASE_LIQ : QUOTE_LIQ;
  const amount1 = baseIsToken0 ? QUOTE_LIQ : BASE_LIQ;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);

  await send(
    "mint position",
    (npm as any).write.mint([
      {
        token0,
        token1,
        fee: FEE,
        tickLower: MIN_TICK,
        tickUpper: MAX_TICK,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient: me,
        deadline,
      },
    ]),
  );

  const poolC = getContract({
    address: pool,
    abi: parseAbi(POOL_ABI as unknown as string[]),
    client: { public: publicClient },
  });
  const liq = await (poolC as any).read.liquidity();
  const slot0 = await (poolC as any).read.slot0();
  console.log(`  liquidity ${liq}`);
  console.log(`  tick      ${slot0[1]}`);

  if (liq === 0n) throw new Error("pool has no liquidity — mint failed silently");

  // ---- HashSwap, pointed at the real router -----------------------------
  console.log("\ndeploying HashSwap against SwapRouter02");
  const hashswap = await viem.deployContract("HashSwap", [
    base.address,
    quote.address,
    FEE,
    UNISWAP.swapRouter02,
    REF_PRICE,
  ]);
  console.log(`  hashswap ${hashswap.address}`);

  const record = {
    chainId,
    network: "sepolia",
    deployedAt: new Date().toISOString(),
    deployer: me,
    contracts: {
      base: base.address,
      quote: quote.address,
      router: UNISWAP.swapRouter02,
      hashswap: hashswap.address,
      pool,
    },
    uniswap: UNISWAP,
    params: {
      refPrice: REF_PRICE.toString(),
      poolFee: FEE,
      baseLiquidity: BASE_LIQ.toString(),
      quoteLiquidity: QUOTE_LIQ.toString(),
    },
    note: "Real Uniswap v3 pool and SwapRouter02. Uniswap contracts are unmodified.",
  };

  mkdirSync("deployments", { recursive: true });
  writeFileSync("deployments/sepolia.json", JSON.stringify(record, null, 2));
  writeFileSync("app/lib/deployment.json", JSON.stringify(record, null, 2));
  console.log("\nwritten -> deployments/sepolia.json + app/lib/deployment.json\n");
}

main().catch((e) => {
  console.error("\nFAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
