import { afterAll, describe, expect, it } from "vitest";
import type { MarketJson } from "../../src/shared/api.js";
import { faucet, waitFor } from "./env.js";
import { startServer, type TestServer } from "./server.js";

let server: TestServer | undefined;
afterAll(async () => {
    await server?.stop();
});

describe("Polymarket Up/Down mirror run by the server", () => {
    it("imports a live BTC 5m event, opens its vault before the start, captures both RedStone rounds and resolves unattended", { timeout: 1_500_000 }, async () => {
        server = await startServer({
            port: 37415,
            env: {
                UPDOWN_ENABLED: "true", UPDOWN_WINDOWS: "5m", UPDOWN_ASSETS: "BTC", UPDOWN_MAX_ACTIVE: "1", UPDOWN_LEAD_SECONDS: "900",
                MARKET_UNIT_SATS: "1000", MARKET_BASE_SATS: "1000", MARKET_CAP_SETS: "100",
            },
        });
        const ov = await server.api<{ wallets: { operator: { address: string } } }>("/api/admin/overview", { admin: true });
        await faucet(ov.body.wallets.operator.address, 50_000);

        const market = await waitFor(async () => {
            const { markets } = (await server!.api<{ markets: MarketJson[] }>("/api/markets?limit=50")).body;
            return markets.find((m) => m.oracle.policy === "redstone" && m.status === "open");
        }, { what: "an activated up/down mirror", timeoutMs: 600_000, intervalMs: 5000 });
        const price = market.terms!.price!;
        expect(price.kind).toBe("updown");
        expect(market.oracle.keys).toEqual(price.signers);
        console.log(`mirror ${market.id} of ${market.source?.sourceId}: ${market.question}`);

        const done = await waitFor(async () => {
            const m = (await server!.api<MarketJson>(`/api/markets/${market.id}`)).body;
            return m.vault.phase === "resolved" && m;
        }, { what: "unattended resolution", timeoutMs: 900_000, intervalMs: 5000 });
        expect(["yes", "no"]).toContain(done.vault.outcome);
        expect(done.resolution.detail).toMatch(/on RedStone rounds/);
        console.log(`resolved ${done.vault.outcome === "yes" ? "Up" : "Down"}: ${done.resolution.detail}`);
    });
});
