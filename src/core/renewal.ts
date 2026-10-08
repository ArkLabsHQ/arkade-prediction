import {
    Batch,
    CSVMultisigTapscript,
    EmulatorPacket,
    Extension,
    Intent,
    Transaction,
    VtxoScript,
    asset,
    assertFinalCommitmentMatchesValidated,
    assertValidBatchExpiry,
    buildForfeitTx,
    resolveBatchExpiryPolicy,
    validateBatchRecipients,
    validateConnectorsTxGraph,
    validateVtxoTxGraph,
    withPrevTxs,
    type ArkProvider,
    type ConnectorTreeNode,
    type EmulatorProvider,
    type IndexerProvider,
    type Network,
    type SignerSession,
} from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { Address, OutScript, SigHash } from "@scure/btc-signer";
import { sha256 } from "@noble/hashes/sha2.js";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import type { Coin } from "./arkadeTx.js";
import type { Contract } from "./market.js";

export interface RenewTarget {
    coin: Coin & { isSwept?: boolean };
    contract: Contract;
    /** Covenant function that tunnels the input to output (vin - 1) of the intent proof. */
    fn?: string;
}

export interface RenewDeps {
    ark: ArkProvider;
    emulator: EmulatorProvider;
    indexer: Pick<IndexerProvider, "getVirtualTxs">;
    network: Network;
}

/**
 * Re-anchors covenant VTXOs into a new batch without any owner key: the emulator signs the intent proof
 * after running each `renew` covenant and later co-signs the forfeits. Returns the commitment txid.
 */
export async function renewCovenantVtxos(
    deps: RenewDeps,
    targets: RenewTarget[],
    session: SignerSession,
    opts: { signal?: AbortSignal } = {},
): Promise<{ commitmentTxid: string; intentId: string }> {
    if (targets.length === 0) throw new Error("nothing to renew");
    const legs = targets.map((t) => {
        const compiled = t.contract.vtxoScript.functionByName(t.fn ?? "renew");
        if (!compiled?.arkadeScript) throw new Error(`${t.fn ?? "renew"} is not a covenant function`);
        return { target: t, compiled };
    });

    const coins = await withPrevTxs(
        legs.map(({ target, compiled }) => ({
            txid: target.coin.txid,
            vout: target.coin.vout,
            value: target.coin.value,
            tapTree: target.contract.tapTree,
            forfeitTapLeafScript: compiled.tapLeafScript,
            intentTapLeafScript: compiled.tapLeafScript,
            status: { confirmed: true },
            assets: target.coin.assets,
        })),
        deps.indexer,
    );

    const outputs = legs.map(({ target }) => ({ script: target.contract.pkScript, amount: BigInt(target.coin.value) }));
    const groups = new Map<string, { ins: asset.AssetInput[]; outs: asset.AssetOutput[] }>();
    legs.forEach(({ target }, k) => {
        for (const a of target.coin.assets ?? []) {
            const g = groups.get(a.assetId) ?? { ins: [], outs: [] };
            g.ins.push(asset.AssetInput.create(k + 1, a.amount));
            g.outs.push(asset.AssetOutput.create(k, a.amount));
            groups.set(a.assetId, g);
        }
    });
    const packets: unknown[] = [];
    if (groups.size > 0) {
        packets.push(
            asset.Packet.create(
                [...groups].map(([id, g]) => asset.AssetGroup.create(asset.AssetId.fromString(id), null, g.ins, g.outs, [])),
            ),
        );
    }
    packets.push(
        EmulatorPacket.create(
            legs.map(({ compiled }, k) => ({ vin: k + 1, script: compiled.arkadeScript!, witness: new Uint8Array(0) })),
        ),
    );

    const sessionKey = hex.encode(await session.getPublicKey());
    const message: Intent.RegisterMessage = {
        type: "register",
        onchain_output_indexes: [],
        valid_at: 0,
        expire_at: 0,
        cosigners_public_keys: [sessionKey],
    };
    const proof = Intent.create(message, coins, [...outputs, Extension.create(packets as never).txOut()]);
    const signedProof = await deps.emulator.submitIntent({ proof: base64.encode(proof.toPSBT()), message });
    const intentId = await deps.ark.registerIntent({ proof: signedProof, message });

    const recipients = legs.map(({ target }) => ({
        address: target.contract.address,
        amount: target.coin.value,
        ...(target.coin.assets?.length ? { assets: target.coin.assets } : {}),
    }));
    const handler = covenantBatchHandler(deps, { intentId, signedProof, message, coins, session, recipients });
    const abort = new AbortController();
    opts.signal?.addEventListener("abort", () => abort.abort());
    try {
        const stream = deps.ark.getEventStream(abort.signal, [sessionKey, ...coins.map((c) => `${c.txid}:${c.vout}`)]);
        // Batch.join only checks the abort when the next event arrives, so a batch that never starts waits forever.
        const commitmentTxid = await Promise.race([
            Batch.join(stream, handler, { abortController: abort }),
            abandonOn(opts.signal),
        ]);
        return { commitmentTxid, intentId };
    } finally {
        abort.abort();
    }
}

