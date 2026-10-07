import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { hex } from "@scure/base";
import { attestationMessage, bindingHash, signAttestation, verifyAttestation, type MarketBinding } from "../../src/core/attestation.js";
import { canonicalJson, num2bin } from "../../src/core/encoding.js";
import { BINARY_VECTORS, assertVector, redemptionPayout } from "../../src/core/payout.js";

const rand = (n: number) => BigInt(Math.floor(Math.random() * n));

describe("payout math", () => {
    it("pays exactly the backing collateral when claims are split arbitrarily (even unit), never more (odd unit)", () => {
        for (let trial = 0; trial < 2000; trial++) {
            const odd = trial % 2 === 1;
            const unit = 2n * (1n + rand(5000)) + (odd ? 1n : 0n);
            const v = [BINARY_VECTORS.yes, BINARY_VECTORS.no, BINARY_VECTORS.invalid][Number(rand(3))]!;
            const sets = 1n + rand(200);
            let [yes, no, paid, redemptions] = [sets, sets, 0n, 0n];
            while (yes + no > 0n) {
                const y = rand(Number(yes) + 1);
                const n = rand(Number(no) + 1);
                if (y + n === 0n) continue;
                paid += redemptionPayout([y, n], v, unit);
                redemptions++;
                yes -= y;
                no -= n;
            }
            if (!odd) expect(paid).toBe(sets * unit);
            expect(paid).toBeLessThanOrEqual(sets * unit);
            expect(sets * unit - paid).toBeLessThan(redemptions + 1n);
        }
    });

    it("pays a complete set exactly one unit under every supported vector", () => {
        for (const v of Object.values(BINARY_VECTORS)) expect(redemptionPayout([1n, 1n], v, 1000n)).toBe(1000n);
    });

    it("rejects malformed vectors and burns", () => {
        expect(() => assertVector({ numerators: [1n, 1n], denominator: 1n })).toThrow();
        expect(() => assertVector({ numerators: [-1n, 2n], denominator: 1n })).toThrow();
        expect(() => assertVector({ numerators: [0n, 0n], denominator: 0n })).toThrow();
        expect(() => redemptionPayout([-1n, 0n], BINARY_VECTORS.yes, 1000n)).toThrow();
        expect(() => redemptionPayout([1n], BINARY_VECTORS.yes, 1000n)).toThrow();
    });
});

describe("encodings", () => {
    it("num2bin matches script-number padding", () => {
        expect(hex.encode(num2bin(1n, 8))).toBe("0100000000000000");
        expect(hex.encode(num2bin(0n, 8))).toBe("0000000000000000");
        expect(hex.encode(num2bin(256n, 2))).toBe("0001");
        expect(hex.encode(num2bin(-1n, 2))).toBe("0180");
        expect(() => num2bin(128n, 1)).toThrow();
    });

    it("canonical JSON is key-order independent and refuses floats", () => {
        expect(canonicalJson({ b: 1n, a: [true, null, "x"] })).toBe(canonicalJson({ a: [true, null, "x"], b: 1n }));
        expect(() => canonicalJson({ x: 0.5 })).toThrow();
    });
});

describe("attestation binding", () => {
    const base: MarketBinding = {
        schema: 1,
        deployment: { network: "regtest", arkSigner: "aa".repeat(32), emulatorSigner: "02" + "bb".repeat(32) },
        template: { marketVault: "sha256:1", resolvedVault: "sha256:2" },
        marketId: "m1",
        definitionHash: "cc".repeat(32),
        collateral: { kind: "BTC", unitSats: 1000n },
        claims: { ctrl: "c", outcomes: ["y", "n"] },
        outcomeLabels: ["YES", "NO"],
        source: null,
        oracle: { keys: ["dd".repeat(32)], threshold: 1, epoch: 1 },
        timing: { closeAt: 1n, timeoutAt: 0n },
    };

    it("changes when any committed field changes", () => {
        const h = hex.encode(bindingHash(base));
        const variants: Partial<MarketBinding>[] = [
            { marketId: "m2" },
            { deployment: { ...base.deployment, network: "mutinynet" } },
            { template: { ...base.template, marketVault: "sha256:x" } },
            { collateral: { kind: "BTC", unitSats: 1001n } },
            { claims: { ctrl: "c", outcomes: ["n", "y"] } },
            { outcomeLabels: ["NO", "YES"] },
            { oracle: { ...base.oracle, epoch: 2 } },
            { timing: { closeAt: 2n, timeoutAt: 0n } },
        ];
        for (const v of variants) expect(hex.encode(bindingHash({ ...base, ...v }))).not.toBe(h);
    });

    it("a certificate only verifies for its own binding, evidence, vector and key", () => {
        const sk = randomBytes(32);
        const pk = schnorr.getPublicKey(sk);
        const binding = bindingHash(base);
        const evidence = randomBytes(32);
        const sig = signAttestation(sk, attestationMessage(binding, evidence, BINARY_VECTORS.yes));
        expect(verifyAttestation(sig, pk, attestationMessage(binding, evidence, BINARY_VECTORS.yes))).toBe(true);
        expect(verifyAttestation(sig, pk, attestationMessage(binding, evidence, BINARY_VECTORS.no))).toBe(false);
        expect(verifyAttestation(sig, pk, attestationMessage(binding, evidence, BINARY_VECTORS.invalid))).toBe(false);
        expect(verifyAttestation(sig, pk, attestationMessage(bindingHash({ ...base, marketId: "m2" }), evidence, BINARY_VECTORS.yes))).toBe(false);
        expect(verifyAttestation(sig, pk, attestationMessage(binding, randomBytes(32), BINARY_VECTORS.yes))).toBe(false);
        expect(verifyAttestation(sig, schnorr.getPublicKey(randomBytes(32)), attestationMessage(binding, evidence, BINARY_VECTORS.yes))).toBe(false);
    });
});
