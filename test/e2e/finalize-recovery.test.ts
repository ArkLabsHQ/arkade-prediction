import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "../../src/core/actions.js";
import type { OfferJson } from "../../src/shared/api.js";
import { connectArkade, faucet, indexerProvider, waitFor } from "./env.js";
import { faucetTrader, registeredMarket } from "./flows.js";
import { network } from "./market.js";
import { startServer, type TestServer } from "./server.js";

const servers: TestServer[] = [];
afterAll(async () => {
    for (const s of servers) await s.stop();
});

const exited = (s: TestServer) => new Promise<number | null>((r) => (s.proc.exitCode !== null || s.proc.signalCode !== null ? r(s.proc.exitCode) : s.proc.once("exit", r)));
const lpWorkflow = (dataDir: string) => {
    const db = new DatabaseSync(join(dataDir, "apm.sqlite"), { readOnly: true });
    try {
        const row = db.prepare("SELECT state, txid, payload FROM workflows WHERE kind = 'lp-liquidity'").get() as { state: string; txid: string; payload: string };
        return { ...row, payload: JSON.parse(row.payload) as { step?: string; inputs?: string[]; finalCheckpoints?: string[] } };
    } finally {
        db.close();
    }
};
const outpoint = (o: string) => ({ txid: o.split(":")[0]!, vout: Number(o.split(":")[1]) });

describe("crash between arkd accepting and finalizing an Arkade transaction", () => {
    it("finishes the accepted transaction on restart instead of resubmitting it", { timeout: 1_200_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const s1 = await startServer({ port: 37411, env: { APM_FAULT: "before-finalize:lp-liquidity" } });
        servers.push(s1);
        const ov = await s1.api<{ wallets: { operator: { address: string }; lp: { address: string } } }>("/api/admin/overview", { admin: true });
        await faucet(ov.body.wallets.operator.address, 200_000);
        await faucet(ov.body.wallets.lp.address, 100_000);
        const alice = await faucetTrader(s1, 40_000);
        const m = await registeredMarket(s1, ctx, alice, 900);

        // The LP's first ask is a wallet-funded tx (arkd path): the process dies after arkd accepted it.
        const lp = await s1.api(`/api/admin/markets/${m.marketId}/liquidity`, { method: "POST", admin: true, body: JSON.stringify({ sets: "2", yesAsk: "600", noAsk: "450" }) });
        expect(lp.status).toBe(200);
        expect(await exited(s1)).toBe(137);
        const crashed = lpWorkflow(s1.dataDir);
        expect(crashed.state).toBe("submitting");
        expect(crashed.payload.step).toBe("yesFundingTxid");
        expect(crashed.payload.finalCheckpoints?.length).toBeGreaterThan(0);
        // arkd v0.9.16 marks the inputs spent on acceptance and creates the outputs only on finalization.
        const { vtxos: inputs } = await indexerProvider.getVtxos({ outpoints: crashed.payload.inputs!.map(outpoint) });
        expect(inputs.length).toBe(crashed.payload.inputs!.length);
        expect(inputs.every((v) => v.isSpent)).toBe(true);
        expect((await indexerProvider.getVtxos({ outpoints: [0, 1, 2].map((vout) => ({ txid: crashed.txid, vout })) })).vtxos).toHaveLength(0);

        const s2 = await startServer({ port: 37412, dataDir: s1.dataDir, env: { ...s1.env, APM_FAULT: "" } });
        servers.push(s2);
        const asks = await waitFor(async () => {
            const r = await s2.api<{ offers: OfferJson[] }>(`/api/markets/${m.marketId}/offers?status=open`);
            return r.body.offers.length === 2 && r.body.offers;
        }, { what: "both LP asks after recovery", timeoutMs: 240_000, intervalMs: 3000 });
        expect(asks.map((a) => a.id)).toContain(`${crashed.txid}:0`);
        expect(readFileSync(join(s1.dataDir, "server-37412.log"), "utf8")).toContain("finalized an interrupted submission");
        console.log(`accepted-but-unfinalized ${crashed.txid} finalized after restart; asks ${asks.map((a) => a.id).join(", ")}`);
    });
});
