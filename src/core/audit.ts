import { Extension, Transaction, asset, type IndexerProvider } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { assetIdOf } from "./assets.js";
import { marketContracts, type ArkadeClient, type VaultTerms } from "./market.js";

/** A market that fails the genesis audit; `code` names the broken rule. */
export class AuditError extends Error {
    constructor(readonly code: string, message: string) {
        super(message);
    }
}

/** What the audit reads: an indexer, and the Arkade client the covenant scripts are derived with. */
export interface AuditSource {
    ark: ArkadeClient;
    indexer: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">;
}

async function fetchTx(indexer: AuditSource["indexer"], txid: string): Promise<Transaction> {
    const { txs } = await indexer.getVirtualTxs([txid]);
    const tx = txs.map((p) => Transaction.fromPSBT(base64.decode(p))).find((t) => t.id === txid);
    if (!tx) throw new AuditError("tx-not-found", `transaction ${txid} is not known to the indexer`);
    return tx;
}

function packetOf(tx: Transaction): asset.Packet | undefined {
    try {
        return Extension.fromTx(tx).getPackets().find((p) => p.type() === asset.Packet.PACKET_TYPE) as asset.Packet | undefined;
    } catch {
        return undefined;
    }
}

const outSum = (g: asset.AssetGroup) => g.outputs.reduce((s, o) => s + o.amount, 0n);
const inSum = (g: asset.AssetGroup) => g.inputs.reduce((s, i) => s + i.input.amount, 0n);
const groupFor = (p: asset.Packet, id: string) => p.groups.find((g) => g.assetId?.toString() === id);

/**
 * Supply is fixed by T0 (CTRL=1, YES=NO=seed, controlled by CTRL) and CTRL must move straight into the vault
 * in T1 without reissuing YES/NO. After that only vault covenants can spend CTRL, so supply == locked sets.
 */
export async function auditGenesis(src: AuditSource, terms: VaultTerms, genesisTxid: string, vaultTxid: string): Promise<{ seed: bigint; baseSats: bigint }> {
    const ids = [0, 1, 2].map((i) => assetIdOf(genesisTxid, i));
    if (ids[0] !== terms.assets.ctrl || ids[1] !== terms.assets.yes || ids[2] !== terms.assets.no) {
        throw new AuditError("asset-ids", "asset ids do not derive from the genesis txid");
    }
    const t0 = packetOf(await fetchTx(src.indexer, genesisTxid));
    const [ctrl, yes, no] = t0?.groups ?? [];
    if (!t0 || !ctrl || !yes || !no) throw new AuditError("genesis-shape", "genesis must issue CTRL, YES, NO as its first three groups");
    // Later groups may only carry the creator's existing assets through; any other issuance is refused.
    if (t0.groups.slice(3).some((g) => g.assetId === null)) throw new AuditError("genesis-shape", "genesis may not issue anything besides CTRL, YES, NO");
    const fresh = (g: asset.AssetGroup) => g.assetId === null && g.inputs.length === 0;
    const byCtrl = (g: asset.AssetGroup) => g.controlAsset?.ref.type === asset.AssetRefType.ByGroup && g.controlAsset.ref.groupIndex === 0;
    if (!fresh(ctrl) || ctrl.controlAsset !== null || outSum(ctrl) !== 1n) throw new AuditError("genesis-ctrl", "CTRL must be a fresh supply of 1 with no control");
    if (!fresh(yes) || !fresh(no) || !byCtrl(yes) || !byCtrl(no)) throw new AuditError("genesis-claims", "YES/NO must be fresh and controlled by CTRL");
    const seed = outSum(yes);
    if (seed <= 0n || outSum(no) !== seed) throw new AuditError("genesis-seed", "YES and NO seed supplies must match");
    const ctrlVout = ctrl.outputs[0]!.vout;
    const { vtxos } = await src.indexer.getVtxos({ outpoints: [{ txid: genesisTxid, vout: ctrlVout }] });
    if (vtxos[0]?.arkTxId !== vaultTxid) throw new AuditError("genesis-ctrl-path", "CTRL did not move directly from genesis into the vault tx");

    const t1tx = await fetchTx(src.indexer, vaultTxid);
    const t1 = packetOf(t1tx);
    const c1 = t1 && groupFor(t1, terms.assets.ctrl);
    if (!t1 || !c1 || c1.outputs.length !== 1 || c1.outputs[0]!.amount !== 1n) throw new AuditError("vault-ctrl", "vault tx must hold CTRL in exactly one output");
    const vaultOut = t1tx.getOutput(c1.outputs[0]!.vout);
    const { vault } = marketContracts(src.ark, terms);
    if (!vaultOut.script || hex.encode(vaultOut.script) !== hex.encode(vault.pkScript)) throw new AuditError("vault-script", "CTRL output is not the vault script for these terms");
    for (const id of [terms.assets.yes, terms.assets.no]) {
        const g = groupFor(t1, id);
        if (g && outSum(g) !== inSum(g)) throw new AuditError("vault-reissue", "vault tx must not change YES/NO supply");
    }
    const baseSats = (vaultOut.amount ?? 0n) - seed * terms.unitSats;
    if (baseSats < 330n) throw new AuditError("vault-collateral", "vault holds less than the seed collateral plus a carrier");
    return { seed, baseSats };
}
