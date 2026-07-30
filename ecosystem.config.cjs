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
      args: "run scripts/keeper.ts --network sepolia",
      out_file: "/root/.pm2/logs/hashswap-keeper-out.log",
      error_file: "/root/.pm2/logs/hashswap-keeper-error.log",
    },
    {
      ...common,
      name: "hashswap-maker",
      args: "run scripts/maker.ts --network sepolia",
      out_file: "/root/.pm2/logs/hashswap-maker-out.log",
      error_file: "/root/.pm2/logs/hashswap-maker-error.log",
    },
  ],
};
