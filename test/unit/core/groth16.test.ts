import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifySp1Groth16, vkFromSolidity } from "../../../src/core/groth16.js";

const fixture = (name: string) => readFileSync(new URL(`../../fixtures/zk/${name}`, import.meta.url), "utf8");
const vk = vkFromSolidity(fixture("Groth16Verifier.v6.1.0.sol"));
const ours = JSON.parse(fixture("ctf-payout-groth16.json")) as { proof: string; publicValues: string; vkey: string };

describe("SP1 Groth16 verification off-chain", () => {
    it("accepts our CTF payout proof and refuses tampering, the wrong key or the wrong circuit", () => {
        expect(verifySp1Groth16(vk, ours.proof, ours.publicValues, ours.vkey)).toBe(true);
        const flipped = ours.publicValues.slice(0, -1) + (ours.publicValues.endsWith("0") ? "1" : "0");
        expect(verifySp1Groth16(vk, ours.proof, flipped, ours.vkey)).toBe(false);
        expect(verifySp1Groth16(vk, ours.proof, ours.publicValues, `0x${"11".repeat(32)}`)).toBe(false);
        expect(verifySp1Groth16(vkFromSolidity(fixture("Groth16Verifier.v6.0.0.sol")), ours.proof, ours.publicValues, ours.vkey)).toBe(false);
        expect(verifySp1Groth16(vk, ours.proof.slice(0, -2), ours.publicValues, ours.vkey)).toBe(false);
    });
});
