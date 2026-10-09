import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { evmUpdate, parseEvmUpdate, updateSignerKey } from "../../../src/core/pyth.js";

describe("Pyth Pro evm updates", () => {
    it("round-trips the documented layout and recovers the signer", () => {
        const secret = secp256k1.utils.randomSecretKey();
        const u = evmUpdate(secret, 1398, 1791600000000000n, 24_567_890_000n);
        expect(u.length).toBe(99);
        expect(parseEvmUpdate(u)).toMatchObject({ feedId: 1398, timestampUs: 1791600000000000n, price: 24_567_890_000n });
        expect(hex.encode(updateSignerKey(u))).toBe(`10${hex.encode(secp256k1.getPublicKey(secret, true))}`);
    });

    it("refuses anything but a single-feed, price-only payload", () => {
        const u = evmUpdate(secp256k1.utils.randomSecretKey(), 1, 1n, 1n);
        const twoProps = Uint8Array.from(u);
        twoProps[71 + 18] = 2;
        expect(() => parseEvmUpdate(twoProps)).toThrow(/single-feed, price-only/);
        const badMagic = Uint8Array.from(u);
        badMagic[0] = 0;
        expect(() => parseEvmUpdate(badMagic)).toThrow(/not a Pyth Pro/);
    });
});
