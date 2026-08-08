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

/// Fallback only, for the moment before the real value arrives.
///
/// Buyers lock quote at the reference price plus this margin, because the
/// clearing price is not known when the intent is submitted. The authority is
/// `HashSwap.BUFFER_BPS`, read at connect time — a hardcoded copy that drifts
/// below the contract's is silently expensive: `_debit` answers an underfunded
/// intent with zero rather than a revert, so the order joins the batch,
/// contributes nothing, and still costs gas.
export const BUFFER_BPS_FALLBACK = 10_500n;

export const HASHSWAP_ABI = [
  "function deposit(address token, uint256 amount)",
  // Withdrawal is two calls, because solvency against an encrypted balance
  // cannot be checked synchronously: `requestWithdraw` debits and publishes an
  // encrypted ok-flag, and `finalizeWithdraw` releases the tokens against the
  // gateway's signed decryption of it. Both were missing from this ABI, which is
  // why deposited funds had no way out of the app.
  "function requestWithdraw(address token, uint256 amount) returns (uint256)",
  "function finalizeWithdraw(uint256 id, bytes proof)",
  "function pendingWithdrawal(uint256 id) view returns (tuple(address user, address token, uint256 amount, bytes32 okHandle, bool finalized))",
  "event WithdrawalRequested(uint256 indexed id, address indexed user, address indexed token, uint256 amount, bytes32 okHandle)",
  "event WithdrawalFinalized(uint256 indexed id, bool success)",
  "function submitIntent(bytes32 amountHandle, bytes amountProof, bytes32 sideHandle, bytes sideProof) returns (uint256)",
  "function closeBatch()",
  "function withdrawIntent(uint256 batchId, uint256 index)",
  "function currentBatchId() view returns (uint256)",
  "function pendingBatchIds() view returns (uint256[])",
  "function MAX_PENDING_BATCHES() view returns (uint32)",
  "function balanceHandleOf(address token, address user) view returns (bytes32)",
  "function intentCount(uint256 batchId) view returns (uint256)",
  "function getIntent(uint256 batchId, uint256 index) view returns (tuple(address user, bytes32 amount, bytes32 isBuy, bytes32 quoteLocked))",
  "function getBatch(uint256 batchId) view returns (tuple(uint64 openedAt, uint64 closedAt, uint32 count, uint8 status, bytes32 totalBuy, bytes32 totalSell, bytes32 residualHandle, bytes32 sellSideHandle, uint256 refPrice, uint256 residual, uint256 clearingPrice, bool residualIsSell, address maker, uint16 makerFeeBps))",
  "function MIN_BATCH_SIZE() view returns (uint32)",
  "function MAX_BATCH_SIZE() view returns (uint32)",
  "function BATCH_WINDOW() view returns (uint64)",
  "function SETTLE_TIMEOUT() view returns (uint64)",
  "function BUFFER_BPS() view returns (uint256)",
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
  "function allowance(address owner, address spender) view returns (uint256)",
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

/// Fallback order when nobody chose. The picker normally supplies an rdns; this
/// only decides for callers that did not, e.g. a market switch reusing the
/// existing session. MetaMask first because the deployment is documented
/// against it; otherwise take whoever answered.
const PREFERRED = ["io.metamask", "com.coinbase.wallet", "app.phantom"];

/// Ask the nav to open the wallet picker.
///
/// A window event rather than prop drilling: the picker lives in `Nav`, which is
/// on every page, and the connect buttons that need it are scattered (the swap
/// card, empty states). One event beats threading a setter through every page.
export const CONNECT_REQUEST = "hashswap:connect";

export function requestConnect() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CONNECT_REQUEST));
}

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

/// A handle that was never written. The vault leaves `_balances[token][user]` at
/// the zero word until the first deposit, and the gateway has nothing to look up
/// for it — so it is answered here as a real zero rather than sent on to fail.
const ZERO_HANDLE = /^0x0+$/;

/// Why a decrypt did not produce a number.
///
/// Four outcomes, not two, because they call for four different things from the
/// UI and lumping them together is what made an unloaded balance indisputable
/// from a correctly-refused one:
///
///   ok       the value came back
///   locked   the wallet has not signed a data-access authorisation yet, or
///            refused to. Recoverable — ask again.
///   denied   the connected address is not a viewer on this handle. This is the
///            privacy guarantee working, not a fault.
///   failed   gateway or network trouble. Retryable, and worth showing.
export type DecryptResult =
  | { status: "ok"; value: bigint }
  | { status: "locked"; reason: string }
  | { status: "denied"; reason: string }
  | { status: "failed"; reason: string };

