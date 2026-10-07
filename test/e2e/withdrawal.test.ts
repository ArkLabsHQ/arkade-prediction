import { afterAll, describe, expect, it } from "vitest";
import { EsploraProvider, OnchainWallet, Ramps, SingleKey, UnilateralExit } from "@arkade-os/sdk";
import { ESPLORA_URL, arkProvider, faucet, mine, newWallet, regtestCli, waitFor } from "./env.js";

const esplora = new EsploraProvider(ESPLORA_URL, { forcePolling: true, pollingInterval: 1000 });
const balanceAt = async (address: string) => (await esplora.getCoins(address)).filter((c) => c.status.confirmed).reduce((s, c) => s + c.value, 0);
afterAll(() => {
    regtestCli("rpc", "setmocktime", "0");
});

describe("withdrawal and recovery paths for BTC value", () => {
    it("offboards collaboratively and exits unilaterally with a pre-signed package", { timeout: 900_000 }, async () => {
        const alice = await newWallet();
        faucet(await alice.wallet.getAddress(), 80_000);
        await waitFor(async () => (await alice.wallet.getBalance()).available >= 80_000, { what: "alice funds" });

        // Collaborative path: the operator joins a batch that pays an L1 output.
        const offboardDest = await OnchainWallet.create(SingleKey.fromRandomBytes(), "regtest", esplora);
        const info = await arkProvider.getInfo();
        const commitment = await new Ramps(alice.wallet).offboard(offboardDest.address, info.fees, 20_000n);
        mine(1);
        await waitFor(async () => (await balanceAt(offboardDest.address)) >= 20_000, { what: "offboard on L1" });
        console.log(`offboard commitment=${commitment} landed=${await balanceAt(offboardDest.address)}`);

        // Unilateral path: everything needed is pre-signed; execution needs only Esplora (no arkd, no emulator).
        const btcOnly = (await alice.wallet.getVtxos()).filter((v) => !v.isSpent && !v.assets?.length);
        const feeWallet = await OnchainWallet.create(alice.identity, "regtest", esplora);
        const sweep = await OnchainWallet.create(SingleKey.fromRandomBytes(), "regtest", esplora);
        const opts = { wallet: alice.wallet, onchainWallet: feeWallet, sweepAddress: sweep.address, feeRate: 2, vtxos: btcOnly.map((v) => ({ txid: v.txid, vout: v.vout })) };
        const quote = await UnilateralExit.estimate(opts);
        regtestCli("faucet", feeWallet.address, ((quote.totals.fundingRequiredSats + 20_000) / 1e8).toFixed(8), "--confirm");
        await waitFor(async () => (await feeWallet.getCoins()).some((c) => c.status.confirmed), { what: "fee wallet funded" });
        const pkg = await UnilateralExit.prepare(opts);
        mine(1);
        const executor = new UnilateralExit.Executor(pkg, esplora, { pollIntervalMs: 500 });
        let failed = 0;
        for await (const event of executor) {
            if (event.status === "failed") failed++;
            if (event.status === "broadcast") mine(1);
            if (event.status === "waiting_csv" && event.maturesAtTime) {
                // Seconds-based CSV is judged on median-time-past: move this isolated node's clock past maturity.
                regtestCli("rpc", "setmocktime", String(event.maturesAtTime + 900));
                mine(12);
            }
        }
        expect(failed).toBe(0);
        await waitFor(async () => (await balanceAt(sweep.address)) === pkg.totals.recoveredSats, { what: "swept to L1", timeoutMs: 120_000 });
        console.log(`unilateral exit recovered=${pkg.totals.recoveredSats} txs=${pkg.totals.txCount}`);
    });
});
