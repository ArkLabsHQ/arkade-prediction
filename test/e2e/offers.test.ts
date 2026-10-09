import { describe, expect, it } from "vitest";
import { networks, SingleKey } from "@arkade-os/sdk";
import { buildArkadeTx, signInputs, submitArkadeTx, type InputSpec, type OutputSpec } from "../../src/core/arkadeTx.js";
import { offerContract, type OfferTerms } from "../../src/core/offers.js";
import { renewCovenantVtxos } from "../../src/core/renewal.js";
import { arkProvider, connectArkade, emulatorProvider, expectCovenantRejection, faucet, indexerProvider, newWallet, randomP2TR, waitFor } from "./env.js";
import { assetBalance, coinAt, createMarket, network, scriptOf, sumValue, walletInputs, walletSend, type TestWallet } from "./market.js";

const CARRIER = 330n;

describe("funded standing offers", () => {
    it("fills, partially fills, settles, matches, expires, cancels and renews with makers offline", { timeout: 900_000 }, async () => {
        const ark = await connectArkade();
        const net = network(ark);
        const [lp, bob, carol, dave, erin, frank] = await Promise.all([1, 2, 3, 4, 5, 6].map(() => newWallet()));
        const fund: [TestWallet, number][] = [[lp!, 100_000], [bob!, 20_000], [carol!, 20_000], [dave!, 20_000], [erin!, 20_000], [frank!, 20_000]];
        for (const [w, amount] of fund) await faucet(await w.wallet.getAddress(), amount);
        for (const [w, amount] of fund) await waitFor(async () => (await w.wallet.getBalance()).available >= amount, { what: "funding" });

        const m = await createMarket(ark, lp!);
        const send = async (inputs: InputSpec[], outputs: OutputSpec[], signer?: TestWallet) => {
            const built = await buildArkadeTx(net, inputs, outputs);
            if (signer) await signInputs(built, signer.identity, built.signerInputs);
            return submitArkadeTx(net, built, signer ? (cp) => signer.identity.sign(cp, [0]) : undefined);
        };
        const terms = async (w: TestWallet, t: Pick<OfferTerms, "side" | "assetId" | "priceSats"> & Partial<OfferTerms>): Promise<OfferTerms> => ({
            maker: await w.identity.xOnlyPublicKey(), makerScript: await scriptOf(w), minFill: 1n, expiresAt: 0n,
            reserveSats: CARRIER, exitDelaySeconds: 512n, ...t,
        });

        // LP mints 20 sets.
        const lpIn = await walletInputs(lp!, (c) => !c.assets?.length);
        const minted = await send([{ kind: "covenant", coin: m.vaultCoin, contract: m.vault, fn: "mint", args: { n: 20n } }, ...lpIn], [
            { script: m.vault.pkScript, amount: BigInt(m.vaultCoin.value) + 20_000n, assets: [{ assetId: m.assets.ctrl, amount: 1n }] },
            { script: await scriptOf(lp!), amount: CARRIER, assets: [{ assetId: m.assets.yes, amount: 20n }, { assetId: m.assets.no, amount: 20n }] },
            { script: await scriptOf(lp!), amount: sumValue(lpIn) - 20_000n - CARRIER },
        ], lp);
        let vaultCoin = await coinAt(m.vault.pkScript, "vault", minted.txid);
        await waitFor(async () => (await assetBalance(lp!, m.assets.yes)) === 21n, { what: "lp claims" });

        // Sell offer A: 10 YES @ 600, min fill 2. LP is offline from here on.
        const tA = await terms(lp!, { side: "sell", assetId: m.assets.yes, priceSats: 600n, minFill: 2n });
        const A = offerContract(ark, tA);
        const fundA = await walletSend(ark, lp!, [{ script: A.pkScript, amount: CARRIER, assets: [{ assetId: m.assets.yes, amount: 10n }] }]);
        let aCoin = await coinAt(A.pkScript, "offer A", fundA);

        const takeA = async (taker: TestWallet, qty: bigint, paid: bigint, left: bigint, got = qty) => {
            const tin = await walletInputs(taker);
            return send([{ kind: "covenant", coin: aCoin, contract: A, fn: "fill", args: { qty } }, ...tin], [
                left > 0n
                    ? { script: A.pkScript, amount: BigInt(aCoin.value) + paid, assets: [{ assetId: m.assets.yes, amount: left }] }
                    : { script: tA.makerScript, amount: BigInt(aCoin.value) + paid },
                { script: await scriptOf(taker), amount: CARRIER, assets: [{ assetId: m.assets.yes, amount: got }] },
                { script: await scriptOf(taker), amount: sumValue(tin) - paid - CARRIER },
            ], taker);
        };
        await expectCovenantRejection(takeA(bob!, 3n, 1799n, 7n), "underpaid fill");
        await expectCovenantRejection(takeA(bob!, 3n, 1800n, 6n, 4n), "taker skims remainder");
        await expectCovenantRejection(takeA(bob!, 1n, 600n, 9n), "below min fill");
        const fill1 = await takeA(bob!, 3n, 1800n, 7n);
        aCoin = await coinAt(A.pkScript, "offer A after partial fill", fill1.txid);
        expect(aCoin.assets).toEqual([{ assetId: m.assets.yes, amount: 7n }]);
        // Buying the last 7 pays the LP directly: carrier + 1800 + 4200.
        const fill2 = await takeA(carol!, 7n, 4200n, 0n);
        expect((await coinAt(tA.makerScript, "lp proceeds", fill2.txid)).value).toBe(Number(CARRIER + 6000n));
        expect(await assetBalance(carol!, m.assets.yes)).toBe(7n);

        // 330-sat rules: sell offer D (6 YES @ 200) refuses a sub-330 fill and a fill leaving a sub-330 remainder.
        const tD = await terms(lp!, { side: "sell", assetId: m.assets.yes, priceSats: 200n });
        const D = offerContract(ark, tD);
        const dCoin = await coinAt(D.pkScript, "offer D", await walletSend(ark, lp!, [{ script: D.pkScript, amount: CARRIER, assets: [{ assetId: m.assets.yes, amount: 6n }] }]));
        const takeD = async (qty: bigint) => {
            const tin = await walletInputs(bob!, (c) => !c.assets?.length);
            return send([{ kind: "covenant", coin: dCoin, contract: D, fn: "fill", args: { qty } }, ...tin], [
                { script: D.pkScript, amount: CARRIER + qty * 200n, assets: [{ assetId: m.assets.yes, amount: 6n - qty }] },
                { script: await scriptOf(bob!), amount: CARRIER, assets: [{ assetId: m.assets.yes, amount: qty }] },
                { script: await scriptOf(bob!), amount: sumValue(tin) - qty * 200n - CARRIER },
            ], bob);
        };
        await expectCovenantRejection(takeD(1n), "fill under 330 sats");
        await expectCovenantRejection(takeD(5n), "remainder under 330 sats");
        await takeD(2n);

        // Buy offer H (Frank: NO @ 100, budget 1000): a fill leaving 200 sats of budget must close to the maker.
        const tH = await terms(frank!, { side: "buy", assetId: m.assets.no, priceSats: 100n });
        const H = offerContract(ark, tH);
        const hCoin = await coinAt(H.pkScript, "offer H", await walletSend(ark, frank!, [{ script: H.pkScript, amount: 1000n + CARRIER }]));
        const sellIntoH = async (qty: bigint, to: Uint8Array) => {
            const lin = await walletInputs(lp!, (c) => !!c.assets?.length);
            const held = (id: string) => lin.reduce((s, i) => s + (i.coin.assets ?? []).filter((a) => a.assetId === id).reduce((t, a) => t + a.amount, 0n), 0n);
            const rest = [{ assetId: m.assets.no, amount: held(m.assets.no) - qty }, { assetId: m.assets.yes, amount: held(m.assets.yes) }].filter((a) => a.amount > 0n);
            return send([{ kind: "covenant", coin: hCoin, contract: H, fn: "fill", args: { qty } }, ...lin], [
                { script: to, amount: BigInt(hCoin.value) - qty * 100n, assets: [{ assetId: m.assets.no, amount: qty }] },
                { script: await scriptOf(lp!), amount: sumValue(lin) + qty * 100n, assets: rest },
            ], lp);
        };
        await expectCovenantRejection(sellIntoH(3n, H.pkScript), "bid fill under 330 sats");
        await expectCovenantRejection(sellIntoH(8n, H.pkScript), "bid kept open with 200 sats of budget");
        await sellIntoH(8n, tH.makerScript);

        // Buy offer B (Dave): NO @ 350, budget 3500. Dave goes offline; the LP sells 4 NO into it.
        const tB = await terms(dave!, { side: "buy", assetId: m.assets.no, priceSats: 350n });
        const B = offerContract(ark, tB);
        let bCoin = await coinAt(B.pkScript, "offer B", await walletSend(ark, dave!, [{ script: B.pkScript, amount: 3500n + CARRIER }]));
        const sellIntoB = async (spent: bigint, delivered: bigint) => {
            const lin = await walletInputs(lp!, (c) => !!c.assets?.some((a) => a.assetId === m.assets.no));
            const noHeld = lin.reduce((s, i) => s + (i.coin.assets ?? []).filter((a) => a.assetId === m.assets.no).reduce((t, a) => t + a.amount, 0n), 0n);
            const yesHeld = lin.reduce((s, i) => s + (i.coin.assets ?? []).filter((a) => a.assetId === m.assets.yes).reduce((t, a) => t + a.amount, 0n), 0n);
            return send([{ kind: "covenant", coin: bCoin, contract: B, fn: "fill", args: { qty: 4n } }, ...lin], [
                { script: B.pkScript, amount: BigInt(bCoin.value) - spent, assets: [{ assetId: m.assets.no, amount: delivered }] },
                {
                    script: await scriptOf(lp!), amount: sumValue(lin) + spent,
                    assets: [{ assetId: m.assets.no, amount: noHeld - delivered }, ...(yesHeld > 0n ? [{ assetId: m.assets.yes, amount: yesHeld }] : [])],
                },
            ], lp);
        };
        await expectCovenantRejection(sellIntoB(1401n, 4n), "buy offer overspent");
        await expectCovenantRejection(sellIntoB(1400n, 3n), "short delivery");
        const soldB = await sellIntoB(1400n, 4n);
        bCoin = await coinAt(B.pkScript, "offer B after fill", soldB.txid);
        expect(BigInt(bCoin.value)).toBe(2100n + CARRIER);

        // Mint-match: Erin bids YES @ 700, Frank bids NO @ 400; a keeper mints 5 sets between them.
        const tE = await terms(erin!, { side: "buy", assetId: m.assets.yes, priceSats: 700n });
        const tF = await terms(frank!, { side: "buy", assetId: m.assets.no, priceSats: 400n });
        const E = offerContract(ark, tE);
        const F = offerContract(ark, tF);
        let eCoin = await coinAt(E.pkScript, "offer E", await walletSend(ark, erin!, [{ script: E.pkScript, amount: 7000n + CARRIER }]));
        let fCoin = await coinAt(F.pkScript, "offer F", await walletSend(ark, frank!, [{ script: F.pkScript, amount: 4000n + CARRIER }]));
        const keeperScript = randomP2TR();
        const matched = await send([
            { kind: "covenant", coin: vaultCoin, contract: m.vault, fn: "mint", args: { n: 5n } },
            { kind: "covenant", coin: eCoin, contract: E, fn: "fill", args: { qty: 5n } },
            { kind: "covenant", coin: fCoin, contract: F, fn: "fill", args: { qty: 5n } },
        ], [
            { script: m.vault.pkScript, amount: BigInt(vaultCoin.value) + 5000n, assets: [{ assetId: m.assets.ctrl, amount: 1n }] },
            { script: E.pkScript, amount: BigInt(eCoin.value) - 3500n, assets: [{ assetId: m.assets.yes, amount: 5n }] },
            { script: F.pkScript, amount: BigInt(fCoin.value) - 2000n, assets: [{ assetId: m.assets.no, amount: 5n }] },
            { script: keeperScript, amount: 500n },
        ]);
        vaultCoin = await coinAt(m.vault.pkScript, "vault after match", matched.txid);
        eCoin = await coinAt(E.pkScript, "offer E after match", matched.txid);
        fCoin = await coinAt(F.pkScript, "offer F after match", matched.txid);
        expect(BigInt(vaultCoin.value)).toBe(1000n + 26n * 1000n);

        // Expiry: an offer past its deadline cannot be filled but anyone can return it.
        const tC = await terms(lp!, { side: "sell", assetId: m.assets.yes, priceSats: 900n, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 8) });
        const C = offerContract(ark, tC);
        const cCoin = await coinAt(C.pkScript, "offer C", await walletSend(ark, lp!, [{ script: C.pkScript, amount: CARRIER, assets: [{ assetId: m.assets.yes, amount: 2n }] }]));
        await new Promise((r) => setTimeout(r, 12_000));
        const bin = await walletInputs(bob!, (c) => !c.assets?.length);
        await expectCovenantRejection(send([{ kind: "covenant", coin: cCoin, contract: C, fn: "fill", args: { qty: 2n } }, ...bin], [
            { script: C.pkScript, amount: CARRIER + 1800n },
            { script: await scriptOf(bob!), amount: CARRIER, assets: [{ assetId: m.assets.yes, amount: 2n }] },
            { script: await scriptOf(bob!), amount: sumValue(bin) - 1800n - CARRIER },
        ], bob), "fill after expiry");
        await expectCovenantRejection(send([{ kind: "covenant", coin: cCoin, contract: C, fn: "settle" }], [{ script: randomP2TR(), amount: CARRIER, assets: [{ assetId: m.assets.yes, amount: 2n }] }]), "settle to stranger");
        await send([{ kind: "covenant", coin: cCoin, contract: C, fn: "settle" }], [{ script: tC.makerScript, amount: CARRIER, assets: [{ assetId: m.assets.yes, amount: 2n }] }]);

        // An expired bid that never traded holds no assets: settle must work without an asset packet.
        const tG = await terms(dave!, { side: "buy", assetId: m.assets.yes, priceSats: 100n, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 5) });
        const G = offerContract(ark, tG);
        const gCoin = await coinAt(G.pkScript, "offer G", await walletSend(ark, dave!, [{ script: G.pkScript, amount: 1000n + CARRIER }]));
        await new Promise((r) => setTimeout(r, 8_000));
        await send([{ kind: "covenant", coin: gCoin, contract: G, fn: "settle" }], [{ script: tG.makerScript, amount: BigInt(gCoin.value) }]);

        // Dave comes back online and cancels the remainder of B with his own key (maker + operator leaf).
        const cancelled = await send([{ kind: "tapscript", coin: bCoin, contract: B, fn: "cancel" }], [
            { script: tB.makerScript, amount: BigInt(bCoin.value), assets: [{ assetId: m.assets.no, amount: 4n }] },
        ], dave);
        await waitFor(async () => (await assetBalance(dave!, m.assets.no)) === 4n, { what: "cancel proceeds" });

        // Keeper renews the vault and both live bids (assets + sats) in a single intent.
        const { commitmentTxid } = await renewCovenantVtxos(
            { ark: arkProvider, emulator: emulatorProvider, indexer: indexerProvider, network: networks.regtest },
            [{ coin: vaultCoin, contract: m.vault }, { coin: eCoin, contract: E }, { coin: fCoin, contract: F }],
            SingleKey.fromRandomBytes().signerSession(),
        );
        for (const [c, coin] of [[m.vault, vaultCoin], [E, eCoin], [F, fCoin]] as const) {
            const renewed = await waitFor(async () => {
                const { vtxos } = await indexerProvider.getVtxos({ scripts: [Buffer.from(c.pkScript).toString("hex")], spendableOnly: true });
                return vtxos.find((v) => v.commitmentTxIds?.includes(commitmentTxid));
            }, { what: "renewed offer" });
            expect(renewed.value).toBe(coin.value);
            expect(renewed.assets).toEqual(coin.assets);
        }
        console.log(`fills=${fill1.txid},${fill2.txid} match=${matched.txid} cancel=${cancelled.txid} renew=${commitmentTxid}`);
    });
});
