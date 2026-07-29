import { writeFileSync, mkdirSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";

/// Deploy one HashSwap per real Sepolia market.
///
///   npx hardhat run scripts/deploy-markets.ts --network sepolia
///
/// `baseToken`, `quoteToken` and `poolFee` are immutable constructor arguments,
/// so an instance serves exactly one pair. Multiple markets therefore means
/// multiple deployments behind a registry — which is also how this would work in
/// production, so the frontend reads a list rather than a single address.
///
/// Every pool below already existed on Sepolia with real liquidity. We did not
/// create them and do not control them, which is a stronger integration claim
/// than seeding our own.

const UNISWAP = {
  factory: "0x0227628f3F023bb0B980b67D528571c95c6DaC1c",
  positionManager: "0x1238536071E1c677A632429e3655c799b22cDA52",
  swapRouter02: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
  quoterV2: "0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3",
} as const;

const TOKENS = {
  WETH: { address: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14", symbol: "WETH", decimals: 18, name: "Wrapped Ether" },
  LINK: { address: "0x779877A7B0D9E8603169DdbD7836e478b4624789", symbol: "LINK", decimals: 18, name: "Chainlink" },
  DAI:  { address: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357", symbol: "DAI",  decimals: 18, name: "Dai Stablecoin" },
  USDC: { address: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", symbol: "USDC", decimals: 6,  name: "USD Coin" },
} as const;

/// Only pairs where BOTH sides carry usable depth. USDC/UNI and LINK/DAI exist
/// on-chain but one side is dust, so a demo trade would move them absurdly.
const MARKETS = [
  { base: "WETH", quote: "LINK", fee: 10000, pool: "0xA470a353577901AA8cDCb828BB616ef41d58B88a" },
  { base: "WETH", quote: "DAI",  fee: 10000, pool: "0x60439363146Fc0F633388B4402082Cd673906d2C" },
  { base: "LINK", quote: "USDC", fee: 3000,  pool: "0x2d021e62D1aE41946846462d4bD8A85BB3d49C2c" },
] as const;

const WAD = 10n ** 18n;

async function main() {
  const { viem } = (await network.connect()) as any;
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const me = wallet.account.address as `0x${string}`;

  const provider = new ethers.JsonRpcProvider((process.env.SEPOLIA_RPC_URL ?? "").trim());
  const quoter = new ethers.Contract(
    UNISWAP.quoterV2,
    ["function quoteExactInputSingle((address,address,uint256,uint24,uint160)) returns (uint256,uint160,uint32,uint256)"],
    provider,
  );

  console.log(`\ndeployer ${me}`);
  const before = await publicClient.getBalance({ address: me });
  console.log(`balance  ${ethers.formatEther(before)} ETH\n`);

  const deployed: any[] = [];

  for (const m of MARKETS) {
    const base = TOKENS[m.base as keyof typeof TOKENS];
    const quote = TOKENS[m.quote as keyof typeof TOKENS];
    console.log(`${base.symbol}/${quote.symbol}  fee ${m.fee / 10000}%`);

    // Reference price, expressed the way the contract needs it:
    //   quote-smallest-units per ONE base-smallest-unit, scaled by 1e18.
    // Deriving it from a small probe keeps slippage out of the number — a probe
    // of one whole token would be a third of some of these pools and would bake
    // its own price impact into the reference.
    const probe = 10n ** BigInt(base.decimals - 2); // 0.01 base tokens
    let refPrice: bigint;
    try {
      const [out] = await quoter.quoteExactInputSingle.staticCall([
        base.address,
        quote.address,
        probe,
        m.fee,
        0,
      ]);
      refPrice = ((out as bigint) * WAD) / probe;
    } catch (e: any) {
      console.log(`  SKIPPED — cannot quote (${e?.shortMessage ?? e?.message})\n`);
      continue;
    }

    const human =
      Number(refPrice) / 1e18 * 10 ** (base.decimals - quote.decimals);
    console.log(`  reference  1 ${base.symbol} = ${human.toFixed(4)} ${quote.symbol}`);

    const hashswap = await viem.deployContract("HashSwap", [
      base.address,
      quote.address,
      m.fee,
      UNISWAP.swapRouter02,
      refPrice,
    ]);
    console.log(`  hashswap   ${hashswap.address}\n`);

    deployed.push({
      id: `${base.symbol}-${quote.symbol}`,
      hashswap: hashswap.address,
      pool: m.pool,
      fee: m.fee,
      refPrice: refPrice.toString(),
      base,
      quote,
    });
  }

  const after = await publicClient.getBalance({ address: me });
  console.log(`spent ${ethers.formatEther(before - after)} ETH, ${ethers.formatEther(after)} left`);

  const record = {
    chainId: 11155111,
    network: "sepolia",
    deployedAt: new Date().toISOString(),
    deployer: me,
    uniswap: UNISWAP,
    markets: deployed,
    note: "Real Sepolia tokens in pre-existing Uniswap v3 pools we neither created nor control.",
  };

  mkdirSync("deployments", { recursive: true });
  writeFileSync("deployments/markets.json", JSON.stringify(record, null, 2));
  writeFileSync("app/lib/markets.json", JSON.stringify(record, null, 2));
  console.log("\nwritten -> deployments/markets.json + app/lib/markets.json\n");
}

main().catch((e) => {
  console.error("\nFAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
