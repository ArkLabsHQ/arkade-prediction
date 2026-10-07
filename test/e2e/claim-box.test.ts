import { describe, expect, it } from "vitest";
import { networks, SingleKey } from "@arkade-os/sdk";
import { postOffer, resolveMarket, spendableCoins, takeOffers, walletParty, mintSets, execute, type Ctx } from "../../src/core/actions.js";
import { attestationMessage, evidenceDigest, signAttestation } from "../../src/core/attestation.js";
import { autoClaim, claimBoxContract } from "../../src/core/claimBox.js";
import { BINARY_VECTORS } from "../../src/core/payout.js";
import { renewCovenantVtxos } from "../../src/core/renewal.js";
import { arkProvider, connectArkade, emulatorProvider, expectCovenantRejection, faucet, indexerProvider, newWallet, randomP2TR, waitFor } from "./env.js";
import { createMarket, network } from "./market.js";

describe("claim box: owner offline through renewal and payout", () => {
    it("renews and redeems a holder's claims without the holder's key", { timeout: 900_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const lpW = await newWallet();
        const danaW = await newWallet();
        faucet(await lpW.wallet.getAddress(), 40_000);
        faucet(await danaW.wallet.getAddress(), 10_000);
        await waitFor(async () => (await lpW.wallet.getBalance()).available >= 40_000, { what: "lp funds" });
        await waitFor(async () => (await danaW.wallet.getBalance()).available >= 10_000, { what: "dana funds" });
        const lp = await walletParty(lpW.wallet, lpW.identity);
        const dana = await walletParty(danaW.wallet, danaW.identity);
        const m = await createMarket(ark, lpW, { closeAt: BigInt(Math.floor(Date.now() / 1000) - 1) });
        await mintSets(ctx, lp, m.terms, 5n);
        const ask = { side: "sell" as const, maker: await lpW.identity.xOnlyPublicKey(), makerScript: lp.script, assetId: m.assets.yes, priceSats: 700n, minFill: 1n, expiresAt: 0n, reserveSats: 330n, exitDelaySeconds: 512n };
        await waitFor(async () => (await lp.coins()).some((c) => c.assets?.some((a) => a.assetId === m.assets.yes && a.amount >= 5n)), { what: "lp claims" });
        const posted = await postOffer(ctx, lp, ask, 5n);
        const askCoin = await waitFor(async () => (await spendableCoins(ctx, posted.contract.pkScript)).find((c) => c.txid === posted.txid), { what: "ask" });

        // Dana buys 3 YES straight into her claim box, then goes offline: no more Dana signatures below.
        const owner = { owner: await danaW.identity.xOnlyPublicKey(), ownerScript: dana.script };
        const box = claimBoxContract(ark, m.terms, owner);
        const bought = await takeOffers(ctx, dana, [{ offer: { terms: ask, coin: askCoin }, qty: 3n }], { maxSpendSats: 2100n, receiveScript: box.pkScript });
        let boxCoin = await waitFor(async () => (await spendableCoins(ctx, box.pkScript)).find((c) => c.txid === bought.txid), { what: "box funded" });
        expect(boxCoin.assets).toEqual([{ assetId: m.assets.yes, amount: 3n }]);
        const danaBefore = (await dana.coins()).reduce((s, c) => s + BigInt(c.value), 0n);

        // Keeper renews the box (and the vault) through a batch.
        const vaultCoin = (await spendableCoins(ctx, m.vault.pkScript))[0]!;
        const { commitmentTxid } = await renewCovenantVtxos(
            { ark: arkProvider, emulator: emulatorProvider, indexer: indexerProvider, network: networks.regtest },
            [{ coin: boxCoin, contract: box }, { coin: vaultCoin, contract: m.vault }],
            SingleKey.fromRandomBytes().signerSession(),
        );
        boxCoin = await waitFor(async () => {
            const { vtxos } = await indexerProvider.getVtxos({ scripts: [Buffer.from(box.pkScript).toString("hex")], spendableOnly: true });
            const v = vtxos.find((x) => x.commitmentTxIds?.includes(commitmentTxid));
            return v && { txid: v.txid, vout: v.vout, value: v.value, assets: v.assets };
        }, { what: "renewed box" });
        expect(boxCoin.assets).toEqual([{ assetId: m.assets.yes, amount: 3n }]);

        // Oracle resolves YES; a keeper pays Dana. Paying anyone else, or claiming without a resolved vault, is refused.
        const evidence = evidenceDigest({ fixture: "claim-box", outcome: "YES" });
        await resolveMarket(ctx, m.terms, "yes", evidence, signAttestation(m.oracleSecret, attestationMessage(m.binding, evidence, BINARY_VECTORS.yes)));
        await waitFor(async () => (await spendableCoins(ctx, m.resolved.yes.pkScript)).length === 1, { what: "resolved" });
        const vaultNow = (await spendableCoins(ctx, m.resolved.yes.pkScript))[0]!;
        await expectCovenantRejection(execute(ctx, [
            { kind: "covenant", coin: vaultNow, contract: m.resolved.yes, fn: "redeem", args: { yesBurn: 3n, noBurn: 0n } },
            { kind: "covenant", coin: boxCoin, contract: box, fn: "claim" },
        ], [
            { script: m.resolved.yes.pkScript, amount: BigInt(vaultNow.value) - 3000n, assets: [{ assetId: m.assets.ctrl, amount: 1n }] },
            { script: randomP2TR(), amount: BigInt(boxCoin.value) + 3000n },
        ]), "payout redirected");
        await expectCovenantRejection(execute(ctx, [{ kind: "covenant", coin: boxCoin, contract: box, fn: "claim" }], [{ script: dana.script, amount: BigInt(boxCoin.value), assets: boxCoin.assets }]), "claim without vault");
        const paid = await autoClaim(ctx, m.terms, "yes", owner, boxCoin);
        expect(paid.payout).toBe(3000n);
        await waitFor(async () => (await dana.coins()).reduce((s, c) => s + BigInt(c.value), 0n) === danaBefore + 330n + 3000n, { what: "dana paid" });
        console.log(`box renew=${commitmentTxid} autoClaim=${paid.txid}`);
    });
});
