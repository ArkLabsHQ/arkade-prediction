import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { execute, issueMarketAssets, mintSets, openVault, redeemAll, resolvePriceMarket, walletParty, contractCoin, type Ctx } from "../../src/core/actions.js";
import { marketContracts, type VaultTerms } from "../../src/core/market.js";
import { feedIdBytes, latestPackages, packageSignerKey, priceReport, type RedStonePackage } from "../../src/core/redstone.js";
import { connectArkade, expectCovenantRejection, faucet, indexerProvider, newWallet, spendableAt, waitFor } from "./env.js";
import { network } from "./market.js";

describe("price market settled by RedStone's own signatures", () => {
    it("resolves on live signed BTC prices and refuses the wrong side, a tampered price and a short quorum", { timeout: 600_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const w = await newWallet();
        await faucet(await w.wallet.getAddress(), 30_000);
        await waitFor(async () => (await w.wallet.getBalance()).available >= 30_000, { what: "funded" });
        const party = await walletParty(w.wallet, w.identity);

        const packages = await latestPackages("BTC");
        const signers = packages.map(packageSignerKey);
        const round = BigInt(packages[0]!.timestampMilliseconds);
        const report = priceReport("BTC", packages, signers, round);
        expect(report.signatures.filter((x) => x.length).length).toBeGreaterThanOrEqual(3);

        const marketId = hex.encode(crypto.getRandomValues(new Uint8Array(16)));
        const { assets } = await issueMarketAssets(ctx, party, marketId, 1n);
        await waitFor(async () => (await party.coins()).some((c) => c.assets?.some((a) => a.assetId === assets.ctrl)), { what: "genesis" });
        const closeAt = BigInt(Math.floor(Date.now() / 1000) - 120);
        const terms: VaultTerms = {
            assets, unitSats: 1000n, capSats: 101_000n, oracleKeys: [], oracleThreshold: 1, binding: new Uint8Array(32),
            closeAt, timeoutAt: closeAt + 86_400n, exitDelaySeconds: 512n,
            price: { feedId: feedIdBytes("BTC"), strike: report.price - 1n, settleAtMs: round, signers, quorum: 3 },
        };
        const { vault, resolved } = marketContracts(ark, terms);
        await openVault(ctx, party, terms, 1n, 1000n);
        await waitFor(async () => (await spendableAt(vault.pkScript)).length > 0, { what: "vault" });
        await mintSets(ctx, party, terms, 2n);

        const slot = (name: string, xs: Uint8Array[]) => Object.fromEntries(xs.map((x, i) => [`${name}.${i}`, x]));
        const spend = async (fn: string, values: Uint8Array[], sigs: Uint8Array[], to: Uint8Array) => {
            const coin = (await contractCoin(ctx, vault, assets.ctrl))!;
            const args = { ...slot("values", values), ...slot("stamps", report.stamps), ...slot("sigs", sigs) };
            return execute(ctx, [{ kind: "covenant", coin, contract: vault, fn, args }], [{ script: to, amount: BigInt(coin.value), assets: [{ assetId: assets.ctrl, amount: 1n }] }]);
        };
        await expectCovenantRejection(spend("resolveNo", report.values, report.signatures, resolved.no.pkScript), "NO although the median is above the strike");
        const signedSlot = report.signatures.findIndex((x) => x.length);
        const tampered = report.values.map((v, i) => (i === signedSlot ? Uint8Array.from([...v.slice(0, 31), v[31]! ^ 1]) : v));
        await expectCovenantRejection(spend("resolveYes", tampered, report.signatures, resolved.yes.pkScript), "a price its signer did not sign");
        let kept = 0;
        const short = report.signatures.map((x) => (x.length && ++kept <= 2 ? x : new Uint8Array(0)));
        await expectCovenantRejection(spend("resolveYes", report.values, short, resolved.yes.pkScript), "two signers below a quorum of three");

        const { txid, outcome } = await resolvePriceMarket(ctx, terms, report);
        expect(outcome).toBe("yes");
        await waitFor(async () => (await spendableAt(resolved.yes.pkScript)).length > 0, { what: "resolved vault" });
        const paid = await redeemAll(ctx, party, terms, "yes");
        expect(paid.payout).toBe(3000n);
        console.log(`RedStone BTC median ${report.price} (${report.prices.join(", ")}) settled YES in ${txid}; redeemed ${paid.payout} sats`);
    });

    it("takes the median when signers disagree: 3 of 5 below the strike resolve NO and refuse YES", { timeout: 600_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const w = await newWallet();
        await faucet(await w.wallet.getAddress(), 30_000);
        await waitFor(async () => (await w.wallet.getBalance()).available >= 30_000, { what: "funded" });
        const party = await walletParty(w.wallet, w.identity);
        // Real signed packages captured from the gateway: three nodes at 82288.14, one at 82289.77, one at 82291.12.
        const packages: RedStonePackage[] = JSON.parse(readFileSync(new URL("../fixtures/redstone/btc-packages.json", import.meta.url), "utf8")).BTC;
        const signers = packages.map(packageSignerKey);
        const ts = BigInt(packages[0]!.timestampMilliseconds);
        const report = priceReport("BTC", packages, signers, ts);

        const marketId = hex.encode(crypto.getRandomValues(new Uint8Array(16)));
        const { assets } = await issueMarketAssets(ctx, party, marketId, 1n);
        await waitFor(async () => (await party.coins()).some((c) => c.assets?.some((a) => a.assetId === assets.ctrl)), { what: "genesis" });
        const closeAt = BigInt(Math.floor(Date.now() / 1000) - 120);
        const terms: VaultTerms = {
            assets, unitSats: 1000n, capSats: 101_000n, oracleKeys: [], oracleThreshold: 1, binding: new Uint8Array(32),
            closeAt, timeoutAt: closeAt + 86_400n, exitDelaySeconds: 512n,
            price: { feedId: feedIdBytes("BTC"), strike: 8228900000000n, settleAtMs: ts, signers, quorum: 3 },
        };
        const { vault, resolved } = marketContracts(ark, terms);
        await openVault(ctx, party, terms, 1n, 1000n);
        await waitFor(async () => (await spendableAt(vault.pkScript)).length > 0, { what: "vault" });

        const coin = (await contractCoin(ctx, vault, assets.ctrl))!;
        const slot = (name: string, xs: Uint8Array[]) => Object.fromEntries(xs.map((x, i) => [`${name}.${i}`, x]));
        const args = { ...slot("values", report.values), ...slot("stamps", report.stamps), ...slot("sigs", report.signatures) };
        await expectCovenantRejection(execute(ctx, [{ kind: "covenant", coin, contract: vault, fn: "resolveYes", args }],
            [{ script: resolved.yes.pkScript, amount: BigInt(coin.value), assets: [{ assetId: assets.ctrl, amount: 1n }] }]), "YES with only 2 of 5 signers above the strike");
        const second = await issueMarketAssets(ctx, party, hex.encode(crypto.getRandomValues(new Uint8Array(16))), 1n);
        await waitFor(async () => (await party.coins()).some((c) => c.assets?.some((a) => a.assetId === second.assets.ctrl)), { what: "second genesis" });
        const later: VaultTerms = { ...terms, assets: second.assets, price: { ...terms.price!, settleAtMs: ts + 10_000n } };
        const laterVault = marketContracts(ark, later);
        await openVault(ctx, party, later, 1n, 1000n);
        await waitFor(async () => (await spendableAt(laterVault.vault.pkScript)).length > 0, { what: "second vault" });
        const laterCoin = (await contractCoin(ctx, laterVault.vault, second.assets.ctrl))!;
        await expectCovenantRejection(execute(ctx, [{ kind: "covenant", coin: laterCoin, contract: laterVault.vault, fn: "resolveNo", args }],
            [{ script: laterVault.resolved.no.pkScript, amount: BigInt(laterCoin.value), assets: [{ assetId: second.assets.ctrl, amount: 1n }] }]), "reports from a different round");
        const { outcome, txid } = await resolvePriceMarket(ctx, terms, report);
        expect(outcome).toBe("no");
        await waitFor(async () => (await spendableAt(resolved.no.pkScript)).length > 0, { what: "resolved NO vault" });
        console.log(`disagreeing signers (${report.prices.join(", ")}) settled NO in ${txid}`);
    });
});
