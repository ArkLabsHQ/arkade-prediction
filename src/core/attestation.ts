import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { BINARY_VECTORS, assertVector, type BinaryOutcome, type PayoutVector } from "./payout.js";
import { bytesOf, concatBytes, num2bin, taggedJsonHash } from "./encoding.js";

/** Must equal the literal in MarketVault.resolve*: sha256(TAG || binding || evidence || n0 || n1 || D). */
export const ATTEST_TAG = "APM/attest/v1";
export const BINDING_TAG = "APM/market/v1";
export const EVIDENCE_TAG = "APM/evidence/v1";

/** Every field a funded market's settlement depends on. Changing any of them changes the binding. */
export interface MarketBinding {
    schema: 1;
    deployment: { network: string; arkSigner: string; emulatorSigner: string };
    template: { marketVault: string; resolvedVault: string };
    marketId: string;
    definitionHash: string;
    collateral: { kind: "BTC"; unitSats: bigint };
    claims: { ctrl: string; outcomes: readonly string[] };
    outcomeLabels: readonly string[];
    source: unknown;
    oracle: { keys: readonly string[]; threshold: number; epoch: number };
    timing: { closeAt: bigint; timeoutAt: bigint };
}

export function bindingHash(b: MarketBinding): Uint8Array {
    if (b.claims.outcomes.length !== b.outcomeLabels.length) throw new Error("claims/labels length mismatch");
    return taggedJsonHash(BINDING_TAG, b);
}

export function evidenceDigest(evidence: unknown): Uint8Array {
    return taggedJsonHash(EVIDENCE_TAG, evidence);
}

export function attestationMessage(binding: Uint8Array, evidence: Uint8Array, v: PayoutVector): Uint8Array {
    assertVector(v);
    if (binding.length !== 32 || evidence.length !== 32) throw new Error("binding and evidence must be 32 bytes");
    return sha256(
        concatBytes(bytesOf(ATTEST_TAG), binding, evidence, ...v.numerators.map((n) => num2bin(n, 8)), num2bin(v.denominator, 8)),
    );
}

export function outcomeOfVector(v: PayoutVector): BinaryOutcome {
    for (const [name, ref] of Object.entries(BINARY_VECTORS) as [BinaryOutcome, PayoutVector][]) {
        if (ref.denominator === v.denominator && ref.numerators.every((n, i) => n === v.numerators[i])) return name;
    }
    throw new Error("vector is not a supported binary payout vector");
}

export function signAttestation(privateKey: Uint8Array, message: Uint8Array): Uint8Array {
    return schnorr.sign(message, privateKey);
}

export function verifyAttestation(signature: Uint8Array, xOnlyKey: Uint8Array, message: Uint8Array): boolean {
    try {
        return schnorr.verify(signature, message, xOnlyKey);
    } catch {
        return false;
    }
}
