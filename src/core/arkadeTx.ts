import {
    EmulatorPacket,
    Extension,
    PrevArkTxField,
    Transaction,
    arkade,
    asset,
    attachPrevArkTxs,
    buildOffchainTx,
    getArkPsbtFields,
    type ArkProvider,
    type EmulatorProvider,
    type Identity,
    type IndexerProvider,
    type TapLeafScript,
} from "@arkade-os/sdk";
import { RawWitness } from "@scure/btc-signer";
import { base64, hex } from "@scure/base";

export interface AssetAmount {
    assetId: string;
    amount: bigint;
}

export interface Coin {
    txid: string;
    vout: number;
    value: number;
    assets?: AssetAmount[];
}

type Contract = arkade.ArkadeContract;
type ArgValue = bigint | Uint8Array;

export type InputSpec =
    | { kind: "covenant"; coin: Coin; contract: Contract; fn: string; args?: Record<string, ArgValue> }
    | { kind: "tapscript"; coin: Coin; contract: Contract; fn: string }
    | { kind: "wallet"; coin: Coin & { tapTree: Uint8Array; forfeitTapLeafScript: TapLeafScript } };

export interface OutputSpec {
    script: Uint8Array;
    amount: bigint;
    assets?: AssetAmount[];
}

export interface Network {
    ark: Pick<ArkProvider, "submitTx" | "finalizeTx">;
    emulator: Pick<EmulatorProvider, "submitTx">;
    indexer: Pick<IndexerProvider, "getVirtualTxs">;
    checkpoint: Parameters<typeof buildOffchainTx>[2];
}

export interface BuiltTx {
    arkTx: Transaction;
    checkpoints: Transaction[];
    /** Inputs a non-emulator party must sign (wallet coins and tapscript leaves). */
    signerInputs: number[];
    hasCovenant: boolean;
}

function covenantWitness(contract: Contract, fn: string, args: Record<string, ArgValue>) {
    const compiled = contract.vtxoScript.functionByName(fn);
    if (!compiled?.arkadeScript || !compiled.def.arkadeScript) throw new Error(`${fn} is not a covenant function`);
    const declared = (compiled.def.inputs ?? []).map((i) => (typeof i === "string" ? i : i.name));
    for (const name of declared) if (args[name] === undefined) throw new Error(`${fn}: missing argument ${name}`);
    const stack = (compiled.def.arkadeScript.witness ?? []).map((ref) =>
        arkade.witnessRefToBytes(ref, args, contract.args),
    );
    return { script: compiled.arkadeScript, witness: RawWitness.encode(stack), tapLeafScript: compiled.tapLeafScript };
}

