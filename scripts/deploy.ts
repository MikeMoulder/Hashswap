import { writeFileSync, mkdirSync } from "node:fs";
import { network } from "hardhat";

/// Deploy HashSwap.
///
/// ## Why a mock pool on a real testnet
///
/// This deployment deliberately keeps `MockSwapRouter` in place while running
/// against the REAL NoxCompute singleton and the REAL Handle Gateway.
///
/// Uniswap is not the unknown here — its behaviour is already covered by 43
/// local tests and its Sepolia addresses are published. The unknown is Nox:
/// handle resolution latency, gas per op, ACL behaviour under a real gateway,
/// and whether decryption proofs actually verify on-chain (build.md F3, I7).
/// Changing one variable at a time makes a failure diagnosable instead of a
/// guess between two systems.
///
/// Real Uniswap gets wired in once this foundation is confirmed.

const ONE = 10n ** 18n;

/// 2000 quote per base, and reserves deep enough that a small residual barely
/// moves the price — so netting benefit stays visible above slippage noise.
const REF_PRICE = 2000n * ONE;
const BASE_RESERVE = 1_000n * ONE;
const QUOTE_RESERVE = 2_000_000n * ONE;
const POOL_FEE = 3000;

async function main() {
  const { viem, networkName } = (await network.connect()) as any;

  const [deployer] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const chainId = await publicClient.getChainId();

  console.log(`\nnetwork  : ${networkName} (chainId ${chainId})`);
  console.log(`deployer : ${deployer.account.address}`);
  console.log(
    `balance  : ${Number(await publicClient.getBalance({ address: deployer.account.address })) / 1e18} ETH\n`,
  );

  // Nox.sol hardcodes the NoxCompute address per chain and reverts with
  // "Nox: Unsupported chain" anywhere else. Fail loudly here rather than at the
  // first confusing revert inside a transaction.
  if (![31337, 11155111, 421614].includes(chainId)) {
    throw new Error(`chain ${chainId} has no NoxCompute deployment — see build.md §8`);
  }

  console.log("deploying tokens...");
  const base = await viem.deployContract("MockERC20", ["HashSwap Base", "hBASE", 18]);
  const quote = await viem.deployContract("MockERC20", ["HashSwap Quote", "hQUOTE", 18]);
  console.log(`  base  ${base.address}`);
  console.log(`  quote ${quote.address}`);

  console.log("deploying pool...");
  const router = await viem.deployContract("MockSwapRouter");
  console.log(`  router ${router.address}`);

  // Every state-changing call must be awaited to a receipt on a real network.
  // `write` only broadcasts; it does not wait. Locally this is invisible because
  // Hardhat auto-mines one transaction per call, so ordering is implicit. On
  // Sepolia the next call reads pre-transaction state and reverts — the first
  // attempt here died with ERC20InsufficientAllowance because `seed` ran before
  // `approve` was mined.
  const send = async (p: Promise<`0x${string}`>) =>
    publicClient.waitForTransactionReceipt({ hash: await p });

  console.log("seeding reserves...");
  await send(base.write.mint([deployer.account.address, BASE_RESERVE]));
  await send(quote.write.mint([deployer.account.address, QUOTE_RESERVE]));
  await send(base.write.approve([router.address, BASE_RESERVE]));
  await send(quote.write.approve([router.address, QUOTE_RESERVE]));
  await send(router.write.seed([base.address, BASE_RESERVE]));
  await send(router.write.seed([quote.address, QUOTE_RESERVE]));

  console.log("deploying HashSwap...");
  const hashswap = await viem.deployContract("HashSwap", [
    base.address,
    quote.address,
    POOL_FEE,
    router.address,
    REF_PRICE,
  ]);
  console.log(`  hashswap ${hashswap.address}\n`);

  const record = {
    chainId,
    network: networkName,
    deployedAt: new Date().toISOString(),
    deployer: deployer.account.address,
    contracts: {
      base: base.address,
      quote: quote.address,
      router: router.address,
      hashswap: hashswap.address,
    },
    params: {
      refPrice: REF_PRICE.toString(),
      poolFee: POOL_FEE,
      baseReserve: BASE_RESERVE.toString(),
      quoteReserve: QUOTE_RESERVE.toString(),
    },
    note: "MockSwapRouter stands in for Uniswap; NoxCompute is the real singleton.",
  };

  mkdirSync("deployments", { recursive: true });
  const path = `deployments/${networkName}.json`;
  writeFileSync(path, JSON.stringify(record, null, 2));
  console.log(`written -> ${path}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
