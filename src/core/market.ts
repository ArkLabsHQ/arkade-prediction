import { arkade, asset } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import marketVaultArtifact from "../../contracts/artifacts/market_vault.json" with { type: "json" };
import marketVaultAnyKeyArtifact from "../../contracts/artifacts/market_vault_anykey.json" with { type: "json" };
import priceVaultArtifact from "../../contracts/artifacts/price_vault.json" with { type: "json" };
import upDownVaultArtifact from "../../contracts/artifacts/updown_vault.json" with { type: "json" };
import resolvedVaultArtifact from "../../contracts/artifacts/resolved_vault.json" with { type: "json" };
import { assetScriptArgs } from "./assets.js";
import { attestorScheme } from "./attestation.js";
import { BINARY_VECTORS, type BinaryOutcome } from "./payout.js";
import { loadProgram, type ContractArtifact } from "./programs.js";

export const PROGRAMS = {
    marketVault: loadProgram(marketVaultArtifact as ContractArtifact),
    marketVaultAnyKey: loadProgram(marketVaultAnyKeyArtifact as ContractArtifact),
    priceVault: loadProgram(priceVaultArtifact as ContractArtifact),
    upDownVault: loadProgram(upDownVaultArtifact as ContractArtifact),
    resolvedVault: loadProgram(resolvedVaultArtifact as ContractArtifact),
};

export const TEMPLATE = {
    marketVault: marketVaultArtifact.fingerprint,
    resolvedVault: resolvedVaultArtifact.fingerprint,
};

/** All-Schnorr attestor sets keep the original vault, so existing markets are unchanged; ECDSA keys need the bytes[3] variant. */
const needsAnyKey = (keys: (Uint8Array | string)[]) => keys.some((k) => (typeof k === "string" ? k.length !== 64 : k.length !== 32));
export const templateFor = (keys: (Uint8Array | string)[]) =>
    needsAnyKey(keys) ? { ...TEMPLATE, marketVault: marketVaultAnyKeyArtifact.fingerprint } : TEMPLATE;

/** BIP341 NUMS point H: no known discrete log, so a leaf locked to it can never be signed. */
export const NUMS_KEY = hex.decode("50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0");

export interface MarketAssets {
    ctrl: string;
    yes: string;
    no: string;
}

/**
 * A market settled by RedStone's own signed price reports instead of our attestors. Rounds are ms on 10 s
 * boundaries. "threshold": YES when the median price of round settleAtMs is at or above strike (x1e8).
 * "updown": YES (Up) when the median of round endAtMs is at or above the median of round startAtMs.
 */
export type PriceTerms = PriceTermsBase & ({ kind: "threshold"; strike: bigint; settleAtMs: bigint } | { kind: "updown"; startAtMs: bigint; endAtMs: bigint });

interface PriceTermsBase {
    feedId: Uint8Array;
    /** 34-byte 0x10 ECDSA/secp256k1 keys, one per slot; empty-signature slots count as absent. */
    signers: Uint8Array[];
    quorum: number;
}

export const PRICE_SIGNER_SLOTS = 5;

export interface VaultTerms {
    assets: MarketAssets;
    /** Present for price markets, which ignore the attestor fields. */
    price?: PriceTerms;
    unitSats: bigint;
    capSats: bigint;
    /** One key per vault slot; a market with fewer attestors repeats a key (see `oracleSlots`). */
    oracleKeys: Uint8Array[];
    oracleThreshold: number;
    binding: Uint8Array;
    closeAt: bigint;
    timeoutAt: bigint;
    /** CSV (seconds, multiple of 512, >= the operator's unilateral exit delay) of the unspendable exit leaf. */
    exitDelaySeconds: bigint;
}

export const ORACLE_SLOTS = 3;

/**
 * Fills the vault's attestor slots. Threshold 1 may repeat keys (the last one pads); a higher threshold needs
 * three distinct keys, because the vault counts slots and refuses repeated keys above threshold 1.
 */
export function oracleSlots(keys: Uint8Array[], threshold: number): Uint8Array[] {
    if (keys.length === 0 || keys.length > ORACLE_SLOTS) throw new Error(`1 to ${ORACLE_SLOTS} attestor keys`);
    if (keys.some((k) => !attestorScheme(k))) throw new Error("attestor keys are 32-byte x-only or 34-byte 0x10/0x11 ECDSA keys");
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > ORACLE_SLOTS) throw new Error(`threshold must be 1..${ORACLE_SLOTS}`);
    const distinct = new Set(keys.map((k) => hex.encode(k))).size;
    if (threshold > 1 && distinct !== ORACLE_SLOTS) throw new Error(`a threshold above 1 needs ${ORACLE_SLOTS} distinct attestor keys`);
    return Array.from({ length: ORACLE_SLOTS }, (_, i) => keys[Math.min(i, keys.length - 1)]!);
}

