import { describe, expect, it } from "vitest";
import { execute, mintSets, redeemAll, resolveMarket, selectWalletInputs, spendableCoins, timeoutMarket, walletParty, type Ctx } from "../../src/core/actions.js";
import { attestationMessage, evidenceDigest, signAttestation } from "../../src/core/attestation.js";
import { BINARY_VECTORS } from "../../src/core/payout.js";
import { connectArkade, expectCovenantRejection, faucet, indexerProvider, newWallet, waitFor } from "./env.js";
import { createMarket, network, type TestMarket } from "./market.js";

const nowS = () => BigInt(Math.floor(Date.now() / 1000));
const sleepUntil = (unix: bigint) => new Promise((r) => setTimeout(r, Math.max(0, Number(unix) * 1000 - Date.now() + 1500)));

describe("settlement paths", () => {
    it("refuses early attestations, times out to 50/50, and pays fractional and attested-invalid redemptions", { timeout: 900_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const aliceW = await newWallet();
        const bobW = await newWallet();
        await faucet(await aliceW.wallet.getAddress(), 60_000);
        await faucet(await bobW.wallet.getAddress(), 5_000);
        await waitFor(async () => (await aliceW.wallet.getBalance()).available >= 60_000, { what: "alice funds" });
        await waitFor(async () => (await bobW.wallet.getBalance()).available >= 5_000, { what: "bob funds" });
        const alice = await walletParty(aliceW.wallet, aliceW.identity);
        const bob = await walletParty(bobW.wallet, bobW.identity);
        const sig = (m: TestMarket, outcome: keyof typeof BINARY_VECTORS) => {
            const evidence = evidenceDigest({ market: m.binding, outcome });
            return { evidence, sig: signAttestation(m.oracleSecret, attestationMessage(m.binding, evidence, BINARY_VECTORS[outcome])) };
        };
        const yesAsset = (m: TestMarket) => m.assets.yes;

        // Market A: close in 20 s, timeout in 35 s, no attestation ever arrives.
        const A = await createMarket(ark, aliceW, { closeAt: nowS() + 20n, timeoutAt: nowS() + 35n });
        await mintSets(ctx, alice, A.terms, 4n);
        const early = sig(A, "yes");
        await expectCovenantRejection(resolveMarket(ctx, A.terms, "yes", early.evidence, [early.sig]), "attestation before close");
        await expectCovenantRejection(timeoutMarket(ctx, A.terms), "timeout before deadline");

        // Transfer 1 YES to Bob peer to peer before resolution.
        const yesHeld = async () => (await alice.coins()).reduce((s, c) => s + (c.assets ?? []).filter((a) => a.assetId === yesAsset(A)).reduce((t, a) => t + a.amount, 0n), 0n);
        await waitFor(async () => (await yesHeld()) >= 5n, { what: "alice claims" });
        const inputs = await selectWalletInputs(alice, 660n, [{ assetId: yesAsset(A), amount: 1n }]);
        const held = new Map<string, bigint>();
        for (const i of inputs) for (const a of i.coin.assets ?? []) held.set(a.assetId, (held.get(a.assetId) ?? 0n) + a.amount);
        held.set(yesAsset(A), held.get(yesAsset(A))! - 1n);
        const total = inputs.reduce((s, i) => s + BigInt(i.coin.value), 0n);
        await execute(ctx, inputs, [
            { script: bob.script, amount: 330n, assets: [{ assetId: yesAsset(A), amount: 1n }] },
            { script: alice.script, amount: total - 330n, assets: [...held].filter(([, v]) => v > 0n).map(([assetId, amount]) => ({ assetId, amount })) },
        ], alice);
        await waitFor(async () => (await bob.coins()).some((c) => c.assets?.some((a) => a.assetId === yesAsset(A))), { what: "bob received claim" });

        await sleepUntil(A.terms.timeoutAt);
        await timeoutMarket(ctx, A.terms);
        await waitFor(async () => (await spendableCoins(ctx, A.resolved.invalid.pkScript)).length === 1, { what: "timed out" });
        // The attested path is now impossible: the open vault no longer exists.
        const late = sig(A, "yes");
        await expect(resolveMarket(ctx, A.terms, "yes", late.evidence, [late.sig])).rejects.toThrow(/vault not found/);

        // INVALID pays 1/2 unit per claim on either side; Bob's single YES gets exactly 500.
        const bobPaid = await redeemAll(ctx, bob, A.terms, "invalid");
        expect(bobPaid.payout).toBe(500n);
        const alicePaid = await redeemAll(ctx, alice, A.terms, "invalid");
        // Alice: seed 1+1 and minted 4+4 minus the YES she gave away = 4 YES + 5 NO -> 9 * 500.
        expect(alicePaid.yesBurn + alicePaid.noBurn).toBe(9n);
        expect(alicePaid.payout).toBe(4500n);
        await waitFor(async () => BigInt((await spendableCoins(ctx, A.resolved.invalid.pkScript))[0]?.value ?? -1) === 1000n, { what: "only the base remains" });

        // Market B: the oracle attests INVALID after close.
        const B = await createMarket(ark, aliceW, { closeAt: nowS() + 5n });
        await sleepUntil(B.terms.closeAt);
        const inv = sig(B, "invalid");
        const wrong = sig(B, "no");
        await expectCovenantRejection(resolveMarket(ctx, B.terms, "invalid", wrong.evidence, [wrong.sig]), "NO certificate on INVALID path");
        await resolveMarket(ctx, B.terms, "invalid", inv.evidence, [inv.sig]);
        await waitFor(async () => (await spendableCoins(ctx, B.resolved.invalid.pkScript)).length === 1, { what: "B invalid" });
        const seed = await redeemAll(ctx, alice, B.terms, "invalid");
        expect(seed.payout).toBe(1000n);
    });
});
