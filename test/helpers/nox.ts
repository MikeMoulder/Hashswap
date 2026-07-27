import { network } from "hardhat";

/// The address `Nox.noxComputeContract()` returns for chain 31337. Nox.sol
/// reverts with "Nox: Unsupported chain" anywhere else, so the mock must live
/// exactly here and the local chain id must be 31337.
export const NOX_COMPUTE_LOCAL = "0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685";

/// Boot a local Nox environment: deploy MockNoxCompute and etch it at the
/// well-known address so `Nox.sol` resolves against it unmodified.
///
/// This is the no-Docker path (build.md F9). It exercises logic only — not
/// confidentiality, gas, or async handle resolution. See MockNoxCompute's header.
export async function setupNox() {
  const conn = await network.connect();
  const { viem, provider } = conn as any;

  const deployed = await viem.deployContract("MockNoxCompute");
  const code = await provider.request({
    method: "eth_getCode",
    params: [deployed.address, "latest"],
  });
  await provider.request({
    method: "hardhat_setCode",
    params: [NOX_COMPUTE_LOCAL, code],
  });

  const nox = await viem.getContractAt("MockNoxCompute", NOX_COMPUTE_LOCAL);
  return { conn, viem, provider, nox };
}

/// Build a decryption proof the way the gateway would.
///
/// Wire format is `signature (65 bytes) || decryptedResult (N bytes)`, and
/// `Nox.publicDecrypt` is strict about the payload width: 1 byte for `ebool`,
/// 32 for `euint256`. The mock skips signature verification, so the leading 65
/// bytes are filler — on Sepolia they are a real gateway signature and a wrong
/// value cannot be forged (invariant I7, which is why I7 is Sepolia-only).
export function boolProof(value: boolean): `0x${string}` {
  return `0x${"00".repeat(65)}${value ? "01" : "00"}`;
}

export function uint256Proof(value: bigint): `0x${string}` {
  return `0x${"00".repeat(65)}${value.toString(16).padStart(64, "0")}`;
}
