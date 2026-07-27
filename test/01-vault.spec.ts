import assert from "node:assert/strict";
import { describe, it, before, beforeEach } from "node:test";
import { setupNox, boolProof } from "./helpers/nox.js";

/// Stage 1 — confidential balances (build.md §2.3, F1, F7).
///
/// Logic only. Confidentiality is NOT proven here: MockNoxCompute stores values
/// in plain storage, so `peek` works precisely because this is not the real
/// system. Invariant I5 is Sepolia-only.

const ONE = 10n ** 18n;

describe("Stage 1 — HashSwapVault", () => {
  let viem: any, nox: any, vault: any, token: any;
  let alice: `0x${string}`, bob: `0x${string}`;
  let wallets: any[];

  before(async () => {
    ({ viem, nox } = await setupNox());
    wallets = await viem.getWalletClients();
    alice = wallets[1].account.address;
    bob = wallets[2].account.address;
  });

  beforeEach(async () => {
    vault = await viem.deployContract("VaultHarness");
    token = await viem.deployContract("MockERC20", ["Wrapped Ether", "WETH", 18]);
    await token.write.mint([alice, 100n * ONE]);
    await token.write.mint([bob, 100n * ONE]);
  });

  async function balanceOf(user: `0x${string}`): Promise<bigint> {
    const handle = await vault.read.balanceHandleOf([token.address, user]);
    return await nox.read.peek([handle]);
  }

  async function depositAs(walletIndex: number, user: `0x${string}`, amount: bigint) {
    const account = wallets[walletIndex].account;
    await token.write.approve([vault.address, amount], { account });
    await vault.write.deposit([token.address, amount], { account });
  }

  it("deposit credits an encrypted balance and moves the tokens", async () => {
    await depositAs(1, alice, 10n * ONE);

    assert.equal(await balanceOf(alice), 10n * ONE);
    assert.equal(await token.read.balanceOf([vault.address]), 10n * ONE);
    assert.equal(await token.read.balanceOf([alice]), 90n * ONE);
  });

  it("deposits accumulate", async () => {
    await depositAs(1, alice, 10n * ONE);
    await depositAs(1, alice, 5n * ONE);
    assert.equal(await balanceOf(alice), 15n * ONE);
  });

  it("balances are per-user", async () => {
    await depositAs(1, alice, 10n * ONE);
    await depositAs(2, bob, 3n * ONE);
    assert.equal(await balanceOf(alice), 10n * ONE);
    assert.equal(await balanceOf(bob), 3n * ONE);
  });

  it("deposit of zero reverts", async () => {
    await assert.rejects(
      vault.write.deposit([token.address, 0n], { account: wallets[1].account }),
    );
  });

  // ------------------------------------------------------------------ debit

  it("debit succeeds when funded: effective == amount, balance reduced", async () => {
    await depositAs(1, alice, 10n * ONE);
    await vault.write.debit([token.address, alice, 4n * ONE]);

    assert.equal(await nox.read.peek([await vault.read.lastOk()]), 1n);
    assert.equal(await nox.read.peek([await vault.read.lastEffective()]), 4n * ONE);
    assert.equal(await balanceOf(alice), 6n * ONE);
  });

  // This is build.md F7: an intent the user cannot fund must contribute nothing
  // to the batch without revealing that it was unfunded, and without bricking
  // the batch for everyone else.
  it("debit fails when underfunded: effective == 0, no revert", async () => {
    await depositAs(1, alice, 1n * ONE);
    await vault.write.debit([token.address, alice, 5n * ONE]);

    assert.equal(await nox.read.peek([await vault.read.lastOk()]), 0n);
    assert.equal(
      await nox.read.peek([await vault.read.lastEffective()]),
      0n,
      "an unfunded intent must contribute zero volume",
    );
  });

  // Regression test for a live bug in this design. `Nox.safeSub` returns
  // (false, 0) on underflow — NOT the original balance. Assigning its result
  // unconditionally would zero the balance of anyone who overdrew by one wei.
  // The `Nox.select` in _debit is what prevents it.
  it("a failed debit leaves the balance completely untouched", async () => {
    await depositAs(1, alice, 1n * ONE);
    await vault.write.debit([token.address, alice, 5n * ONE]);

    assert.equal(
      await balanceOf(alice),
      1n * ONE,
      "failed debit destroyed the balance — the select in _debit is missing or wrong",
    );
  });

  it("debit of the exact balance succeeds and leaves zero", async () => {
    await depositAs(1, alice, 7n * ONE);
    await vault.write.debit([token.address, alice, 7n * ONE]);

    assert.equal(await nox.read.peek([await vault.read.lastOk()]), 1n);
    assert.equal(await balanceOf(alice), 0n);
  });

  it("credit adds to an existing balance", async () => {
    await depositAs(1, alice, 2n * ONE);
    await vault.write.credit([token.address, alice, 3n * ONE]);
    assert.equal(await balanceOf(alice), 5n * ONE);
  });

  it("credit works from a zero balance (uninitialized handle)", async () => {
    await vault.write.credit([token.address, bob, 3n * ONE]);
    assert.equal(await balanceOf(bob), 3n * ONE);
  });

  // -------------------------------------------------------------- withdrawal

  it("withdraw: request debits, finalize releases the tokens", async () => {
    await depositAs(1, alice, 10n * ONE);
    const before = await token.read.balanceOf([alice]);

    await vault.write.requestWithdraw([token.address, 4n * ONE], {
      account: wallets[1].account,
    });
    assert.equal(await balanceOf(alice), 6n * ONE, "balance debited at request time");

    const w = await vault.read.pendingWithdrawal([1n]);
    assert.equal(await nox.read.peek([w.okHandle]), 1n);

    await vault.write.finalizeWithdraw([1n, boolProof(true)]);

    assert.equal(await token.read.balanceOf([alice]), before + 4n * ONE);
    assert.equal(await balanceOf(alice), 6n * ONE);
  });

  it("withdraw: over-balance request pays out nothing and preserves the balance", async () => {
    await depositAs(1, alice, 2n * ONE);
    const before = await token.read.balanceOf([alice]);

    await vault.write.requestWithdraw([token.address, 50n * ONE], {
      account: wallets[1].account,
    });

    const w = await vault.read.pendingWithdrawal([1n]);
    assert.equal(await nox.read.peek([w.okHandle]), 0n, "solvency check should have failed");

    await vault.write.finalizeWithdraw([1n, boolProof(false)]);

    assert.equal(await token.read.balanceOf([alice]), before, "no tokens should move");
    assert.equal(await balanceOf(alice), 2n * ONE, "balance must survive a failed withdrawal");
  });

  it("withdraw cannot be finalized twice", async () => {
    await depositAs(1, alice, 5n * ONE);
    await vault.write.requestWithdraw([token.address, 1n * ONE], {
      account: wallets[1].account,
    });
    await vault.write.finalizeWithdraw([1n, boolProof(true)]);

    await assert.rejects(vault.write.finalizeWithdraw([1n, boolProof(true)]));
  });

  it("finalizing an unknown withdrawal reverts", async () => {
    await assert.rejects(vault.write.finalizeWithdraw([999n, boolProof(true)]));
  });

  // Anyone may submit the proof, but the funds always go to the requester.
  // The proof authorises the action; the caller does not.
  it("a third party can finalize, and funds still go to the requester", async () => {
    await depositAs(1, alice, 5n * ONE);
    const aliceBefore = await token.read.balanceOf([alice]);
    const bobBefore = await token.read.balanceOf([bob]);

    await vault.write.requestWithdraw([token.address, 2n * ONE], {
      account: wallets[1].account,
    });
    await vault.write.finalizeWithdraw([1n, boolProof(true)], {
      account: wallets[2].account,
    });

    assert.equal(await token.read.balanceOf([alice]), aliceBefore + 2n * ONE);
    assert.equal(await token.read.balanceOf([bob]), bobBefore);
  });

  // ---------------------------------------------------------------- ACL

  it("the owner is granted persistent access to their balance handle", async () => {
    await depositAs(1, alice, 1n * ONE);
    const handle = await vault.read.balanceHandleOf([token.address, alice]);

    assert.equal(await nox.read.isAllowed([handle, alice]), true);
    assert.equal(
      await nox.read.isAllowed([handle, bob]),
      false,
      "another user must not have access to this balance",
    );
  });
});
