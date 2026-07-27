"use client";

import { ethers } from "ethers";
import { createEthersHandleClient } from "@iexec-nox/handle";
import deployment from "./deployment.json";

/// Browser-side plumbing for HashSwap.
///
/// Deliberately thin: ethers + `window.ethereum` rather than a wallet-connection
/// framework, because the Nox SDK's `createEthersHandleClient` takes an ethers
/// signer directly. Fewer moving parts on a deadline.

/// Addresses come from deployments/sepolia.json, which TypeScript widens to
/// `string`. The Nox SDK and viem both want `0x${string}`, so narrow once here
/// rather than casting at every call site.
export const CONTRACTS = deployment.contracts as {
  base: `0x${string}`;
  quote: `0x${string}`;
  router: `0x${string}`;
  hashswap: `0x${string}`;
};
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

export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
  "function mint(address to, uint256 amount)",
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

export async function connect() {
  if (!window.ethereum) throw new Error("No injected wallet found. Install MetaMask.");

  await window.ethereum.request({ method: "eth_requestAccounts" });
  const provider = new ethers.BrowserProvider(window.ethereum);

  const net = await provider.getNetwork();
  if (net.chainId !== SEPOLIA_CHAIN_ID) {
    // Nox.sol hardcodes NoxCompute per chain and reverts with
    // "Nox: Unsupported chain" anywhere else, so fail early and clearly.
    try {
      await window.ethereum.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: "0xaa36a7" }],
      });
    } catch {
      throw new Error(`Wrong network (chain ${net.chainId}). Switch to Sepolia.`);
    }
  }

  const signer = await provider.getSigner();
  const address = await signer.getAddress();

  const hashswap = new ethers.Contract(CONTRACTS.hashswap, HASHSWAP_ABI, signer);
  const base = new ethers.Contract(CONTRACTS.base, ERC20_ABI, signer);
  const quote = new ethers.Contract(CONTRACTS.quote, ERC20_ABI, signer);

  // The handle client talks to the Handle Gateway over attested HTTPS.
  // NOTE: encryption happens server-side inside the TEE — `encryptInput` sends
  // plaintext over that channel. The guarantee is TDX attestation, not
  // client-held keys. Worth being precise about; it is a common misreading.
  const handleClient = await createEthersHandleClient(signer as any);

  return { provider, signer, address, hashswap, base, quote, handleClient };
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