/// Whether the browser will let the Nox SDK work at all.
///
/// Every decrypt runs through `crypto.subtle` — RSA keygen, ECIES, AES — and
/// `crypto.subtle` is `undefined` outside a secure context. Opening the dev
/// server at `http://192.168.x.x:3000` instead of `http://localhost:3000` is
/// therefore enough to break every encrypted read on the page, with an error
/// ("Failed to generate RSA key pair") that says nothing about the cause.
///
/// Worth naming explicitly, because it is invisible, easy to hit on a phone or a
/// second machine, and nothing on-chain is actually wrong when it happens.
export function cryptoUnavailable(): string | null {
  if (typeof window === "undefined") return null;
  if (globalThis.crypto?.subtle) return null;
  return `This page is on ${window.location.origin}, which the browser does not treat as a secure context, so Web Crypto is switched off and encrypted balances cannot be read. Use http://localhost:3000 or serve over HTTPS.`;
}

/// Dig a usable sentence out of an ethers or SDK error.
///
/// Revert reasons hide at several different depths depending on whether the call
/// failed at estimation, in the node, or inside the SDK's own wrapping, and the
/// top-level `message` is often the least informative of them.
export function explain(e: any): string {
  if (!e) return "Unknown error";

  const parts: string[] = [];
  const push = (s?: string) => {
    if (s && !parts.includes(s)) parts.push(s);
  };

  push(e.shortMessage);
  push(e.reason);
  push(e.info?.error?.message);
  push(e.error?.message);
  if (!parts.length) push(e.message);

  for (let c = e.cause, d = 0; c && d < 3; c = c.cause, d++) push(c.shortMessage ?? c.message);

  // An empty revert is what a bare `require(false)` produces — WETH9's
  // `transferFrom` is one, so it is usually an allowance problem wearing no
  // label at all.
  if (e.data === "0x" || /no data present/i.test(parts.join(" "))) {
    push("The contract reverted without a reason string, which for WETH usually means the allowance is not set.");
  }

  return parts.join(" — ") || String(e);
}

function isUserRejection(e: any): boolean {
  // ethers normalises wallet refusals to ACTION_REJECTED, but the SDK rewraps
  // the signature error, so the original is one `cause` deeper.
  for (const err of [e, e?.cause, e?.cause?.cause]) {
    if (!err) continue;
    if (err.code === "ACTION_REJECTED" || err.code === 4001) return true;
    if (/user (rejected|denied)|request rejected/i.test(String(err.message ?? ""))) return true;
  }
  return false;
}

/// Decrypt a handle the connected wallet is authorised for.
///
/// Never throws. The caller gets a reason instead, because the interesting cases
/// here are all failures: a refusal is the product demonstrating itself, and a
/// missing signature is a prompt the user has yet to answer.
///
/// NOTE: the first call in an hour opens a wallet signature request (an EIP-712
/// `DataAccessAuthorization`, cached in localStorage for 60 minutes by the SDK).
/// Two of these fired concurrently produce two prompts, and wallets drop the
/// second — so callers reading several handles must await them in sequence.
export async function readHandle(handleClient: any, handle: string): Promise<DecryptResult> {
  if (!handle || ZERO_HANDLE.test(handle)) return { status: "ok", value: 0n };

  const insecure = cryptoUnavailable();
  if (insecure) return { status: "failed", reason: insecure };

  try {
    const res = await handleClient.decrypt(handle);
    return { status: "ok", value: BigInt(res.value) };
  } catch (e: any) {
    const msg = explain(e);
    if (isUserRejection(e)) {
      return { status: "locked", reason: "Signature declined. Approve it to read your balance." };
    }
    if (/not authorized|does not exist/i.test(msg)) {
      return { status: "denied", reason: "This address is not a viewer on that handle." };
    }
    if (/RSA|subtle|crypto/i.test(msg)) {
      return {
        status: "failed",
        reason: `${msg}. Web Crypto is unavailable, which usually means this page is not on localhost or HTTPS.`,
      };
    }
    // The Runner needs a few seconds on a freshly written handle, so a read
    // taken right after a deposit legitimately misses. Say so, rather than
    // presenting it as a fault.
    if (/not yet computed|not verified/i.test(msg)) {
      return { status: "failed", reason: "The enclave is still computing this balance. Retry in a few seconds." };
    }
    return { status: "failed", reason: msg };
  }
}

/// Older two-state wrapper, kept for the privacy demo where `null` genuinely
/// means "refused, as designed".
export async function tryDecrypt(
  handleClient: any,
  handle: string,
): Promise<{ value: bigint } | null> {
  const res = await readHandle(handleClient, handle);
  return res.status === "ok" ? { value: res.value } : null;
}

export const fmt = (v: bigint, dp = 4) => {
  const [int, dec] = ethers.formatUnits(v, 18).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dec && dp > 0 ? `${grouped}.${dec.slice(0, dp)}` : grouped;
};

export const short = (s: string, n = 10) =>
  s.length > n * 2 ? `${s.slice(0, n)}…${s.slice(-4)}` : s;
