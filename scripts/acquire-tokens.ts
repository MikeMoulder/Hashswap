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
const WRAP = ethers.parseEther((process.env.WRAP ?? "0.12").trim());

/// Quote tokens to buy, and how much WETH to spend on each.
const LINK = "0x779877A7B0D9E8603169DdbD7836e478b4624789";

/// `from` defaults to WETH. USDC needs it: there is no WETH/USDC pool in the
/// registry, so the only route to it is through LINK/USDC — the same pool the
/// LINK-USDC market settles against.
const BUYS = [
  { symbol: "LINK", token: LINK, fee: 10000, spend: ethers.parseEther((process.env.SPEND_LINK ?? "0.03").trim()) },
  { symbol: "DAI", token: "0xFF34B3d4Aee8ddCd6F9AFFFB6Fe49bD371b8a357", fee: 10000, spend: ethers.parseEther((process.env.SPEND_DAI ?? "0.01").trim()) },
  { symbol: "USDC", token: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", fee: 3000, from: LINK, spend: ethers.parseEther((process.env.SPEND_USDC ?? "0").trim()) },
].filter((b) => b.spend > 0n);

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

  // Which wallet is being stocked. The deployer was the only option, which is
  // wrong for the case that actually needs this: the maker holds the inventory
  // every rescue spends, and it cannot refill itself — `scripts/maker.ts`
  // refuses the deployer key by design, so its lanes go bare the moment the
  // maker wallet empties. Same selector as scripts/wrap-eth.ts.
  const role = (process.env.KEY ?? "DEPLOYER").trim().toUpperCase();
  const pk = (process.env[`${role}_PRIVATE_KEY`] ?? "").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) {
    throw new Error(`no usable key — set ${role}_PRIVATE_KEY in .env`);
  }
  const me = new ethers.Wallet("0x" + pk.replace(/^0x/, ""), provider);

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
  const totalSpend = BUYS.filter((b) => (b.from ?? WETH9) === WETH9).reduce((a, b) => a + b.spend, 0n);
  console.log(`\napproving router for ${ethers.formatEther(totalSpend)} WETH`);
  await (await weth.approve(ROUTER, totalSpend)).wait();

  for (const buy of BUYS) {
    const erc = new ethers.Contract(buy.token, ERC20, provider);
    const before: bigint = await erc.balanceOf(me.address);
    const tokenIn = buy.from ?? WETH9;

    // A hop that spends something other than WETH needs its own approval; the
    // blanket one above only covers the WETH legs.
    if (tokenIn !== WETH9) {
      await (await new ethers.Contract(tokenIn, [...ERC20, "function approve(address,uint256) returns (bool)"], me)
        .approve(ROUTER, buy.spend)).wait();
    }

    const inSym = tokenIn === WETH9 ? "WETH" : "LINK";
    process.stdout.write(`buying ${buy.symbol} with ${ethers.formatEther(buy.spend)} ${inSym} … `);
    try {
      const tx = await router.exactInputSingle({
        tokenIn,
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
