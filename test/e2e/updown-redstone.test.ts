import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { contractCoin, execute, issueMarketAssets, openVault, resolvePriceMarket, walletParty, type Ctx } from "../../src/core/actions.js";
import { marketContracts, type VaultTerms } from "../../src/core/market.js";
import { feedIdBytes, latestPackages, packageSignerKey, priceReport, type RedStonePackage } from "../../src/core/redstone.js";
import { connectArkade, expectCovenantRejection, faucet, indexerProvider, newWallet, spendableAt, waitFor } from "./env.js";
import { network } from "./market.js";

const roundOf = (ps: RedStonePackage[]) => BigInt(ps[0]!.timestampMilliseconds);

describe("up/down market settled by RedStone's own signatures", () => {
    it("compares the signed medians of two live rounds and refuses the other side and swapped rounds", { timeout: 600_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const w = await newWallet();
        await faucet(await w.wallet.getAddress(), 30_000);
        await waitFor(async () => (await w.wallet.getBalance()).available >= 30_000, { what: "funded" });
        const party = await walletParty(w.wallet, w.identity);

        const startPkgs = await latestPackages("BTC");
        const signers = startPkgs.map(packageSignerKey);
        const endPkgs = await waitFor(async () => {
            const ps = await latestPackages("BTC");
            return roundOf(ps) > roundOf(startPkgs) && ps;
        }, { what: "a later RedStone round", timeoutMs: 120_000, intervalMs: 3000 });
        const start = priceReport("BTC", startPkgs, signers, roundOf(startPkgs));
        const end = priceReport("BTC", endPkgs, signers, roundOf(endPkgs));

        const { assets } = await issueMarketAssets(ctx, party, hex.encode(crypto.getRandomValues(new Uint8Array(16))), 1n);
        await waitFor(async () => (await party.coins()).some((c) => c.assets?.some((a) => a.assetId === assets.ctrl)), { what: "genesis" });
        const closeAt = BigInt(Math.floor(Date.now() / 1000) - 60);
        const terms: VaultTerms = {
            assets, unitSats: 1000n, capSats: 101_000n, oracleKeys: [], oracleThreshold: 1, binding: new Uint8Array(32),
            closeAt, timeoutAt: closeAt + 86_400n, exitDelaySeconds: 512n,
            price: { kind: "updown", feedId: feedIdBytes("BTC"), startAtMs: roundOf(startPkgs), endAtMs: roundOf(endPkgs), signers, quorum: 3 },
        };
        const { vault, resolved } = marketContracts(ark, terms);
        await openVault(ctx, party, terms, 1n, 1000n);
        await waitFor(async () => (await spendableAt(vault.pkScript)).length > 0, { what: "vault" });

        const expected = end.price >= start.price ? "yes" : "no";
        const slot = (name: string, xs: Uint8Array[]) => Object.fromEntries(xs.map((x, i) => [`${name}.${i}`, x]));
        const attempt = async (fn: string, e: typeof end, s: typeof start, to: Uint8Array) => {
            const coin = (await contractCoin(ctx, vault, assets.ctrl))!;
            const args = { x: start.price, ...slot("endValues", e.values), ...slot("endStamps", e.stamps), ...slot("endSigs", e.signatures),
                ...slot("startValues", s.values), ...slot("startStamps", s.stamps), ...slot("startSigs", s.signatures) };
            return execute(ctx, [{ kind: "covenant", coin, contract: vault, fn, args }], [{ script: to, amount: BigInt(coin.value), assets: [{ assetId: assets.ctrl, amount: 1n }] }]);
        };
        const wrong = expected === "yes" ? "no" : "yes";
        await expectCovenantRejection(attempt(wrong === "yes" ? "resolveYes" : "resolveNo", end, start, resolved[wrong].pkScript), "the side the medians do not support");
        await expectCovenantRejection(attempt(expected === "yes" ? "resolveYes" : "resolveNo", start, end, resolved[expected].pkScript), "start and end rounds swapped");

        const { txid, outcome } = await resolvePriceMarket(ctx, terms, end, start);
        expect(outcome).toBe(expected);
        await waitFor(async () => (await spendableAt(resolved[expected].pkScript)).length > 0, { what: "resolved vault" });
        console.log(`BTC start ${start.price} @ ${roundOf(startPkgs)}, end ${end.price} @ ${roundOf(endPkgs)}: ${outcome.toUpperCase()} in ${txid}`);
    });
});