/** Puts each attestor's signature in its own slot (once, even if its key repeats); other slots stay empty. */
export function slotSignatures(terms: Pick<VaultTerms, "oracleKeys">, signed: { signer: string; signature: Uint8Array }[]): Uint8Array[] {
    const used = new Set<string>();
    return terms.oracleKeys.map((key) => {
        const k = hex.encode(key);
        const s = used.has(k) ? undefined : signed.find((x) => x.signer === k);
        if (!s) return new Uint8Array(0);
        used.add(k);
        return s.signature;
    });
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

function priceContracts(ark: ArkadeClient, terms: VaultTerms, p: PriceTerms) {
    if (p.feedId.length !== 32 || p.signers.length !== PRICE_SIGNER_SLOTS || p.signers.some((k) => attestorScheme(k) !== "ecdsa-secp256k1")) {
        throw new Error(`price terms need a 32-byte feed id and ${PRICE_SIGNER_SLOTS} ECDSA/secp256k1 signer keys`);
    }
    // A quorum below a majority would let both sides be proven; the vault refuses it too.
    if (new Set(p.signers.map((k) => hex.encode(k))).size !== PRICE_SIGNER_SLOTS || p.quorum * 2 <= PRICE_SIGNER_SLOTS || p.quorum > PRICE_SIGNER_SLOTS) {
        throw new Error("price signers must be distinct, with a majority quorum (3..5 of 5)");
    }
    const rounds = p.kind === "threshold" ? [p.settleAtMs] : [p.startAtMs, p.endAtMs];
    if (rounds.some((r) => r <= 0n || r % 10_000n !== 0n)) throw new Error("rounds must be RedStone rounds (multiples of 10 s)");
    if (p.kind === "updown" && p.endAtMs <= p.startAtMs) throw new Error("the end round must follow the start round");
    if (terms.unitSats <= 0n || terms.unitSats % 2n !== 0n) throw new Error("unit must be a positive even number of sats");
    const resolved = { yes: resolvedVault(ark, terms, "yes"), no: resolvedVault(ark, terms, "no"), invalid: resolvedVault(ark, terms, "invalid") };
    const vault = ark.contract(p.kind === "threshold" ? PROGRAMS.priceVault : PROGRAMS.upDownVault, {
        ...assetArgs(terms.assets),
        unit: terms.unitSats,
        capValue: terms.capSats,
        feedId: p.feedId,
        ...(p.kind === "threshold" ? { strike: p.strike, settleAtMs: p.settleAtMs } : { startAtMs: p.startAtMs, endAtMs: p.endAtMs }),
        ...Object.fromEntries(p.signers.map((k, i) => [`signers.${i}`, k])),
        quorum: BigInt(p.quorum),
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

export function marketContracts(ark: ArkadeClient, terms: VaultTerms) {
    if (terms.price) return priceContracts(ark, terms, terms.price);
    if (terms.binding.length !== 32) throw new Error("binding is 32 bytes");
    const oracles = oracleSlots(terms.oracleKeys, terms.oracleThreshold);
    if (terms.oracleKeys.length !== ORACLE_SLOTS) throw new Error(`terms carry exactly ${ORACLE_SLOTS} attestor slots`);
    if (terms.unitSats <= 0n || terms.unitSats % 2n !== 0n) throw new Error("unit must be a positive even number of sats");
    const resolved = {
        yes: resolvedVault(ark, terms, "yes"),
        no: resolvedVault(ark, terms, "no"),
        invalid: resolvedVault(ark, terms, "invalid"),
    };
    const vault = ark.contract(needsAnyKey(oracles) ? PROGRAMS.marketVaultAnyKey : PROGRAMS.marketVault, {
        ...assetArgs(terms.assets),
        unit: terms.unitSats,
        capValue: terms.capSats,
        "oracles.0": oracles[0]!,
        "oracles.1": oracles[1]!,
        "oracles.2": oracles[2]!,
        threshold: BigInt(terms.oracleThreshold),
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
