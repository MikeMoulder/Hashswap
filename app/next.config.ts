import type { NextConfig } from "next";

const config: NextConfig = {
  // The repo root also has a lockfile (the Hardhat project); pin the tracing
  // root so Next stops guessing and warning about it.
  outputFileTracingRoot: __dirname,

  // The Nox SDK and ethers both reach for node builtins that do not exist in the
  // browser bundle; nothing in our path actually uses them.
  webpack: (cfg) => {
    cfg.resolve.fallback = { ...cfg.resolve.fallback, fs: false, net: false, tls: false };
    return cfg;
  },
};

export default config;
