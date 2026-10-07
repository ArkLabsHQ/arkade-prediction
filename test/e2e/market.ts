import { ArkAddress, Extension, asset } from "@arkade-os/sdk";
import { schnorr } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { hex } from "@scure/base";
import { buildArkadeTx, signInputs, submitArkadeTx, type Coin, type InputSpec, type Network } from "../../src/core/arkadeTx.js";
import { assetIdOf } from "../../src/core/assets.js";
import { bindingHash } from "../../src/core/attestation.js";
import {
    TEMPLATE,
    genesisPacket,
    marketContracts,
    type ArkadeClient,
    type Contract,
    type MarketAssets,
    type VaultTerms,
} from "../../src/core/market.js";
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

export interface TestMarket {
    assets: MarketAssets & { txid: string };
    terms: VaultTerms;
    vault: Contract;
    resolved: ReturnType<typeof marketContracts>["resolved"];
    oracleSecret: Uint8Array;
    binding: Uint8Array;
    vaultCoin: Coin;
}

/** Genesis + vault funded with BASE + 1 set; the creator keeps the seed YES/NO pair. */
export async function createMarket(
    ark: ArkadeClient,
    creator: TestWallet,
    opts: { unit?: bigint; base?: bigint; maxSets?: bigint; closeAt?: bigint; timeoutAt?: bigint } = {},
): Promise<TestMarket> {
    const unit = opts.unit ?? 1000n;
    const base = opts.base ?? 1000n;
    const marketId = `test-${hex.encode(randomBytes(4))}`;
    const assets = await issueGenesis(creator, marketId, 1n);
    const oracleSecret = randomBytes(32);
    const oracleKey = schnorr.getPublicKey(oracleSecret);
    const closeAt = opts.closeAt ?? BigInt(Math.floor(Date.now() / 1000)) - 60n;
    const timeoutAt = opts.timeoutAt ?? 0n;
    const binding = bindingHash({
        schema: 1,
        deployment: { network: "regtest", arkSigner: hex.encode(ark.serverKey), emulatorSigner: hex.encode(ark.emulatorKey!) },
        template: TEMPLATE,
        marketId,
        definitionHash: "00".repeat(32),
        collateral: { kind: "BTC", unitSats: unit },
        claims: { ctrl: assets.ctrl, outcomes: [assets.yes, assets.no] },
        outcomeLabels: ["YES", "NO"],
        source: null,
        oracle: { keys: [hex.encode(oracleKey)], threshold: 1, epoch: 1 },
        timing: { closeAt, timeoutAt },
    });
    const terms: VaultTerms = { assets, unitSats: unit, capSats: base + (opts.maxSets ?? 50n) * unit, oracleKey, binding, closeAt, timeoutAt, exitDelaySeconds: 512n };
    const { vault, resolved } = marketContracts(ark, terms);
    const creatorScript = await scriptOf(creator);
    const inputs = await walletInputs(creator);
    const built = await buildArkadeTx(network(ark), inputs, [
        { script: vault.pkScript, amount: base + unit, assets: [{ assetId: assets.ctrl, amount: 1n }] },
        { script: creatorScript, amount: 330n, assets: [{ assetId: assets.yes, amount: 1n }, { assetId: assets.no, amount: 1n }] },
        { script: creatorScript, amount: sumValue(inputs) - base - unit - 330n },
    ]);
    await signInputs(built, creator.identity, built.signerInputs);
    const { txid } = await submitArkadeTx(network(ark), built, (cp) => creator.identity.sign(cp, [0]));
    const vaultCoin = await coinAt(vault.pkScript, "vault", txid);
    return { assets, terms, vault, resolved, oracleSecret, binding, vaultCoin };
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
