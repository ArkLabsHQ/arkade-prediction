import { CSVMultisigTapscript, Extension, Transaction, arkade, asset, networks } from "@arkade-os/sdk";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { base64, hex } from "@scure/base";
import { assetIdOf } from "../../../src/core/assets.js";
import type { AuditSource } from "../../../src/core/audit.js";
import { genesisPacket, marketContracts, type ArkadeClient, type MarketAssets, type VaultTerms } from "../../../src/core/market.js";

export const UNIT = 1000n;
export const BASE = 1000n;
export const SEED = 2n;

/** A script-deriving Arkade client with fresh operator and emulator keys; it never touches the network. */
export async function offlineArk(): Promise<{ ark: ArkadeClient; signerPubkey: string; emulatorPubkey: string }> {
    const signer = secp256k1.getPublicKey(randomBytes(32), true);
    const emulator = secp256k1.getPublicKey(randomBytes(32), true);
    const checkpoint = CSVMultisigTapscript.encode({ timelock: { type: "seconds", value: 512n }, pubkeys: [signer.slice(1)] });
    const info = { signerPubkey: hex.encode(signer), checkpointTapscript: hex.encode(checkpoint.script), network: "regtest" };
    const ark = await arkade.Arkade.connect({
        arkade: { getInfo: async () => info } as never,
        emulator: {} as never,
        emulatorPubkey: hex.encode(emulator),
        network: networks.regtest,
    });
    return { ark, signerPubkey: info.signerPubkey, emulatorPubkey: hex.encode(emulator) };
}

export const p2tr = () => Uint8Array.from([0x51, 0x20, ...schnorr.getPublicKey(randomBytes(32))]);
const out = (vout: number, amount: bigint) => asset.AssetOutput.create(vout, amount);
export const fresh = (amount: bigint, control: number | null) =>
    asset.AssetGroup.create(null, control === null ? null : asset.AssetRef.fromGroupIndex(control), [], [out(0, amount)], []);
export const transfer = (id: string, ins: [number, bigint][], outs: [number, bigint][]) =>
    asset.AssetGroup.create(asset.AssetId.fromString(id), null, ins.map(([vin, a]) => asset.AssetInput.create(vin, a)), outs.map(([v, a]) => out(v, a)), []);

export function txWith(outputs: { script: Uint8Array; amount: bigint }[], groups: asset.AssetGroup[]): Transaction {
    const t = new Transaction({ version: 3 });
    t.addInput({ txid: randomBytes(32), index: 0 });
    for (const o of outputs) t.addOutput(o);
    t.addOutput(Extension.create([asset.Packet.create(groups)]).txOut());
    return t;
}

export interface Funding {
    genesis?: asset.AssetGroup[];
    /** T1 asset groups; defaults to CTRL into the vault and the seed claims into change. */
    vaultGroups?: (a: MarketAssets, seed: bigint) => asset.AssetGroup[];
    vaultScript?: (vault: Uint8Array) => Uint8Array;
    vaultSats?: bigint;
    ctrlSpender?: (vaultTxid: string) => string;
    hideTxs?: boolean;
    terms?: (assets: MarketAssets) => VaultTerms;
}

/** Genesis T0 and vault T1 behind a fake indexer, as a creator (or a forger) would leave them. */
export function fundedMarket(ark: ArkadeClient, v: Funding = {}) {
    const t0 = txWith([{ script: p2tr(), amount: 330n }], v.genesis ?? genesisPacket("m", 0, SEED).groups);
    const genesisTxid = t0.id;
    const assets = { ctrl: assetIdOf(genesisTxid, 0), yes: assetIdOf(genesisTxid, 1), no: assetIdOf(genesisTxid, 2) };
    const terms: VaultTerms = v.terms?.(assets) ?? {
        assets, unitSats: UNIT, capSats: BASE + 100n * UNIT, oracleKey: randomBytes(32), binding: randomBytes(32),
        closeAt: 1_900_000_000n, timeoutAt: 1_902_592_000n, exitDelaySeconds: 512n,
    };
    const vault = marketContracts(ark, terms).vault.pkScript;
    const t1 = txWith([
        { script: v.vaultScript?.(vault) ?? vault, amount: v.vaultSats ?? BASE + SEED * UNIT },
        { script: p2tr(), amount: 330n },
    ], v.vaultGroups?.(assets, SEED) ?? [
        transfer(assets.ctrl, [[0, 1n]], [[0, 1n]]),
        transfer(assets.yes, [[0, SEED]], [[1, SEED]]),
        transfer(assets.no, [[0, SEED]], [[1, SEED]]),
    ]);
    const vaultTxid = t1.id;
    const txs = new Map(v.hideTxs ? [] : [t0, t1].map((t) => [t.id, base64.encode(t.toPSBT())]));
    const spender = v.ctrlSpender?.(vaultTxid) ?? vaultTxid;
    const indexer = {
        getVirtualTxs: async (ids: string[]) => ({ txs: ids.flatMap((id) => (txs.has(id) ? [txs.get(id)!] : [])) }),
        getVtxos: async (q: { outpoints: { txid: string; vout: number }[] }) => ({
            vtxos: q.outpoints.filter((o) => o.txid === genesisTxid && o.vout === 0).map((o) => ({ ...o, arkTxId: spender, isSpent: true })),
        }),
    } as unknown as AuditSource["indexer"];
    return { genesisTxid, vaultTxid, terms, indexer };
}
