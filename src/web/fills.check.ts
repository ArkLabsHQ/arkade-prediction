// Run: pnpm exec tsx src/web/fills.check.ts
import assert from "node:assert/strict";
import type { OfferJson } from "../shared/api.js";
import { planFill } from "./fills.js";

let seq = 0;
function offer(side: "sell" | "buy", price: number, remaining: number, o: { minFill?: number; expires?: number; maker?: string } = {}): OfferJson {
    seq++;
    return {
        id: `o${seq}`, marketId: "m", outcome: "yes", script: "", status: "open", updatedAt: "",
        createdAt: `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
        remaining: String(remaining),
        coin: { txid: "t", vout: seq, valueSats: String(side === "sell" ? 330 : remaining * price + 330), assets: [] },
        terms: {
            side, maker: "", makerScript: o.maker ?? "maker", assetId: "a", priceSats: String(price),
            minFill: String(o.minFill ?? 1), expiresAtUnix: String(o.expires ?? 0), reserveSats: "330", exitDelaySeconds: "512",
        },
    };
}
const NOW = 1_000_000;
const legs = (p: ReturnType<typeof planFill>) => p.legs.map((l) => [l.price, l.qty]);

let p = planFill([offer("sell", 600, 5), offer("sell", 550, 2), offer("buy", 500, 9)], "buy", 4n, NOW);
assert.deepEqual(legs(p), [[550n, 2n], [600n, 2n]]);
assert.equal(p.notional, 2300n);
assert.equal(p.depth, 7n);

// Asks: partial below min fill only if it empties the offer; expired and own offers never fill.
p = planFill([
    offer("sell", 500, 10, { minFill: 5 }), offer("sell", 510, 3, { minFill: 3 }),
    offer("sell", 400, 9, { expires: NOW + 10 }), offer("sell", 300, 9, { maker: "me" }),
], "buy", 3n, NOW, "me");
assert.deepEqual(legs(p), [[510n, 3n]]);

// Bids: below min fill only if the budget left after it is below one min fill.
p = planFill([offer("buy", 400, 10, { minFill: 4 }), offer("buy", 450, 2, { minFill: 3 })], "sell", 3n, NOW);
assert.deepEqual(legs(p), [[450n, 2n]]);
assert.equal(p.qty, 2n);

assert.equal(planFill([], "buy", 1n, NOW).legs.length, 0);
console.log("fills: ok");
