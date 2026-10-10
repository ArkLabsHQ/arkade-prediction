import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { issueMarketAssets, openVault, splitAssets, walletParty, type Ctx, type Party } from "../../src/core/actions.js";
import { auditGenesis } from "../../src/core/audit.js";
import { oracleSlots, type VaultTerms } from "../../src/core/market.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { connectArkade, faucet, indexerProvider, newWallet, waitFor } from "./env.js";
import { network } from "./market.js";

const free = async (p: Party) => (await p.coins()).filter((c) => !c.assets?.length).reduce((s, c) => s + c.value, 0);

describe("operator coins keep sats apart from assets", () => {
    it("opens back-to-back markets from one funded coin and frees sats stuck beside assets", { timeout: 300_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const w = await newWallet();
        await faucet(await w.wallet.getAddress(), 50_000);
        await waitFor(async () => (await w.wallet.getBalance()).available >= 50_000, { what: "operator funds" });
        const op: Party = { ...(await walletParty(w.wallet, w.identity)), keepAssetsApart: true };

        for (const round of [1, 2]) {
            const { assets, genesisTxid } = await issueMarketAssets(ctx, op, hex.encode(randomBytes(16)), 1n);
            await waitFor(async () => (await op.coins()).some((c) => c.assets?.some((a) => a.assetId === assets.ctrl)), { what: "genesis" });
            const terms: VaultTerms = {
                assets, unitSats: 1000n, capSats: 101_000n, oracleKeys: oracleSlots([schnorr.getPublicKey(randomBytes(32))], 1), oracleThreshold: 1,
                binding: new Uint8Array(randomBytes(32)), closeAt: BigInt(Math.floor(Date.now() / 1000) + 3600),
                timeoutAt: BigInt(Math.floor(Date.now() / 1000) + 90_000), exitDelaySeconds: 512n,
            };
            const { txid } = await openVault(ctx, op, terms, 1n, 1000n);
            await auditGenesis({ ark, indexer: indexerProvider }, terms, genesisTxid, txid);
            const coins = await op.coins();
            expect(coins.filter((c) => c.assets?.length).every((c) => c.value === 330), `round ${round}`).toBe(true);
            expect(await free(op)).toBeGreaterThan(40_000);
        }

        const merged = { ...op, keepAssetsApart: false };
        await issueMarketAssets(ctx, merged, hex.encode(randomBytes(16)), 1n);
        const stuck = await waitFor(async () => (await op.coins()).find((c) => c.assets?.length && c.value > 10_000), { what: "merged coin" });
        const before = await free(op);
        await splitAssets(ctx, op, stuck);
        await waitFor(async () => (await free(op)) === before + stuck.value - 330, { what: "split sats" });
    });
});
