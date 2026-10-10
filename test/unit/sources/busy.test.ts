import { describe, expect, it } from "vitest";
import { isBusy, MIN_VOLUME_24H } from "../../../src/server/sources/busy.js";

describe("isBusy", () => {
    for (const provider of ["polymarket", "kalshi", "manifold"] as const) {
        it(`holds ${provider} to its own 24h volume floor`, () => {
            const floor = MIN_VOLUME_24H[provider];
            expect(isBusy({ provider, slug: "x", volume24h: floor })).toBe(true);
            expect(isBusy({ provider, slug: "x", volume24h: floor * 0.99 })).toBe(false);
            expect(isBusy({ provider, slug: "x", volume24h: null })).toBe(false);
            expect(isBusy({ provider, slug: "x" })).toBe(false);
        });
    }

    it("treats crypto Up/Down windows as busy without volume, and nothing else by slug", () => {
        expect(isBusy({ provider: "polymarket", slug: "btc-updown-15m-1791615600", volume24h: null })).toBe(true);
        expect(isBusy({ provider: "polymarket", slug: "eth-updown-4h-1791615600" })).toBe(true);
        expect(isBusy({ provider: "polymarket", slug: "will-btc-go-up-or-down", volume24h: null })).toBe(false);
    });
});
