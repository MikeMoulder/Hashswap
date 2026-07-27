import assert from "node:assert/strict";
import { describe, it, before } from "node:test";
import { network } from "hardhat";

/// Stage 0 capability probe (build.md §5).
///
/// Runs entirely locally against MockNoxCompute — no Docker, no Sepolia. Proves
/// the *logic* of BatchMath against the real Nox.sol library and the real
/// INoxCompute interface. It proves nothing about confidentiality, gas, or async
/// handle resolution; those are Sepolia-only (see MockNoxCompute's header).

/// The address `Nox.noxComputeContract()` returns for chain 31337. Nox.sol
/// reverts with "Nox: Unsupported chain" anywhere else, so the local chain id
/// must be 31337 and the mock must live exactly here.
const NOX_COMPUTE_LOCAL = "0x75C6AF4430cc474b1bb9b8540b7E46D6f8e1C685";

describe("Stage 0 — capability probe", () => {
  let viem: any;
  let provider: any;
  let mock: any;
  let harness: any;

  before(async () => {
    const conn = await network.connect();
    viem = conn.viem;
    provider = conn.provider;

    // Etch the mock at the well-known NoxCompute address. Deploy first to get
    // runtime bytecode, then copy it into place.
    const deployed = await viem.deployContract("MockNoxCompute");
    const code = await provider.request({
      method: "eth_getCode",
      params: [deployed.address, "latest"],
    });
    await provider.request({
      method: "hardhat_setCode",
      params: [NOX_COMPUTE_LOCAL, code],
    });

    mock = await viem.getContractAt("MockNoxCompute", NOX_COMPUTE_LOCAL);
    harness = await viem.deployContract("BatchMathHarness");
  });

  it("chain id is 31337 so Nox.noxComputeContract() resolves", async () => {
    const id = await provider.request({ method: "eth_chainId", params: [] });
    assert.equal(BigInt(id as string), 31337n);
  });

  it("the mock is etched and reachable through Nox.sol", async () => {
    const code = await provider.request({
      method: "eth_getCode",
      params: [NOX_COMPUTE_LOCAL, "latest"],
    });
    assert.ok((code as string).length > 2, "no bytecode at the NoxCompute address");
  });

  // The Stage 0 exit gate: encrypt two values, compute min on ciphertext,
  // read it back, assert the right answer.
  it("computes min(a, b) over encrypted values", async () => {
    await harness.write.seed([10n, 8n]);
    await harness.write.runNetOf();
    const crossed = await harness.read.crossedHandle();
    assert.equal(await mock.read.peek([crossed]), 8n);
  });

  it("netOf: Alice sells 10, Bob buys 8 -> 2 residual, 8 crossed", async () => {
    await harness.write.seed([8n, 10n]); // buy = 8, sell = 10
    await harness.write.runNetOf();

    const crossed = await harness.read.crossedHandle();
    const residual = await harness.read.residualHandle();
    const sellSide = await harness.read.sellSideHandle();

    assert.equal(await mock.read.peek([crossed]), 8n, "crossed volume");
    assert.equal(await mock.read.peek([residual]), 2n, "residual to the pool");
    assert.equal(await mock.read.peek([sellSide]), 1n, "residual is a sell");
  });

  it("netOf: net-buy direction", async () => {
    await harness.write.seed([25n, 10n]);
    await harness.write.runNetOf();
    assert.equal(await mock.read.peek([await harness.read.crossedHandle()]), 10n);
    assert.equal(await mock.read.peek([await harness.read.residualHandle()]), 15n);
    assert.equal(await mock.read.peek([await harness.read.sellSideHandle()]), 0n);
  });

  it("netOf: perfectly balanced batch leaves zero residual", async () => {
    await harness.write.seed([12n, 12n]);
    await harness.write.runNetOf();
    assert.equal(await mock.read.peek([await harness.read.crossedHandle()]), 12n);
    assert.equal(
      await mock.read.peek([await harness.read.residualHandle()]),
      0n,
      "R = 0 means nothing touches Uniswap at all",
    );
  });

  it("netOf: one-sided batch crosses nothing", async () => {
    await harness.write.seed([7n, 0n]);
    await harness.write.runNetOf();
    assert.equal(await mock.read.peek([await harness.read.crossedHandle()]), 0n);
    assert.equal(await mock.read.peek([await harness.read.residualHandle()]), 7n);
  });

  // Differential fuzz against a plaintext reference. This is the pattern
  // invariant I4 scales up in Stage 3.
  it("netOf matches a plaintext reference across random inputs", async () => {
    for (let i = 0; i < 25; i++) {
      const buy = BigInt(Math.floor(Math.random() * 1_000_000));
      const sell = BigInt(Math.floor(Math.random() * 1_000_000));

      await harness.write.seed([buy, sell]);
      await harness.write.runNetOf();

      const expectedCrossed = buy < sell ? buy : sell;
      const expectedResidual = buy > sell ? buy - sell : sell - buy;

      assert.equal(
        await mock.read.peek([await harness.read.crossedHandle()]),
        expectedCrossed,
        `crossed mismatch for buy=${buy} sell=${sell}`,
      );
      assert.equal(
        await mock.read.peek([await harness.read.residualHandle()]),
        expectedResidual,
        `residual mismatch for buy=${buy} sell=${sell}`,
      );
    }
  });

  // Conservation: the batch neither creates nor destroys volume.
  // crossed + crossed + residual == buy + sell, always.
  it("conservation: 2*crossed + residual == totalBuy + totalSell", async () => {
    for (const [buy, sell] of [[10n, 8n], [8n, 10n], [0n, 5n], [5n, 5n], [999n, 1n]]) {
      await harness.write.seed([buy, sell]);
      await harness.write.runNetOf();
      const c = await mock.read.peek([await harness.read.crossedHandle()]);
      const r = await mock.read.peek([await harness.read.residualHandle()]);
      assert.equal(2n * c + r, buy + sell, `conservation broken for ${buy}/${sell}`);
    }
  });
});
