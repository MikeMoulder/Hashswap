import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { ethers } from "ethers";

/// Acquire real Sepolia tokens to trade with.
///
///   npx hardhat run scripts/acquire-tokens.ts --network sepolia
///
/// No faucet needed. The pools already hold the liquidity, so we only need
/// enough of each token to place orders:
///
///   1. wrap ETH into canonical WETH9
///   2. buy the quote tokens through the very pools HashSwap settles against
///
/// Step 2 is worth noticing — acquiring LINK by swapping WETH through the
/// Uniswap pool is itself a live check that the pool is tradeable and that our
/// router wiring is correct.

const WETH9 = "0xfff9976782d46cc05630d1f6ebab18b2324d6b14";
const ROUTER = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E";

/// How much ETH to convert. Deliberately modest — the pools are deep enough
/// that demo-sized orders barely move them, so there is no reason to lock more.
const WRAP = ethers.parseEther("0.12");

/// Quote tokens to buy, and how much WETH to spend on each.
const BUYS = [
  { symbol: "LINK", token: "0x779877A7B0D9E8603169DdbD7836e478b4624789", fee: 10000, spend: ethers.parseEther("0.03") },
  { symbol: "DAI", token: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357", fee: 10000, spend: ethers.parseEther("0.01") },
];

const WETH_ABI = [
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];

async function main() {
  await network.connect();
  const provider = new ethers.JsonRpcProvider((process.env.SEPOLIA_RPC_URL ?? "").trim());
  const me = new ethers.Wallet(
    "0x" + (process.env.DEPLOYER_PRIVATE_KEY ?? "").trim().replace(/^0x/, ""),
    provider,
  );

  console.log(`\nwallet ${me.address}`);
  console.log(`ETH    ${ethers.formatEther(await provider.getBalance(me.address))}\n`);

  const weth = new ethers.Contract(WETH9, WETH_ABI, me);
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, me);

  // ---- wrap --------------------------------------------------------------
  const held: bigint = await weth.balanceOf(me.address);
  if (held < WRAP) {
    const need = WRAP - held;
    console.log(`wrapping ${ethers.formatEther(need)} ETH -> WETH`);
    await (await weth.deposit({ value: need })).wait();
  }
  console.log(`WETH   ${ethers.formatEther(await weth.balanceOf(me.address))}`);

  // ---- buy quote tokens through the real pools ---------------------------
  const totalSpend = BUYS.reduce((a, b) => a + b.spend, 0n);
  console.log(`\napproving router for ${ethers.formatEther(totalSpend)} WETH`);
  await (await weth.approve(ROUTER, totalSpend)).wait();

  for (const buy of BUYS) {
    const erc = new ethers.Contract(buy.token, ERC20, provider);
    const before: bigint = await erc.balanceOf(me.address);

    process.stdout.write(`buying ${buy.symbol} with ${ethers.formatEther(buy.spend)} WETH … `);
    try {
      const tx = await router.exactInputSingle({
        tokenIn: WETH9,
        tokenOut: buy.token,
        fee: buy.fee,
        recipient: me.address,
        amountIn: buy.spend,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      });
      await tx.wait();
      const after: bigint = await erc.balanceOf(me.address);
      const dec = await erc.decimals();
      console.log(`got ${ethers.formatUnits(after - before, dec)} ${buy.symbol}`);
    } catch (e: any) {
      console.log(`FAILED (${e?.shortMessage ?? e?.message})`);
    }
  }

  // ---- final balances ----------------------------------------------------
  console.log("\nbalances");
  const registry = JSON.parse(readFileSync("deployments/markets.json", "utf8"));
  const seen = new Set<string>();
  for (const m of registry.markets) {
    for (const t of [m.base, m.quote]) {
      if (seen.has(t.address)) continue;
      seen.add(t.address);
      const erc = new ethers.Contract(t.address, ERC20, provider);
      const bal: bigint = await erc.balanceOf(me.address);
      console.log(`  ${t.symbol.padEnd(6)} ${ethers.formatUnits(bal, t.decimals)}`);
    }
  }
  console.log(`\nETH left ${ethers.formatEther(await provider.getBalance(me.address))}\n`);
}

main().catch((e) => {
  console.error("FAILED:", e?.shortMessage ?? e?.message ?? e);
  process.exitCode = 1;
});
