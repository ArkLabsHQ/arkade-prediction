import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { packageSignerKey, priceReport, type RedStonePackage } from "../../../src/core/redstone.js";

const packages: RedStonePackage[] = JSON.parse(readFileSync(new URL("../../fixtures/redstone/btc-packages.json", import.meta.url), "utf8")).BTC;

describe("RedStone packages", () => {
    it("recovers each signer's key from its own signature", () => {
        const keys = packages.map(packageSignerKey).map((k) => hex.encode(k));
        expect(new Set(keys).size).toBe(5);
        expect(keys.every((k) => k.startsWith("10") && k.length === 68)).toBe(true);
        expect(() => packageSignerKey({ ...packages[0]!, signerAddress: packages[1]!.signerAddress })).toThrow(/does not recover/);
    });

    it("puts each signer's own value in its committed slot and leaves missing signers empty", () => {
        const signers = packages.map(packageSignerKey).reverse();
        const report = priceReport("BTC", packages.slice(1), signers);
        expect(report.signatures.map((s) => s.length)).toEqual([64, 64, 64, 64, 0]);
        expect(report.values.every((v) => v.length === 32) && report.stamps.every((t) => t.length === 6)).toBe(true);
        expect(report.prices.reverse().slice(1)).toEqual(packages.slice(1).map((p) => BigInt(Math.round(p.dataPoints[0]!.value * 1e8))));
        const present = report.prices.filter((x): x is bigint => x !== undefined).sort((x, y) => (x < y ? -1 : 1));
        expect(report.price).toBe(present[2]);
    });
});
