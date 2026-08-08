// PM2 process definitions for the two unattended workers.
//
// Both are background workers, not web services: they never bind a port, they
// loop forever on a timer, and nothing health-checks them over HTTP.
//
// NODE VERSION
// Hardhat 3 refuses to start on anything below Node 22.13. The host default is
// still Node 20 (six unrelated PM2 apps run on it), so the interpreter is pinned
// to the Node 22 binary here rather than by moving the global nvm default.
// Hard-coded on purpose: PM2's daemon inherits its PATH from whatever shell
// started it, so resolving `node` at spawn time is not reproducible across a
// `pm2 resurrect` or a host reboot.
//
// `npx hardhat run ...` resolves to exactly this cli.js. Calling it directly
// skips an npx resolution on every restart.
const NODE_22 = "/root/.nvm/versions/node/v22.23.2/bin/node";
const HARDHAT = "./node_modules/hardhat/dist/src/cli.js";

// COMPILE ON START
// `hardhat run` builds the project first, and both workers share one cwd — so a
// simultaneous restart (a `pm2 resurrect`, a host reboot, `pm2 restart all`) put
// two compilers on the same `cache/compile-cache.json`. One renamed the temp
// file first and the other died on the ENOENT, which took the keeper down three
// times before this flag.
//
// Neither worker reads an artifact: both carry their ABI inline as a string
// array and reach the chain through their own JsonRpcProvider. The build was
// buying them nothing and costing a race, so skip it. Contract changes reach
// these processes through a deploy and `deployments/markets.json`, never
// through a restart.
const NO_COMPILE = "--no-compile";

const common = {
  cwd: "/root/hashswap",
  script: HARDHAT,
  interpreter: NODE_22,
  exec_mode: "fork",
  instances: 1,
  autorestart: true,

  // Both scripts fail fast and loudly on bad config — an unset private key, an
  // unreachable RPC. Without backoff a permanent misconfiguration becomes a
  // tight restart loop that spams the log and hammers the RPC quota. Backoff
  // makes a genuinely transient RPC blip recover on its own while a real
  // config error settles into a slow retry.
  exp_backoff_restart_delay: 5000,

  // An ethers provider leaking listeners across a long uptime is the realistic
  // failure here; recycle rather than let the host swap.
  max_memory_restart: "600M",

  // These loop on a timer over a live network — never restart them on file
  // changes.
  watch: false,

  time: true,
  merge_logs: true,
};

module.exports = {
  apps: [
    {
      ...common,
      name: "hashswap-keeper",
      args: `run ${NO_COMPILE} scripts/keeper.ts --network sepolia`,
      out_file: "/root/.pm2/logs/hashswap-keeper-out.log",
      error_file: "/root/.pm2/logs/hashswap-keeper-error.log",
    },
    {
      ...common,
      name: "hashswap-maker",
      args: `run ${NO_COMPILE} scripts/maker.ts --network sepolia`,
      out_file: "/root/.pm2/logs/hashswap-maker-out.log",
      error_file: "/root/.pm2/logs/hashswap-maker-error.log",
    },
  ],
};
