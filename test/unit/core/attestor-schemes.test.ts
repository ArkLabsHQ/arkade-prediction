import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { hex } from "@scure/base";
import { attestorPublicKey, attestorScheme, isAttestorKeyHex, signAttestation, verifyAttestation, type AttestorScheme } from "../../../src/core/attestation.js";
import { TEMPLATE, oracleSlots, templateFor } from "../../../src/core/market.js";

const msg = new Uint8Array(32).fill(7);
const secret = (n: number) => new Uint8Array(32).fill(n);

describe("attestor key schemes", () => {
    it("signs and verifies under each scheme, and only with the signer's own key", () => {
        for (const scheme of ["schnorr", "ecdsa-secp256k1", "ecdsa-p256"] as AttestorScheme[]) {
            const key = attestorPublicKey(scheme, secret(1));
            expect(attestorScheme(key)).toBe(scheme);
            expect(isAttestorKeyHex(hex.encode(key))).toBe(true);
            const sig = signAttestation(secret(1), msg, scheme);
            expect(sig.length).toBe(64);
            expect(verifyAttestation(sig, key, msg)).toBe(true);
            expect(verifyAttestation(sig, attestorPublicKey(scheme, secret(2)), msg)).toBe(false);
            expect(verifyAttestation(sig, key, new Uint8Array(32))).toBe(false);
        }
    });

    it("accepts a high-S P-256 signature, as KMS signers produce and the emulator accepts", () => {
        const sig = p256.Signature.fromBytes(signAttestation(secret(3), msg, "ecdsa-p256"));
        const highS = new p256.Signature(sig.r, p256.Point.CURVE().n - sig.s).toBytes("compact");
        expect(verifyAttestation(highS, attestorPublicKey("ecdsa-p256", secret(3)), msg)).toBe(true);
    });

    it("keeps the original vault template for all-Schnorr sets and switches only when an ECDSA key is present", () => {
        const s = attestorPublicKey("schnorr", secret(4));
        const e = attestorPublicKey("ecdsa-p256", secret(5));
        expect(templateFor([s, s, s])).toBe(TEMPLATE);
        expect(templateFor([s, e, s]).marketVault).not.toBe(TEMPLATE.marketVault);
        expect(oracleSlots([s, e, attestorPublicKey("ecdsa-secp256k1", secret(6))], 2)).toHaveLength(3);
        expect(() => oracleSlots([Uint8Array.from([0x12, ...e.slice(1)])], 1)).toThrow(/attestor keys/);
    });
});
