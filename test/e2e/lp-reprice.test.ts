import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "../../src/core/actions.js";
import { openDb, run } from "../../src/server/db.js";
import type { OfferJson } from "../../src/shared/api.js";
import { connectArkade, faucet, indexerProvider, waitFor } from "./env.js";
import { faucetTrader, registeredMarket } from "./flows.js";
import { network } from "./market.js";
import { startServer, type TestServer } from "./server.js";

const servers: TestServer[] = [];
afterAll(async () => {
    for (const s of servers) await s.stop();
});

describe("LP repricing", () => {
    it("cancels drifted LP asks on-contract and re-posts what is left at the source price plus spread", { timeout: 900_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const s = await startServer({ port: 37414 });
        servers.push(s);
        const ov = await s.api<{ wallets: { operator: { address: string }; lp: { address: string } } }>("/api/admin/overview", { admin: true });
        await faucet(ov.body.wallets.operator.address, 100_000);
        await faucet(ov.body.wallets.lp.address, 100_000);
        const alice = await faucetTrader(s, 40_000);
        const m = await registeredMarket(s, ctx, alice, 3600);
        const open = async () => (await s.api<{ offers: OfferJson[] }>(`/api/markets/${m.marketId}/offers?status=open`)).body.offers;

        expect((await s.api(`/api/admin/markets/${m.marketId}/liquidity`, { method: "POST", admin: true, body: JSON.stringify({ sets: "3", yesAsk: "600", noAsk: "450" }) })).status).toBe(200);
        const first = await waitFor(async () => {
            const offers = await open();
            return offers.length === 2 && offers;
        }, { what: "LP asks", timeoutMs: 180_000, intervalMs: 2000 });

        // Stand in for an import pass: the market becomes a mirror whose source odds moved to 20/80.
        const db = openDb(join(s.dataDir, "apm.sqlite"));
        run(db, "UPDATE markets SET kind = 'polymarket', outcomes = ?, source_snapshot = ? WHERE id = ?", JSON.stringify(["Yes", "No"]),
            JSON.stringify({ referencePrices: [{ outcome: "Yes", price: "0.2" }, { outcome: "No", price: "0.8" }] }), m.marketId);
        db.close();

        const repriced = await waitFor(async () => {
            const offers = await open();
            const prices = offers.map((o) => `${o.outcome}:${o.terms.priceSats}:${o.remaining}`).sort();
            return prices.join(",") === "no:820:3,yes:220:3" && offers;
        }, { what: "repriced LP asks", timeoutMs: 300_000, intervalMs: 3000 });
        for (const a of first) {
            const { vtxos } = await indexerProvider.getVtxos({ outpoints: [{ txid: a.coin!.txid, vout: a.coin!.vout }] });
            expect(vtxos[0]?.isSpent).toBe(true);
        }
        expect(repriced.every((o) => !first.some((f) => f.id === o.id))).toBe(true);
        console.log(`repriced ${m.marketId}: ${first.map((o) => o.terms.priceSats).join("/")} -> ${repriced.map((o) => `${o.outcome}@${o.terms.priceSats}`).join(", ")}`);
    });
});
