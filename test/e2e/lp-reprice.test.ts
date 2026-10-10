import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { takeOffers, type Ctx } from "../../src/core/actions.js";
import { openDb, run } from "../../src/server/db.js";
import { coinFromJson, offerTermsFromJson, type OfferJson } from "../../src/shared/api.js";
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

    it("bids on a busy mirror so a holder can sell back without another user", { timeout: 900_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const s = await startServer({ port: 37416, env: { LP_BID_SETS: "3" } });
        servers.push(s);
        const ov = await s.api<{ wallets: { operator: { address: string }; lp: { address: string } } }>("/api/admin/overview", { admin: true });
        await faucet(ov.body.wallets.operator.address, 100_000);
        await faucet(ov.body.wallets.lp.address, 100_000);
        const alice = await faucetTrader(s, 40_000);
        const m = await registeredMarket(s, ctx, alice, 3600);
        const open = async () => (await s.api<{ offers: OfferJson[] }>(`/api/markets/${m.marketId}/offers?status=open`)).body.offers;

        const db = openDb(join(s.dataDir, "apm.sqlite"));
        run(db, "UPDATE markets SET kind = 'polymarket', outcomes = ?, source_snapshot = ? WHERE id = ?", JSON.stringify(["Yes", "No"]),
            JSON.stringify({ provider: "polymarket", slug: "busy", volume24h: 50_000, fetchedAt: new Date().toISOString(), referencePrices: [{ outcome: "Yes", price: "0.6" }, { outcome: "No", price: "0.4" }] }), m.marketId);
        db.close();

        const bids = await waitFor(async () => {
            const offers = await open();
            const quotes = offers.map((o) => `${o.terms.side}:${o.outcome}:${o.terms.priceSats}:${o.remaining}`).sort();
            return quotes.join(",") === "buy:no:380:3,buy:yes:580:3" && offers;
        }, { what: "LP bids", timeoutMs: 300_000, intervalMs: 3000 });

        // Alice holds the seed set from opening the vault and cashes out one YES into the LP's bid.
        const yesBid = bids.find((o) => o.outcome === "yes")!;
        const before = (await alice.party.coins()).reduce((t, c) => t + BigInt(c.value), 0n);
        const { notional } = await takeOffers(ctx, alice.party, [{ offer: { terms: offerTermsFromJson(yesBid.terms), coin: coinFromJson(yesBid.coin!) }, qty: 1n }], { minReceiveSats: 580n });
        expect(notional).toBe(580n);
        await waitFor(async () => (await alice.party.coins()).reduce((t, c) => t + BigInt(c.value), 0n) === before + 580n, { what: "sale proceeds" });
        const after = await waitFor(async () => (await open()).find((o) => o.terms.side === "buy" && o.outcome === "yes" && o.remaining === "2"), { what: "LP bid partially filled", timeoutMs: 120_000, intervalMs: 3000 });
        expect(after.coin!.assets).toEqual([{ assetId: m.terms.assets.yes, amount: "1" }]);
    });

    it("refills a sold-out ask within the set budget, priced up by the LP's short position", { timeout: 900_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const s = await startServer({ port: 37418, env: { LP_BOOTSTRAP_SETS: "2", LP_MAX_SETS_PER_MARKET: "4", LP_SKEW_BPS: "100" } });
        servers.push(s);
        const ov = await s.api<{ wallets: { operator: { address: string }; lp: { address: string } } }>("/api/admin/overview", { admin: true });
        await faucet(ov.body.wallets.operator.address, 100_000);
        await faucet(ov.body.wallets.lp.address, 100_000);
        const alice = await faucetTrader(s, 40_000);
        const m = await registeredMarket(s, ctx, alice, 3600);
        const open = async () => (await s.api<{ offers: OfferJson[] }>(`/api/markets/${m.marketId}/offers?status=open`)).body.offers;
        const quotes = async () => (await open()).map((o) => `${o.terms.side}:${o.outcome}:${o.terms.priceSats}:${o.remaining}`).sort().join(",");

        const db = openDb(join(s.dataDir, "apm.sqlite"));
        run(db, "UPDATE markets SET kind = 'polymarket', outcomes = ?, source_snapshot = ? WHERE id = ?", JSON.stringify(["Yes", "No"]),
            JSON.stringify({ provider: "polymarket", slug: "busy", volume24h: 50_000, fetchedAt: new Date().toISOString(), referencePrices: [{ outcome: "Yes", price: "0.6" }, { outcome: "No", price: "0.4" }] }), m.marketId);
        db.close();

        await waitFor(async () => (await quotes()) === "sell:no:420:2,sell:yes:620:2", { what: "LP bootstrap asks", timeoutMs: 300_000, intervalMs: 3000 });
        const yesAsk = (await open()).find((o) => o.outcome === "yes")!;
        await takeOffers(ctx, alice.party, [{ offer: { terms: offerTermsFromJson(yesAsk.terms), coin: coinFromJson(yesAsk.coin!) }, qty: 2n }], { maxSpendSats: 1240n });

        // Net 2 NO short at 1% per share: YES re-offered at 620 + 20 from two freshly minted sets.
        await waitFor(async () => (await quotes()) === "sell:no:420:2,sell:yes:640:2", { what: "LP refill", timeoutMs: 300_000, intervalMs: 3000 });
        await new Promise((r) => setTimeout(r, 45_000));
        expect(await quotes()).toBe("sell:no:420:2,sell:yes:640:2");
    });
});