function abandonOn(signal: AbortSignal | undefined): Promise<never> {
    return new Promise((_, reject) => {
        if (!signal) return;
        const fail = () => reject(new Error("renewal deadline passed before the batch completed"));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
    });
}

function covenantBatchHandler(
    deps: RenewDeps,
    ctx: {
        intentId: string;
        signedProof: string;
        message: Intent.RegisterMessage;
        coins: { txid: string; vout: number; value: number; tapTree: Uint8Array; forfeitTapLeafScript: never | any; isSwept?: boolean }[];
        session: SignerSession;
        recipients: Parameters<typeof validateBatchRecipients>[2];
    },
): Batch.Handler {
    let batchId = "";
    let sweepRoot: Uint8Array = new Uint8Array();
    let validatedCommitment: string | undefined;
    return {
        async onBatchStarted(event) {
            const idHash = hex.encode(sha256(new TextEncoder().encode(ctx.intentId)));
            if (!event.intentIdHashes.includes(idHash)) return { skip: true };
            const info = await deps.ark.getInfo();
            const timelock = assertValidBatchExpiry(
                event.batchExpiry,
                resolveBatchExpiryPolicy(deps.network, { advertisedVtxoTreeExpiry: info.vtxoTreeExpiry }),
            );
            await deps.ark.confirmRegistration(ctx.intentId);
            batchId = event.id;
            sweepRoot = tapLeafHash(
                CSVMultisigTapscript.encode({ timelock, pubkeys: [hex.decode(info.forfeitPubkey).subarray(1)] }).script,
            );
            return { skip: false };
        },
        async onTreeSigningStarted(event, vtxoTree) {
            const mine = hex.encode((await ctx.session.getPublicKey()).subarray(1));
            if (!event.cosignersPublicKeys.map((k) => k.slice(2)).includes(mine)) return { skip: true };
            const commitment = Transaction.fromPSBT(base64.decode(event.unsignedCommitmentTx));
            validateVtxoTxGraph(vtxoTree, commitment, sweepRoot);
            validateBatchRecipients(commitment, vtxoTree.leaves(), ctx.recipients, deps.network);
            const shared = commitment.getOutput(0);
            if (!shared?.amount) throw new Error("missing shared output");
            validatedCommitment = commitment.id;
            await ctx.session.init(vtxoTree, sweepRoot, shared.amount);
            await deps.ark.submitTreeNonces(batchId, hex.encode(await ctx.session.getPublicKey()), await ctx.session.getNonces());
            return { skip: false };
        },
        async onTreeNonces(event) {
            const { hasAllNonces } = await ctx.session.aggregatedNonces(event.txid, event.nonces);
            if (!hasAllNonces) return { fullySigned: false };
            await deps.ark.submitTreeSignatures(batchId, hex.encode(await ctx.session.getPublicKey()), await ctx.session.sign());
            return { fullySigned: true };
        },
        async onBatchFinalization(event, _tree, connectorTree) {
            const commitment = Transaction.fromPSBT(base64.decode(event.commitmentTx));
            assertFinalCommitmentMatchesValidated(commitment, validatedCommitment, "covenant renewal");
            const info = await deps.ark.getInfo();
            const forfeitScript = OutScript.encode(Address(deps.network).decode(info.forfeitAddress));
            const needForfeit = ctx.coins.filter((c) => !c.isSwept);
            if (needForfeit.length > 0 && !connectorTree) throw new Error("missing connector tree");
            if (connectorTree) validateConnectorsTxGraph(event.commitmentTx, connectorTree);
            const leaves = connectorTree?.leaves() ?? [];
            if (leaves.length < needForfeit.length) throw new Error("not enough connectors");
            const forfeits = needForfeit.map((coin, i) => {
                const connector = leaves[i]!;
                const out = connector.getOutput(0);
                if (!out?.amount || !out.script) throw new Error("invalid connector output");
                return base64.encode(
                    buildForfeitTx(
                        [
                            {
                                txid: coin.txid,
                                index: coin.vout,
                                witnessUtxo: { amount: BigInt(coin.value), script: VtxoScript.decode(coin.tapTree).pkScript },
                                sighashType: SigHash.DEFAULT,
                                tapLeafScript: [coin.forfeitTapLeafScript],
                            },
                            { txid: connector.id, index: 0, witnessUtxo: { amount: out.amount, script: out.script } },
                        ],
                        forfeitScript,
                    ).toPSBT(),
                );
            });
            const nodes: ConnectorTreeNode[] = [];
            for (const sub of connectorTree?.iterator() ?? []) {
                const children: Record<string, string> = {};
                for (const [vout, child] of sub.children) children[String(vout)] = child.txid;
                nodes.push({ txid: sub.txid, tx: base64.encode(sub.root.toPSBT()), children });
            }
            const signed = await deps.emulator.submitFinalization(
                { proof: ctx.signedProof, message: ctx.message },
                forfeits,
                nodes,
                event.commitmentTx,
            );
            await deps.ark.submitSignedForfeitTxs(signed.signedForfeits, signed.signedCommitmentTx);
        },
    };
}
