import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { verifySp1Groth16, vkFromSolidity } from "../../../src/core/groth16.js";

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/zk/${name}`, import.meta.url), "utf8");
const wrapper = fixture("SP1VerifierGroth16.v6.1.0.sol");
const vk = vkFromSolidity(fixture("Groth16Verifier.v6.1.0.sol"), wrapper);
const ours = JSON.parse(fixture("ctf-payout-groth16.json")) as { proof: string; publicValues: string; vkey: string };

/** The proof with 32-byte word `i` (0 = exitCode, 1 = vkRoot, 2 = nonce, then A, B, C) replaced. */
const withWord = (i: number, v: bigint) => {
    const b = hex.decode(ours.proof.slice(2));
    b.set(hex.decode(v.toString(16).padStart(64, "0")), 4 + i * 32);
    return `0x${hex.encode(b)}`;
};

describe("SP1 Groth16 verification off-chain", () => {
    it("accepts our CTF payout proof and refuses tampering, the wrong key or the wrong circuit", () => {
        expect(vk.vkRoot).toBe(0x002f850ee998974d6cc00e50cd0814b098c05bfade466d28573240d057f25352n);
        expect(verifySp1Groth16(vk, ours.proof, ours.publicValues, ours.vkey)).toBe(true);
        const flipped = ours.publicValues.slice(0, -1) + (ours.publicValues.endsWith("0") ? "1" : "0");
        expect(verifySp1Groth16(vk, ours.proof, flipped, ours.vkey)).toBe(false);
        expect(verifySp1Groth16(vk, ours.proof, ours.publicValues, `0x${"11".repeat(32)}`)).toBe(false);
        expect(verifySp1Groth16(vkFromSolidity(fixture("Groth16Verifier.v6.0.0.sol"), wrapper), ours.proof, ours.publicValues, ours.vkey)).toBe(false);
        expect(verifySp1Groth16(vk, ours.proof.slice(0, -2), ours.publicValues, ours.vkey)).toBe(false);
    });

    it("pins what the SP1 wrapper pins: selector, a clean exit, the recursion root, and points on the curve", () => {
        expect(verifySp1Groth16(vk, `0x00000000${ours.proof.slice(10)}`, ours.publicValues, ours.vkey)).toBe(false);
        expect(verifySp1Groth16(vk, withWord(0, 1n), ours.publicValues, ours.vkey)).toBe(false);
        expect(verifySp1Groth16(vk, withWord(1, vk.vkRoot + 1n), ours.publicValues, ours.vkey)).toBe(false);
        expect(verifySp1Groth16(vk, withWord(3, 1n), ours.publicValues, ours.vkey)).toBe(false);
        expect(verifySp1Groth16(vk, ours.proof, ours.publicValues, `0x${"ff".repeat(32)}`)).toBe(false);
    });
});
