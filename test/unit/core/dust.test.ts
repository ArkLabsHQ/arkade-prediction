import { describe, expect, it } from "vitest";
import { DUST_SATS, buildArkadeTx, type Network } from "../../../src/core/arkadeTx.js";
import { fillAllowed, minFillFor, offerTooSmall } from "../../../src/core/offers.js";
import { p2tr } from "./offline.js";

describe("subdust outputs", () => {
    it("refuses to build a transaction with an output below dust", async () => {
        await expect(buildArkadeTx({} as Network, [], [{ script: p2tr(), amount: DUST_SATS - 1n }])).rejects.toThrow(/below the 330-sat dust limit/);
    });
});

describe("minimum bet and offer", () => {
    it("rounds the min fill up so every partial fill is worth at least 330 sats", () => {
        expect(minFillFor(100n)).toBe(4n);
        expect(minFillFor(330n)).toBe(1n);
        expect(minFillFor(331n)).toBe(1n);
        expect(minFillFor(1n)).toBe(330n);
    });

    it("refuses offers worth under 330 sats in total or per minimum fill", () => {
        expect(offerTooSmall({ priceSats: 100n, minFill: 4n }, 4n)).toBeUndefined();
        expect(offerTooSmall({ priceSats: 100n, minFill: 4n }, 3n)).toMatch(/offer must be worth/);
        expect(offerTooSmall({ priceSats: 100n, minFill: 3n }, 10n)).toMatch(/4 shares at this price/);
    });

    it("buy fills spend at least 330 sats and close the offer once no further legal fill fits", () => {
        const bid = { side: "buy" as const, priceSats: 100n, minFill: 4n, reserveSats: 330n };
        const funded = { units: 0n, value: 1000n + 330n };
        expect(fillAllowed(bid, funded, 3n)).toBe(false);
        expect(fillAllowed(bid, funded, 4n)).toBe(true);
        expect(fillAllowed(bid, funded, 10n)).toBe(true);
        expect(fillAllowed(bid, funded, 11n)).toBe(false);
        expect(fillAllowed({ ...bid, legacy: true }, funded, 4n)).toBe(false);
    });
});
