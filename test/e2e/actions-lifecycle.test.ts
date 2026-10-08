import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { hex } from "@scure/base";
import {
    contractCoin, issueMarketAssets, mergeSets, mintMatch, mintSets, openVault, postOffer, redeemAll, resolveMarket,
    spendableCoins, takeOffers, walletParty, type Ctx, type LiveOffer, type Party,
} from "../../src/core/actions.js";
import { attestationMessage, bindingHash, evidenceDigest, signAttestation } from "../../src/core/attestation.js";
import { TEMPLATE, marketContracts, oracleSlots, type VaultTerms } from "../../src/core/market.js";
import { offerContract, type OfferTerms } from "../../src/core/offers.js";
import { BINARY_VECTORS } from "../../src/core/payout.js";
import { connectArkade, faucet, indexerProvider, newWallet, randomP2TR, waitFor } from "./env.js";
import { network } from "./market.js";

const UNIT = 1000n;
const BASE = 1000n;

describe("market lifecycle through shared actions", () => {
    it("runs the documented numeric lifecycle", { timeout: 900_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const names = ["operator", "lp", "alice", "bob", "carol", "dave"] as const;
        const wallets = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await newWallet()] as const)));
        const funding = { operator: 20_000, lp: 60_000, alice: 10_000, bob: 10_000, carol: 10_000, dave: 10_000 };
        for (const n of names) await faucet(await wallets[n]!.wallet.getAddress(), funding[n]);
        const p = {} as Record<(typeof names)[number], Party>;
        for (const n of names) {
            await waitFor(async () => (await wallets[n]!.wallet.getBalance()).available >= funding[n], { what: `${n} funds` });
            p[n] = await walletParty(wallets[n]!.wallet, wallets[n]!.identity);
        }

        const marketId = `lifecycle-${hex.encode(randomBytes(4))}`;
        const { assets, genesisTxid } = await issueMarketAssets(ctx, p.operator, marketId, 1n);
        await waitFor(async () => (await p.operator.coins()).some((c) => c.assets?.some((a) => a.assetId === assets.ctrl)), { what: "genesis" });
        const oracleSecret = randomBytes(32);
        const closeAt = BigInt(Math.floor(Date.now() / 1000)) - 1n;
        const binding = bindingHash({
            schema: 1,
            deployment: { network: "regtest", arkSigner: hex.encode(ark.serverKey), emulatorSigner: hex.encode(ark.emulatorKey!) },
            template: TEMPLATE, marketId, definitionHash: "00".repeat(32),
            collateral: { kind: "BTC", unitSats: UNIT }, claims: { ctrl: assets.ctrl, outcomes: [assets.yes, assets.no] },
            outcomeLabels: ["YES", "NO"], source: null,
            oracle: { keys: [hex.encode(schnorr.getPublicKey(oracleSecret)), hex.encode(schnorr.getPublicKey(oracleSecret)), hex.encode(schnorr.getPublicKey(oracleSecret))], threshold: 1, epoch: 1 },
            timing: { closeAt, timeoutAt: 0n },
        });
        const terms: VaultTerms = {
            assets, unitSats: UNIT, capSats: BASE + 100n * UNIT, oracleKeys: oracleSlots([schnorr.getPublicKey(oracleSecret)], 1), oracleThreshold: 1, binding,
            closeAt, timeoutAt: 0n, exitDelaySeconds: 512n,
        };
        const { vault, resolved } = marketContracts(ark, terms);
        const vaultValue = async (c = vault) => BigInt((await contractCoin(ctx, c))?.value ?? 0);
        const ledger: string[] = [];
        const step = async (label: string, run: () => Promise<{ txid: string }>, expectVault?: bigint, c = vault) => {
            const { txid } = await run();
            if (expectVault !== undefined) await waitFor(async () => (await vaultValue(c)) === expectVault, { what: `${label} vault` });
            ledger.push(`${label.padEnd(34)} tx=${txid.slice(0, 16)} vault=${await vaultValue(c)}`);
        };

        await step("operator opens vault (1 seed set)", () => openVault(ctx, p.operator, terms, 1n, BASE), BASE + UNIT);
        await step("lp mints 20 sets", () => mintSets(ctx, p.lp, terms, 20n), BASE + 21n * UNIT);

        const offerTerms = async (party: Party, w: (typeof wallets)[string] | undefined, t: Partial<OfferTerms> & Pick<OfferTerms, "side" | "assetId" | "priceSats">): Promise<OfferTerms> => ({
            maker: await w!.identity.xOnlyPublicKey(), makerScript: party.script, minFill: 1n, expiresAt: 0n, reserveSats: 330n, exitDelaySeconds: 512n, ...t,
        });
        const live = async (t: OfferTerms, txid: string): Promise<LiveOffer> => {
            const coin = await waitFor(async () => (await spendableCoins(ctx, offerContract(ark, t).pkScript)).find((c) => c.txid === txid), { what: "offer coin" });
            return { terms: t, coin };
        };
        const askYes = await offerTerms(p.lp, wallets.lp, { side: "sell", assetId: assets.yes, priceSats: 600n });
        const askNo = await offerTerms(p.lp, wallets.lp, { side: "sell", assetId: assets.no, priceSats: 450n });
        const askYesLive = await live(askYes, (await postOffer(ctx, p.lp, askYes, 10n)).txid);
        const askNoLive = await live(askNo, (await postOffer(ctx, p.lp, askNo, 10n)).txid);
        ledger.push("lp posts asks: 10 YES @600, 10 NO @450 (lp offline from here)");

        await step("alice buys 4 YES @600", () => takeOffers(ctx, p.alice, [{ offer: askYesLive, qty: 4n }], { maxSpendSats: 2400n }));
        await step("bob buys 3 NO @450", () => takeOffers(ctx, p.bob, [{ offer: askNoLive, qty: 3n }], { maxSpendSats: 1350n }));
        await expect(takeOffers(ctx, p.bob, [{ offer: askNoLive, qty: 1n }], { maxSpendSats: 449n })).rejects.toThrow(/max spend/);

        const bidYes = await offerTerms(p.carol, wallets.carol, { side: "buy", assetId: assets.yes, priceSats: 550n });
        const bidNo = await offerTerms(p.dave, wallets.dave, { side: "buy", assetId: assets.no, priceSats: 480n });
        const bidYesLive = await live(bidYes, (await postOffer(ctx, p.carol, bidYes, 5n)).txid);
        const bidNoLive = await live(bidNo, (await postOffer(ctx, p.dave, bidNo, 5n)).txid);
        await step("keeper mint-matches 5 sets", () => mintMatch(ctx, terms, bidYesLive, bidNoLive, 5n, randomP2TR()), BASE + 26n * UNIT);

        await step("lp merges 5 sets", () => mergeSets(ctx, p.lp, terms, 5n), BASE + 21n * UNIT);

        const evidence = evidenceDigest({ fixture: "dev-oracle", outcome: "YES" });
        const sig = signAttestation(oracleSecret, attestationMessage(binding, evidence, BINARY_VECTORS.yes));
        await step("oracle attests YES; vault resolves", () => resolveMarket(ctx, terms, "yes", evidence, [sig]), BASE + 21n * UNIT, resolved.yes);

        const bal = async (party: Party) => (await party.coins()).reduce((s, c) => s + BigInt(c.value), 0n);
        const aliceBefore = await bal(p.alice);
        const r = await redeemAll(ctx, p.alice, terms, "yes");
        expect(r.payout).toBe(4000n);
        await waitFor(async () => (await bal(p.alice)) === aliceBefore + 4000n, { what: "alice payout" });
        ledger.push(`alice redeems 4 YES -> ${r.payout} sats      vault=${await vaultValue(resolved.yes)}`);
        const carolRedeem = await redeemAll(ctx, p.carol, terms, "yes");
        expect(carolRedeem.payout).toBe(5000n);
        await waitFor(async () => (await vaultValue(resolved.yes)) === BASE + 12n * UNIT, { what: "vault after redemptions" });
        console.log([`genesis=${genesisTxid}`, ...ledger].join("\n"));
    });
});
