import { afterAll, describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import type { Ctx } from "../../src/core/actions.js";
import { attestationMessage, evidenceDigest, signAttestation } from "../../src/core/attestation.js";
import { BINARY_VECTORS } from "../../src/core/payout.js";
import type { CertificateJson, MarketJson, OfferJson } from "../../src/shared/api.js";
import { connectArkade, faucet, indexerProvider, waitFor } from "./env.js";
import { faucetTrader, registeredMarket } from "./flows.js";
import { network } from "./market.js";
import { startServer, type TestServer } from "./server.js";

const servers: TestServer[] = [];
afterAll(async () => {
    for (const s of servers) await s.stop();
});

describe("halted market: outcome known before close", () => {
    it("withdraws the LP's quotes on-contract, refuses new orders, and settles after the close", { timeout: 900_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const s = await startServer({ port: 37408 });
        servers.push(s);
        const ov = await s.api<{ wallets: { operator: { address: string }; lp: { address: string } } }>("/api/admin/overview", { admin: true });
        await faucet(ov.body.wallets.operator.address, 200_000);
        await faucet(ov.body.wallets.lp.address, 100_000);
        const alice = await faucetTrader(s, 40_000);
        const m = await registeredMarket(s, ctx, alice, 240);
        const marketJson = async () => (await s.api<MarketJson>(`/api/markets/${m.marketId}`)).body;

        const lp = await s.api(`/api/admin/markets/${m.marketId}/liquidity`, { method: "POST", admin: true, body: JSON.stringify({ sets: "3", yesAsk: "600", noAsk: "450" }) });
        expect(lp.status).toBe(200);
        const asks = await waitFor(async () => {
            const r = await s.api<{ offers: OfferJson[] }>(`/api/markets/${m.marketId}/offers?status=open`);
            return r.body.offers.length === 2 && r.body.offers;
        }, { what: "LP asks", timeoutMs: 180_000, intervalMs: 2000 });

        const evidence = evidenceDigest({ drill: "halt", outcome: "YES" });
        const cert: CertificateJson = {
            outcome: "yes", numerators: ["1", "0"], denominator: "1", evidenceDigest: hex.encode(evidence),
            signature: hex.encode(signAttestation(m.oracleSecret, attestationMessage(m.terms.binding, evidence, BINARY_VECTORS.yes))),
            signer: m.oracleKey, sourceBlock: null, issuedAt: new Date().toISOString(),
        };
        expect((await s.api(`/api/markets/${m.marketId}/certificates`, { method: "POST", body: JSON.stringify(cert) })).status).toBe(200);
        await waitFor(async () => (await marketJson()).status === "halted", { what: "halted", timeoutMs: 60_000, intervalMs: 2000 });

        await waitFor(async () => {
            const { offers } = (await s.api<{ offers: OfferJson[] }>(`/api/markets/${m.marketId}/offers`)).body;
            return asks.every((a) => offers.find((o) => o.id === a.id)?.status === "cancelled");
        }, { what: "LP quotes cancelled", timeoutMs: 180_000, intervalMs: 3000 });
        for (const a of asks) {
            const { vtxos } = await indexerProvider.getVtxos({ outpoints: [{ txid: a.coin!.txid, vout: a.coin!.vout }] });
            expect(vtxos[0]?.isSpent).toBe(true);
        }
        const refused = await s.api("/api/offers", { method: "POST", body: JSON.stringify({ marketId: m.marketId, terms: asks[0]!.terms, fundingTxid: "00".repeat(32) }) });
        expect(refused.status).toBe(409);
        expect((await marketJson()).vault.phase).toBe("open");

        const done = await waitFor(async () => {
            const body = await marketJson();
            return body.vault.phase === "resolved" && body;
        }, { what: "resolution after the close", timeoutMs: 600_000, intervalMs: 3000 });
        expect(done.vault.outcome).toBe("yes");
        expect(done.status).toBe("resolved");
        console.log(`halted ${m.marketId}: LP quotes ${asks.map((a) => a.id).join(", ")} cancelled; resolved after close`);
    });
});
