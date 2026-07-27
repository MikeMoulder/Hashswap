import { defineConfig } from "hardhat/config";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import noxPlugin from "@iexec-nox/nox-hardhat-plugin";
import "dotenv/config";

// NOTE ON THE SOLC VERSION
// The Nox plugin README says `solidity: "0.8.29"`. That is stale.
// @iexec-nox/nox-protocol-contracts@0.2.4 ships Nox.sol with `pragma ^0.8.35`,
// so anything below 0.8.35 fails to compile with a confusing pragma error.
// Pinned to 0.8.36 (latest satisfying ^0.8.35). See build.md §4.
const SOLC = "0.8.36";

const PUBLIC_SEPOLIA = "https://ethereum-sepolia-rpc.publicnode.com";

/// Resolve the Sepolia endpoint defensively.
///
/// Hardhat 3 rejects a non-URL here with a config error that fires on EVERY
/// command — including purely local tests that never touch Sepolia. A bad or
/// half-filled .env must not be able to block the local loop, so anything that
/// is not a usable URL degrades to the public node with a warning.
///
/// `.trim()` matters on Windows: a CRLF .env leaves a trailing \r on the value,
/// which is invisible in an error message and produces a baffling failure.
function resolveSepoliaUrl(): string {
  const raw = (process.env.SEPOLIA_RPC_URL ?? "").trim();
  if (raw === "") return PUBLIC_SEPOLIA;
  if (/^https?:\/\//i.test(raw)) return raw;

  console.warn(
    `[config] SEPOLIA_RPC_URL is set but is not a URL (got ${raw.length} chars, no http[s]:// scheme).\n` +
      `         This looks like a bare provider API key. Use the full endpoint, e.g.\n` +
      `           https://sepolia.infura.io/v3/<KEY>   or   https://eth-sepolia.g.alchemy.com/v2/<KEY>\n` +
      `         Falling back to the public node, which rate-limits hard and will not survive a deploy.`,
  );
  return PUBLIC_SEPOLIA;
}

const SEPOLIA_URL = resolveSepoliaUrl();

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin, noxPlugin],

  // The plugin's `test` override boots the Nox offchain stack over Docker
  // Compose. Docker is unavailable here (build.md F9), so tests instead run
  // against contracts/mocks/MockNoxCompute.sol etched at the local NoxCompute
  // address. Flip this to false once Docker exists to test the real stack.
  nox: { skipTestOverride: true },

  solidity: {
    version: SOLC,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      // Every Nox op is an external call, so HashSwap.sol accumulates a lot of
      // stack. viaIR avoids "stack too deep" once netting + settlement land.
      viaIR: true,
    },
  },

  networks: {
    // The plugin boots a node here, injects NoxCompute via hardhat_setCode at
    // its well-known address, and brings up the Docker offchain stack.
    default: {
      type: "edr-simulated",
      chainType: "op",
      // HashSwap.sol carries batch state + settlement + vault wiring; without
      // this the EIP-170 limit bites during Stage 3.
      allowUnlimitedContractSize: true,
    },

    sepolia: {
      type: "http",
      chainType: "l1",
      // Hardhat 3 rejects an empty string here, so fall back to a public
      // endpoint. Override with SEPOLIA_RPC_URL for anything real — the public
      // node rate-limits hard and will not survive a deploy script.
      url: SEPOLIA_URL,
      accounts: process.env.DEPLOYER_PRIVATE_KEY?.trim()
        ? [`0x${process.env.DEPLOYER_PRIVATE_KEY.trim().replace(/^0x/, "")}`]
        : [],
    },
  },
});
