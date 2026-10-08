import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { hex } from "@scure/base";
import { attestorSetProblem } from "../../../src/oracle/request.js";

const key = () => hex.encode(schnorr.getPublicKey(randomBytes(32)));

describe("attestor request checks", () => {
    const [own, b, c] = [key(), key(), key()];

    it("serves its own key inside a valid set, with or without a pinned block", () => {
        expect(attestorSetProblem({ oracle: { keys: [own, b, c], threshold: 2 }, atBlock: "95130607" }, own)).toBeUndefined();
        expect(attestorSetProblem({ oracle: { keys: [own, own, own], threshold: 1 } }, own)).toBeUndefined();
    });

    it("refuses sets it is not in, repeated keys above threshold 1, and malformed blocks", () => {
        expect(attestorSetProblem({ oracle: { keys: [b, c, key()], threshold: 2 } }, own)?.code).toBe("oracle-set");
        expect(attestorSetProblem({ oracle: { keys: [own, b, b], threshold: 2 } }, own)?.code).toBe("oracle-set");
        expect(attestorSetProblem({ oracle: { keys: [own, b], threshold: 1 } }, own)?.code).toBe("oracle-set");
        expect(attestorSetProblem({}, own)?.code).toBe("oracle-set");
        for (const atBlock of ["0", "-1", "12d", 95130607, "1".repeat(17)]) {
            expect(attestorSetProblem({ oracle: { keys: [own, b, c], threshold: 2 }, atBlock }, own)?.code).toBe("block");
        }
    });
});