function assetPacket(inputs: InputSpec[], outputs: OutputSpec[]): asset.Packet | undefined {
    const groups = new Map<string, { ins: asset.AssetInput[]; outs: asset.AssetOutput[] }>();
    const group = (id: string) => {
        let g = groups.get(id);
        if (!g) groups.set(id, (g = { ins: [], outs: [] }));
        return g;
    };
    inputs.forEach((input, vin) => {
        for (const a of input.coin.assets ?? []) group(a.assetId).ins.push(asset.AssetInput.create(vin, a.amount));
    });
    outputs.forEach((out, vout) => {
        for (const a of out.assets ?? []) {
            if (a.amount <= 0n) throw new Error("asset output amount must be positive");
            group(a.assetId).outs.push(asset.AssetOutput.create(vout, a.amount));
        }
    });
    if (groups.size === 0) return undefined;
    const ordered = [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
    return asset.Packet.create(
        ordered.map(([id, g]) => asset.AssetGroup.create(asset.AssetId.fromString(id), null, g.ins, g.outs, [])),
    );
}

/** arkd turns an output below this into an unspendable OP_RETURN (subdust) VTXO; we never create one. */
export const DUST_SATS = 330n;

const ANCHOR = hex.decode("51024e73");

/** Insert the extension output before the P2A anchor so asset vouts keep their positions. */
function attachExtension(tx: Transaction, ext: Extension): void {
    const last = tx.outputsLength - 1;
    const anchor = tx.getOutput(last);
    const out = ext.txOut();
    if (anchor?.script && hex.encode(anchor.script) === hex.encode(ANCHOR)) {
        tx.updateOutput(last, { script: out.script, amount: out.amount });
        tx.addOutput({ script: anchor.script, amount: anchor.amount ?? 0n });
    } else {
        tx.addOutput({ script: out.script, amount: out.amount });
    }
}

/** `opts.packet` supplies a raw asset packet (issuance) for txs whose inputs and outputs carry no transfer groups. */
export async function buildArkadeTx(
    net: Network,
    inputs: InputSpec[],
    outputs: OutputSpec[],
    opts: { packet?: asset.Packet } = {},
): Promise<BuiltTx> {
    const subdust = outputs.find((o) => o.amount < DUST_SATS);
    if (subdust) throw new Error(`output of ${subdust.amount} sats is below the ${DUST_SATS}-sat dust limit`);
    const entries: { vin: number; script: Uint8Array; witness: Uint8Array }[] = [];
    const signerInputs: number[] = [];
    const arkInputs = inputs.map((input, vin) => {
        const base = { txid: input.coin.txid, vout: input.coin.vout, value: input.coin.value };
        if (input.kind === "wallet") {
            signerInputs.push(vin);
            return { ...base, tapLeafScript: input.coin.forfeitTapLeafScript, tapTree: input.coin.tapTree };
        }
        if (input.kind === "tapscript") {
            const compiled = input.contract.vtxoScript.functionByName(input.fn);
            if (!compiled || compiled.arkadeScript) throw new Error(`${input.fn} is not a tapscript function`);
            signerInputs.push(vin);
            return { ...base, tapLeafScript: compiled.tapLeafScript, tapTree: input.contract.tapTree };
        }
        const w = covenantWitness(input.contract, input.fn, input.args ?? {});
        entries.push({ vin, script: w.script, witness: w.witness });
        return { ...base, tapLeafScript: w.tapLeafScript, tapTree: input.contract.tapTree };
    });

    const { arkTx, checkpoints } = buildOffchainTx(
        arkInputs,
        outputs.map((o) => ({ script: o.script, amount: o.amount })),
        net.checkpoint,
    );

    const packets = [];
    const assets = assetPacket(inputs, outputs);
    if (assets && opts.packet) throw new Error("raw packet cannot be combined with asset transfers");
    if (assets ?? opts.packet) packets.push((assets ?? opts.packet)!);
    if (entries.length > 0) packets.push(EmulatorPacket.create(entries));
    if (packets.length > 0) attachExtension(arkTx, Extension.create(packets as never));

    if (entries.length > 0) {
        await attachPrevArkTxs(arkTx, inputs.map((i) => i.coin.txid), net.indexer);
    }
    return { arkTx, checkpoints, signerInputs, hasCovenant: entries.length > 0 };
}

/**
 * Sign `indexes` of the ark tx. Runs wherever the key lives (browser, CLI, LP). The emulator path needs
 * checkpoints signed up front; the arkd path signs the server-returned checkpoints in `submitArkadeTx`.
 */
export async function signInputs(built: BuiltTx, identity: Identity, indexes: number[]): Promise<void> {
    if (indexes.length === 0) return;
    built.arkTx = await identity.sign(built.arkTx, indexes);
    if (!built.hasCovenant) return;
    for (const i of indexes) built.checkpoints[i] = await identity.sign(built.checkpoints[i]!, [0]);
}

export function txidOf(built: BuiltTx): string {
    return built.arkTx.id;
}

export function hasPrevArkTx(built: BuiltTx, vin: number): boolean {
    return getArkPsbtFields(built.arkTx, vin, PrevArkTxField).length > 0;
}

/**
 * Covenant txs go to the emulator, which executes every packet entry, co-signs and finalizes with arkd.
 * Pure tapscript/wallet txs go to arkd directly; `signCheckpoints` signs the server-returned checkpoints.
 */
export async function submitArkadeTx(
    net: Network,
    built: BuiltTx,
    signCheckpoints?: (cp: Transaction, vin: number) => Promise<Transaction>,
    beforeFinalize?: (pending: { txid: string; checkpoints: string[] }) => void | Promise<void>,
): Promise<{ txid: string }> {
    const ark = base64.encode(built.arkTx.toPSBT());
    const cps = built.checkpoints.map((c) => base64.encode(c.toPSBT()));
    if (built.hasCovenant) {
        const res = await net.emulator.submitTx(ark, cps);
        return { txid: Transaction.fromPSBT(base64.decode(res.signedArkTx)).id };
    }
    if (!signCheckpoints) throw new Error("arkd submission needs a checkpoint signer");
    const res = await net.ark.submitTx(ark, cps);
    const finalCps = await Promise.all(
        res.signedCheckpointTxs.map(async (cp, i) =>
            base64.encode((await signCheckpoints(Transaction.fromPSBT(base64.decode(cp)), i)).toPSBT()),
        ),
    );
    await beforeFinalize?.({ txid: res.arkTxid, checkpoints: finalCps });
    await finalizeTx(net, res.arkTxid, finalCps);
    return { txid: res.arkTxid };
}

/** Finalize only: arkd refuses a resubmitted ark tx, but keys finalization by txid so repeating it is safe. */
async function finalizeTx(net: Network, txid: string, checkpoints: string[], attempts = 3): Promise<void> {
    for (let i = 1; ; i++) {
        try {
            return await net.ark.finalizeTx(txid, checkpoints);
        } catch (err) {
            if (i >= attempts || /valid stage|not found|signature|invalid/i.test(String(err))) throw err;
            await new Promise((r) => setTimeout(r, 500 * i));
        }
    }
}
