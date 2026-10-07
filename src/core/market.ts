import { arkade, asset } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import marketVaultArtifact from "../../contracts/artifacts/market_vault.json" with { type: "json" };
import resolvedVaultArtifact from "../../contracts/artifacts/resolved_vault.json" with { type: "json" };
import { assetScriptArgs } from "./assets.js";
import { BINARY_VECTORS, type BinaryOutcome } from "./payout.js";
import { loadProgram, type ContractArtifact } from "./programs.js";

export const PROGRAMS = {
    marketVault: loadProgram(marketVaultArtifact as ContractArtifact),
    resolvedVault: loadProgram(resolvedVaultArtifact as ContractArtifact),
};

export const TEMPLATE = {
    marketVault: marketVaultArtifact.fingerprint,
    resolvedVault: resolvedVaultArtifact.fingerprint,
};

/** BIP341 NUMS point H: no known discrete log, so a leaf locked to it can never be signed. */
export const NUMS_KEY = hex.decode("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0");

export interface MarketAssets {
    ctrl: string;
    yes: string;
    no: string;
}

export interface VaultTerms {
    assets: MarketAssets;
    unitSats: bigint;
    capSats: bigint;
    oracleKey: Uint8Array;
    binding: Uint8Array;
    closeAt: bigint;
    timeoutAt: bigint;
    /** CSV (seconds, multiple of 512, >= the operator's unilateral exit delay) of the unspendable exit leaf. */
    exitDelaySeconds: bigint;
}

export type ArkadeClient = Awaited<ReturnType<typeof arkade.Arkade.connect>>;
export type Contract = arkade.ArkadeContract;

function assetArgs(assets: MarketAssets) {
    const ctrl = assetScriptArgs(assets.ctrl);
    const yes = assetScriptArgs(assets.yes);
    const no = assetScriptArgs(assets.no);
    return {
        ctrlTxid: ctrl.txid, ctrlGidx: ctrl.gidx,
        yesTxid: yes.txid, yesGidx: yes.gidx,
        noTxid: no.txid, noGidx: no.gidx,
    };
}

export function resolvedVault(ark: ArkadeClient, terms: VaultTerms, outcome: BinaryOutcome): Contract {
    const v = BINARY_VECTORS[outcome];
    return ark.contract(PROGRAMS.resolvedVault, {
        ...assetArgs(terms.assets),
        unit: terms.unitSats,
        nYes: v.numerators[0],
        nNo: v.numerators[1],
        denom: v.denominator,
        noExitKey: NUMS_KEY,
        exit: terms.exitDelaySeconds,
    });
}

export function marketContracts(ark: ArkadeClient, terms: VaultTerms) {
    if (terms.oracleKey.length !== 32 || terms.binding.length !== 32) throw new Error("oracle key and binding are 32 bytes");
    if (terms.unitSats <= 0n || terms.unitSats % 2n !== 0n) throw new Error("unit must be a positive even number of sats");
    const resolved = {
        yes: resolvedVault(ark, terms, "yes"),
        no: resolvedVault(ark, terms, "no"),
        invalid: resolvedVault(ark, terms, "invalid"),
    };
    const vault = ark.contract(PROGRAMS.marketVault, {
        ...assetArgs(terms.assets),
        unit: terms.unitSats,
        capValue: terms.capSats,
        oracle: terms.oracleKey,
        binding: terms.binding,
        closeAt: terms.closeAt,
        timeoutAt: terms.timeoutAt,
        resolvedYes: resolved.yes.pkScript.slice(2),
        resolvedNo: resolved.no.pkScript.slice(2),
        resolvedInvalid: resolved.invalid.pkScript.slice(2),
        noExitKey: NUMS_KEY,
        exit: terms.exitDelaySeconds,
    });
    return { vault, resolved };
}

const text = new TextEncoder();
const meta = (k: string, v: string) => asset.Metadata.create(text.encode(k), text.encode(v));

/**
 * Genesis packet: CTRL (supply 1) plus YES/NO (supply `seedSets` each) controlled by CTRL, all to `vout`.
 * Asset ids become (txid, 0) / (txid, 1) / (txid, 2).
 */
export function genesisPacket(marketId: string, vout: number, seedSets: bigint): asset.Packet {
    const out = (amount: bigint) => [asset.AssetOutput.create(vout, amount)];
    const ctrlRef = asset.AssetRef.fromGroupIndex(0);
    return asset.Packet.create([
        asset.AssetGroup.create(null, null, [], out(1n), [meta("apm.market", marketId), meta("apm.role", "ctrl")]),
        asset.AssetGroup.create(null, ctrlRef, [], out(seedSets), [meta("apm.market", marketId), meta("apm.role", "yes")]),
        asset.AssetGroup.create(null, ctrlRef, [], out(seedSets), [meta("apm.market", marketId), meta("apm.role", "no")]),
    ]);
}
