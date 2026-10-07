import { ArkAddress, Extension, asset } from "@arkade-os/sdk";
import type { Coin, InputSpec, Network } from "../../src/core/arkadeTx.js";
import { assetIdOf } from "../../src/core/assets.js";
import { genesisPacket, type MarketAssets } from "../../src/core/market.js";
import { arkProvider, emulatorProvider, indexerProvider, spendableAt, waitFor, type newWallet } from "./env.js";

export type TestWallet = Awaited<ReturnType<typeof newWallet>>;

export function network(ark: { checkpoint: Network["checkpoint"] }): Network {
    return { ark: arkProvider, emulator: emulatorProvider, indexer: indexerProvider, checkpoint: ark.checkpoint };
}

export async function scriptOf(w: TestWallet): Promise<Uint8Array> {
    return ArkAddress.decode(await w.wallet.getAddress()).pkScript;
}

export async function walletInputs(w: TestWallet, pick?: (c: Coin) => boolean): Promise<InputSpec[]> {
    const coins = (await w.wallet.getVtxos()).filter((c) => !c.isSpent && (!pick || pick(c)));
    return coins.map((coin) => ({ kind: "wallet", coin }) as InputSpec);
}

export const sumValue = (inputs: InputSpec[]) => inputs.reduce((s, i) => s + BigInt(i.coin.value), 0n);

/** The spendable VTXO at `script`; pass the creating txid to avoid racing the indexer on a stale coin. */
export async function coinAt(script: Uint8Array, what: string, txid?: string): Promise<Coin> {
    const [vtxo] = await waitFor(async () => {
        const v = (await spendableAt(script)).filter((c) => !txid || c.txid === txid);
        return v.length > 0 && v;
    }, { what });
    return { txid: vtxo!.txid, vout: vtxo!.vout, value: vtxo!.value, assets: vtxo!.assets };
}

export async function assetBalance(w: TestWallet, assetId: string): Promise<bigint> {
    const coins = await w.wallet.getVtxos();
    return coins.reduce((s, c) => s + (c.assets ?? []).filter((a) => a.assetId === assetId).reduce((t, a) => t + a.amount, 0n), 0n);
}

/** Issues CTRL + YES/NO (seed supply each) to the creator's own address. */
export async function issueGenesis(creator: TestWallet, marketId: string, seedSets: bigint): Promise<MarketAssets & { txid: string }> {
    const coins = (await creator.wallet.getVtxos()).filter((c) => !c.isSpent && !(c.assets?.length));
    const total = coins.reduce((s, c) => s + BigInt(c.value), 0n);
    const { arkTxid } = await creator.wallet.buildAndSubmitOffchainTx(coins, [
        { script: await scriptOf(creator), amount: total },
        Extension.create([genesisPacket(marketId, 0, seedSets) as asset.Packet]).txOut(),
    ]);
    const assets = { txid: arkTxid, ctrl: assetIdOf(arkTxid, 0), yes: assetIdOf(arkTxid, 1), no: assetIdOf(arkTxid, 2) };
    await waitFor(async () => (await assetBalance(creator, assets.ctrl)) === 1n, { what: "genesis visible" });
    return assets;
}
