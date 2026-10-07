import { describe, expect, it } from "vitest";
import { Extension, Intent, SingleKey, asset, networks, withPrevTxs } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { buildArkadeTx, submitArkadeTx } from "../../src/core/arkadeTx.js";
import { renewCovenantVtxos } from "../../src/core/renewal.js";
import { arkProvider, connectArkade, emulatorProvider, expectCovenantRejection, faucet, indexerProvider, newWallet, randomP2TR, waitFor } from "./env.js";
import { coinAt, createMarket, network } from "./market.js";

describe("offline covenant renewal", () => {
    it("re-anchors an asset-bearing vault through a batch with no owner key", { timeout: 600_000 }, async () => {
        const ark = await connectArkade();
        const creator = await newWallet();
        faucet(await creator.wallet.getAddress(), 30_000);
        await waitFor(async () => (await creator.wallet.getBalance()).available >= 30_000, { what: "creator funds" });
        const m = await createMarket(ark, creator);
        const before = (await indexerProvider.getVtxos({ outpoints: [{ txid: m.vaultCoin.txid, vout: m.vaultCoin.vout }] })).vtxos[0]!;

        // The renew covenant only runs in intent proofs (v2); an Arkade tx (v3) self-send is refused.
        const selfSend = buildArkadeTx(network(ark), [{ kind: "covenant", coin: m.vaultCoin, contract: m.vault, fn: "renew" }], [
            { script: m.vault.pkScript, amount: BigInt(m.vaultCoin.value), assets: [{ assetId: m.assets.ctrl, amount: 1n }] },
        ]).then((b) => submitArkadeTx(network(ark), b));
        await expectCovenantRejection(selfSend, "renew outside an intent");

        // An intent that tunnels the vault anywhere else is refused by the emulator before arkd sees it.
        const renewLeaf = m.vault.vtxoScript.functionByName("renew")!;
        const [coin] = await withPrevTxs([{
            txid: m.vaultCoin.txid, vout: m.vaultCoin.vout, value: m.vaultCoin.value, tapTree: m.vault.tapTree,
            forfeitTapLeafScript: renewLeaf.tapLeafScript, intentTapLeafScript: renewLeaf.tapLeafScript,
            status: { confirmed: true }, assets: m.vaultCoin.assets,
        }], indexerProvider);
        const thief = randomP2TR();
        const message: Intent.RegisterMessage = { type: "register", onchain_output_indexes: [], valid_at: 0, expire_at: 0, cosigners_public_keys: [hex.encode(await SingleKey.fromRandomBytes().signerSession().getPublicKey())] };
        const ext = Extension.create([
            asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(m.assets.ctrl), null, [asset.AssetInput.create(1, 1n)], [asset.AssetOutput.create(0, 1n)], [])]),
            (await import("@arkade-os/sdk")).EmulatorPacket.create([{ vin: 1, script: renewLeaf.arkadeScript!, witness: new Uint8Array(0) }]),
        ] as never);
        const stolen = Intent.create(message, [coin!], [{ script: thief, amount: BigInt(m.vaultCoin.value) }, ext.txOut()]);
        await expectCovenantRejection(emulatorProvider.submitIntent({ proof: base64.encode(stolen.toPSBT()), message }), "intent redirects vault");

        // Keeper renewal: only a throwaway musig session key, never the creator's or any holder's key.
        const keeperSession = SingleKey.fromRandomBytes().signerSession();
        const { commitmentTxid } = await renewCovenantVtxos(
            { ark: arkProvider, emulator: emulatorProvider, indexer: indexerProvider, network: networks.regtest },
            [{ coin: m.vaultCoin, contract: m.vault }],
            keeperSession,
        );
        const renewed = await waitFor(async () => {
            const { vtxos } = await indexerProvider.getVtxos({ scripts: [hex.encode(m.vault.pkScript)], spendableOnly: true });
            return vtxos.find((v) => v.txid !== m.vaultCoin.txid);
        }, { what: "renewed vault" });
        expect(renewed.value).toBe(m.vaultCoin.value);
        expect(renewed.assets).toEqual([{ assetId: m.assets.ctrl, amount: 1n }]);
        expect(renewed.commitmentTxIds).toContain(commitmentTxid);
        const old = (await indexerProvider.getVtxos({ outpoints: [{ txid: m.vaultCoin.txid, vout: m.vaultCoin.vout }] })).vtxos[0]!;
        expect(old.isSpent || !!old.settledBy).toBe(true);
        console.log(`renewal commitment=${commitmentTxid} oldExpiry=${before.expiresAt?.toISOString()} newExpiry=${renewed.expiresAt?.toISOString()}`);
        expect(renewed.expiresAt!.getTime()).toBeGreaterThan(before.expiresAt!.getTime());

        // The renewed vault still enforces the same covenant.
        const vaultCoin = await coinAt(m.vault.pkScript, "renewed vault", renewed.txid);
        const merge = buildArkadeTx(network(ark), [{ kind: "covenant", coin: vaultCoin, contract: m.vault, fn: "merge", args: { n: 1n } }], [
            { script: m.vault.pkScript, amount: BigInt(vaultCoin.value) - 1000n, assets: [{ assetId: m.assets.ctrl, amount: 1n }] },
            { script: randomP2TR(), amount: 1000n },
        ]).then((b) => submitArkadeTx(network(ark), b));
        await expectCovenantRejection(merge, "merge without burning claims");
    });
});
