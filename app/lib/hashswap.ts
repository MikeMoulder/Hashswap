"use client";

import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import deployment from "./deployment.json";

/// Browser-side plumbing for HashSwap.
///
/// Deliberately thin: ethers + `window.ethereum` rather than a wallet-connection
/// framework, because the Nox SDK's `createEthersHandleClient` takes an ethers
/// signer directly. Fewer moving parts on a deadline.

import { getMarket, UNISWAP, type Market } from "./markets";

export { MARKETS, DEFAULT_MARKET, getMarket, UNISWAP, humanPrice, priceIsRealistic, formatUnits, parseUnits } from "./markets";
export type { Market, Token } from "./markets";

export const POOL_FEE_FALLBACK = 3000;
export const SEPOLIA_CHAIN_ID = 11155111n;

export const HASHSWAP_ABI = [
  "function deposit(address token, uint256 amount)",
  "function submitIntent(bytes32 amountHandle, bytes amountProof, bytes32 sideHandle, bytes sideProof) returns (uint256)",
  "function closeBatch()",
  "function withdrawIntent(uint256 batchId, uint256 index)",
  "function currentBatchId() view returns (uint256)",
  "function balanceHandleOf(address token, address user) view returns (bytes32)",
  "function intentCount(uint256 batchId) view returns (uint256)",
  "function getIntent(uint256 batchId, uint256 index) view returns (tuple(address user, bytes32 amount, bytes32 isBuy, bytes32 quoteLocked, bool withdrawn))",
  "function getBatch(uint256 batchId) view returns (tuple(uint64 openedAt, uint64 closedAt, uint32 count, uint8 status, bytes32 totalBuy, bytes32 totalSell, bytes32 residualHandle, bytes32 sellSideHandle, uint256 refPrice, uint256 residual, uint256 clearingPrice, bool residualIsSell))",
  "function MIN_BATCH_SIZE() view returns (uint32)",
  "function MAX_BATCH_SIZE() view returns (uint32)",
  "function BATCH_WINDOW() view returns (uint64)",
] as const;

/// Uniswap's QuoterV2 — the contract that prices a trade. SwapRouter02 executes
/// swaps but cannot quote them, so this is a separate address.
///
/// Note it is NOT declared `view`: QuoterV2 simulates the swap and returns the
/// answer by reverting with it, so calling it normally would cost gas and revert.
/// It has to be invoked with `staticCall`.
export const QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
] as const;

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function decimals() view returns (uint8)",
] as const;

export const BATCH_STATUS = ["Open", "Closed", "Settled", "Cancelled"] as const;

export type Batch = {
  openedAt: bigint;
  closedAt: bigint;
  count: number;
  status: number;
  residualHandle: string;
  sellSideHandle: string;
  refPrice: bigint;
  residual: bigint;
  clearingPrice: bigint;
};

declare global {
  interface Window {
    ethereum?: any;
  }
}

export type WalletOption = {
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: any;
};

/// Discover wallets via EIP-6963 instead of reading `window.ethereum`.
///
/// With more than one wallet extension installed they race to assign
/// `window.ethereum`, and the loser logs "Cannot set property ethereum of
/// #<Window> which has only a getter". Whichever wins is arbitrary, so reading
/// that property can hand you a wallet the user did not intend to use — or a
/// frozen object that cannot be reassigned.
///
/// EIP-6963 replaces that scramble: each wallet announces itself, and we choose.
export function discoverWallets(timeoutMs = 300): Promise<WalletOption[]> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve([]);

    const found = new Map<string, WalletOption>();
    const onAnnounce = (e: Event) => {
      const detail = (e as CustomEvent).detail as WalletOption;
      if (detail?.info?.uuid) found.set(detail.info.uuid, detail);
    };

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      resolve([...found.values()]);
    }, timeoutMs);
  });
}

/// Preference order when several wallets answer. MetaMask first because it is
/// what the deployment is documented against; otherwise take whoever answered.
const PREFERRED = ["io.metamask", "com.coinbase.wallet", "app.phantom"];

async function pickProvider(rdns?: string): Promise<{ provider: any; name: string }> {
  const wallets = await discoverWallets();

  if (wallets.length) {
    let chosen: WalletOption | undefined;

    if (rdns) chosen = wallets.find((w) => w.info.rdns === rdns);
    if (!chosen) {
      for (const p of PREFERRED) {
        chosen = wallets.find((w) => w.info.rdns === p);
        if (chosen) break;
      }
    }
    chosen ??= wallets[0];

    return { provider: chosen.provider, name: chosen.info.name };
  }

  // Wallets predating EIP-6963 still only expose the global.
  if (window.ethereum) return { provider: window.ethereum, name: "Injected wallet" };

  throw new Error("No wallet detected. Install MetaMask to continue.");
}

export async function connect(rdns?: string, marketId?: string) {
  const market: Market = getMarket(marketId ?? "");
  const { provider: injected, name: walletName } = await pickProvider(rdns);

  await injected.request({ method: "eth_requestAccounts" });
  const provider = new ethers.BrowserProvider(injected);

  const net = await provider.getNetwork();
  if (net.chainId !== SEPOLIA_CHAIN_ID) {
    // Nox.sol hardcodes NoxCompute per chain and reverts with
    // "Nox: Unsupported chain" anywhere else, so fail early and clearly.
    try {
      await injected.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0xaa36a7" }],
      });
    } catch {
      throw new Error(`Wrong network (chain ${net.chainId}). Switch to Sepolia.`);
    }
  }

  const signer = await provider.getSigner();
  const address = await signer.getAddress();

  const hashswap = new ethers.Contract(market.hashswap, HASHSWAP_ABI, signer);
  const base = new ethers.Contract(market.base.address, ERC20_ABI, signer);
  const quote = new ethers.Contract(market.quote.address, ERC20_ABI, signer);
  const quoter = new ethers.Contract(UNISWAP.quoterV2, QUOTER_ABI, provider);

  // The handle client talks to the Handle Gateway over attested HTTPS.
  // NOTE: encryption happens server-side inside the TEE — `encryptInput` sends
  // plaintext over that channel. The guarantee is TDX attestation, not
  // client-held keys. Worth being precise about; it is a common misreading.
  const handleClient = await createEthersHandleClient(signer as any);

  return { provider, signer, address, market, hashswap, base, quote, quoter, handleClient, walletName };
}

export type Session = Awaited<ReturnType<typeof connect>>;

/// Decrypt a handle the connected wallet is authorised for.
///
/// Returns `null` on refusal rather than throwing — a failed decrypt is the
/// expected, *desirable* outcome when peeking at someone else's fill, and the UI
/// renders it as proof rather than as an error.
export async function tryDecrypt(
  handleClient: any,
  handle: string,
): Promise<{ value: bigint } | null> {
  if (!handle || /^0x0+$/.test(handle)) return { value: 0n };
  try {
    const res = await handleClient.decrypt(handle);
    return { value: BigInt(res.value) };
  } catch {
    return null;
  }
}

export const fmt = (v: bigint, dp = 4) => {
  const [int, dec] = ethers.formatUnits(v, 18).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dec && dp > 0 ? `${grouped}.${dec.slice(0, dp)}` : grouped;
};

export const short = (s: string, n = 10) =>
  s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-4)}` : s;
