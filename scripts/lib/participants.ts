import { ethers } from "ethers";

/// Deterministic demo participants, derived from the operator's key.
///
/// ## Why scripts need more than one address
///
/// `HashSwap` allows one live intent per address per batch (build.md F19). A
/// script that submits three orders from a single key therefore reverts with
/// `AlreadySubmitted` — and should, because such a batch never had any privacy
/// to demonstrate. `MIN_BATCH_SIZE` counts distinct parties; three orders from
/// one wallet is an anonymity set of one, and the residual plus the knowledge
/// that all three orders were yours reveals every position in it.
///
/// Hardhat's Sepolia config carries a single account, so extra participants
/// cannot come from `getWalletClients()`. They are derived from the operator
/// address instead, which keeps the demos to one command while still producing
/// genuinely separate addresses on-chain.
///
/// ## These are demo keys
///
/// The derivation is public and deterministic — anyone reading this file can
/// compute the private keys. That is intentional for a testnet fixture, and it
/// is why nothing here should ever hold value worth taking. Fund them per run
/// and let them keep the dust.

/// Participant `i` for a given operator. `i` starts at 2, since the operator
/// itself is participant 1.
export function deriveParticipant(
  operator: string,
  provider: ethers.Provider,
  i: number,
): ethers.Wallet {
  return new ethers.Wallet(
    ethers.keccak256(ethers.toUtf8Bytes(`hashswap/demo/${operator}/${i}`)),
    provider,
  );
}

/// Top a participant up to a gas floor, skipping the transaction when it is
/// already funded so repeat runs stay cheap.
export async function ensureGas(
  funder: ethers.Wallet,
  who: ethers.Wallet,
  opts: { floorEth?: string; topUpEth?: string; log?: (m: string, d?: string) => void } = {},
): Promise<void> {
  const floor = ethers.parseEther(opts.floorEth ?? "0.02");
  const topUp = ethers.parseEther(opts.topUpEth ?? "0.04");

  const balance = await funder.provider!.getBalance(who.address);
  if (balance >= floor) return;

  opts.log?.("funding gas", `${ethers.formatEther(topUp)} ETH -> ${who.address}`);
  await (await funder.sendTransaction({ to: who.address, value: topUp })).wait();
}
