import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { contractCoin, redeemAll, type Ctx } from "../../src/core/actions.js";
import { attestationMessage, evidenceDigest, signAttestation } from "../../src/core/attestation.js";
import { marketContracts } from "../../src/core/market.js";
import { BINARY_VECTORS } from "../../src/core/payout.js";
import type { CertificateJson, MarketJson, TradeJson } from "../../src/shared/api.js";
import { connectArkade, faucet, indexerProvider, waitFor } from "./env.js";
import { faucetTrader, postBid, registeredMarket } from "./flows.js";
import { network } from "./market.js";
import { startServer, type TestServer } from "./server.js";

const servers: TestServer[] = [];
afterAll(async () => {
    for (const s of servers) await s.stop();
});

const exited = (s: TestServer) => new Promise<number | null>((r) => (s.proc.exitCode !== null || s.proc.signalCode !== null ? r(s.proc.exitCode) : s.proc.once("exit", r)));
const workflow = (dataDir: string, id: string) => {
    const db = new DatabaseSync(join(dataDir, "apm.sqlite"), { readOnly: true });
    try {
        return db.prepare("SELECT state, txid, attempts FROM workflows WHERE id LIKE ?").get(`${id}%`) as { state: string; txid: string | null } | undefined;
    } finally {
        db.close();
    }
};

describe("crash recovery at workflow boundaries", () => {
    it("never duplicates a match or a resolution across crashes before and after submission", { timeout: 1_200_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };

        // Crash 1: the keeper submits a mint-match and dies before recording the acknowledgement.
        const s1 = await startServer({ port: 37404, env: { APM_FAULT: "after-submit:mint-match" } });
        servers.push(s1);
        const ov = await s1.api<{ wallets: { operator: { address: string } } }>("/api/admin/overview", { admin: true });
        await faucet(ov.body.wallets.operator.address, 200_000);
        const [alice, bob, carol] = [await faucetTrader(s1, 40_000), await faucetTrader(s1, 20_000), await faucetTrader(s1, 20_000)];
        const m = await registeredMarket(s1, ctx, alice, 75);
        const { vault, resolved } = marketContracts(ark, m.terms);
        const before = BigInt((await contractCoin(ctx, vault))!.value);
        await postBid(s1, ctx, m.marketId, carol, m.terms.assets.yes, 550n, 3n);
        await postBid(s1, ctx, m.marketId, bob, m.terms.assets.no, 480n, 3n);
        expect(await exited(s1)).toBe(137);
        const inFlight = workflow(s1.dataDir, "match:");
        expect(inFlight?.state).toBe("submitting");
        await waitFor(async () => BigInt((await contractCoin(ctx, vault))?.value ?? 0) === before + 3000n, { what: "match landed before crash" });

        // Restart without the fault: reconciliation finds the landed tx and must not match again.
        const s2 = await startServer({ port: 37405, dataDir: s1.dataDir, env: { ...s1.env, APM_FAULT: "" } });
        servers.push(s2);
        await waitFor(async () => workflow(s2.dataDir, "match:")?.state === "done", { what: "match reconciled", timeoutMs: 120_000, intervalMs: 2000 });
        expect(workflow(s2.dataDir, "match:")?.txid).toBe(inFlight?.txid);
        await new Promise((r) => setTimeout(r, 10_000));
        expect(BigInt((await contractCoin(ctx, vault))!.value)).toBe(before + 3000n);
        const trades = await waitFor(async () => {
            const r = await s2.api<{ trades: TradeJson[] }>(`/api/markets/${m.marketId}/trades`);
            return r.body.trades.length >= 2 && r.body.trades;
        }, { what: "trades recorded" });
        expect(new Set(trades.map((t) => t.txid)).size).toBe(1);
        await s2.stop();

        // Crash 2: write-ahead recorded, process dies before the resolve tx is submitted.
        const s3 = await startServer({ port: 37406, dataDir: s1.dataDir, env: { ...s1.env, APM_FAULT: "before-submit:resolve" } });
        servers.push(s3);
        await new Promise((r) => setTimeout(r, Math.max(0, Number(m.terms.closeAt) * 1000 - Date.now() + 2000)));
        const evidence = evidenceDigest({ drill: "fault", outcome: "YES" });
        const cert: CertificateJson = {
            outcome: "yes", numerators: ["1", "0"], denominator: "1", evidenceDigest: hex.encode(evidence),
            signature: hex.encode(signAttestation(m.oracleSecret, attestationMessage(m.terms.binding, evidence, BINARY_VECTORS.yes))),
            signer: m.oracleKey, sourceBlock: null, issuedAt: new Date().toISOString(),
        };
        expect((await s3.api(`/api/markets/${m.marketId}/certificates`, { method: "POST", body: JSON.stringify(cert) })).status).toBe(200);
        expect(await exited(s3)).toBe(137);
        expect(workflow(s3.dataDir, "resolve:")?.state).toBe("submitting");
        expect(await contractCoin(ctx, vault)).toBeDefined();

        const s4 = await startServer({ port: 37407, dataDir: s1.dataDir, env: { ...s1.env, APM_FAULT: "" } });
        servers.push(s4);
        const done = await waitFor(async () => {
            const r = await s4.api<MarketJson>(`/api/markets/${m.marketId}`);
            return r.body.vault.phase === "resolved" && r.body;
        }, { what: "resolution after restart", timeoutMs: 120_000, intervalMs: 2000 });
        expect(done.vault.outcome).toBe("yes");
        expect(workflow(s4.dataDir, "resolve:")?.state).toBe("done");
        const paid = await redeemAll(ctx, carol.party, m.terms, "yes");
        expect(paid.payout).toBe(3000n);
        expect(BigInt((await contractCoin(ctx, resolved.yes))?.value ?? 0)).toBeGreaterThanOrEqual(0n);
    });
});
