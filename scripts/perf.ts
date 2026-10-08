// Measures this application on this machine. Usage: node --import tsx scripts/perf.ts (app on :37400, regtest up).
import "../src/node/eventsource.js";
import { cpus, totalmem, platform, release } from "node:os";
import { readFileSync, writeFileSync } from "node:fs";
import { mintSets, takeOffers, postOffer, spendableCoins, type Ctx } from "../src/core/actions.js";
import { offerContract } from "../src/core/offers.js";
import { connectArkade, faucet, indexerProvider, waitFor } from "../test/e2e/env.js";
import { faucetTrader, registeredMarket } from "../test/e2e/flows.js";
import { network } from "../test/e2e/market.js";
import type { TestServer } from "../test/e2e/server.js";

const base = process.env.APM_URL ?? "http://127.0.0.1:37400";
const token = readFileSync(process.env.APM_ENV_FILE ?? ".env.regtest", "utf8").match(/^ADMIN_TOKEN=(.+)$/m)?.[1]?.trim();
const api: TestServer["api"] = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (init.admin) headers.set("authorization", `Bearer ${token}`);
    const r = await fetch(`${base}${path}`, { ...init, headers });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
};
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] ?? NaN;
const stats = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: Math.max(...xs) });

async function apiLoad(path: string, total: number, concurrency: number) {
    const lat: number[] = [];
    let errors = 0;
    let next = 0;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: concurrency }, async () => {
        while (next < total) {
            next++;
            const s = performance.now();
            const r = await fetch(`${base}${path}`).catch(() => undefined);
            if (!r?.ok) errors++;
            await r?.arrayBuffer();
            lat.push(performance.now() - s);
        }
    }));
    const secs = (performance.now() - t0) / 1000;
    return { path, rps: Math.round(total / secs), errors, latencyMs: stats(lat) };
}

async function main() {
    const result: Record<string, unknown> = {
        measuredAt: new Date().toISOString(),
        machine: { platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model, cores: cpus().length, memGiB: Math.round(totalmem() / 2 ** 30) },
        note: "Single Docker Desktop host shared with other regtest stacks; arkd, emulator, bitcoind and the app run locally.",
    };
    const ark = await connectArkade();
    const timings = { getVirtualTxs: [] as number[], emulatorSubmit: [] as number[], arkdSubmit: [] as number[] };
    const indexer = {
        getVtxos: indexerProvider.getVtxos.bind(indexerProvider),
        getVirtualTxs: async (ids: string[]) => {
            const s = performance.now();
            try { return await indexerProvider.getVirtualTxs(ids); } finally { timings.getVirtualTxs.push(performance.now() - s); }
        },
    };
    const net = network(ark);
    const emulator = { submitTx: async (a: string, c: string[]) => { const s = performance.now(); try { return await net.emulator.submitTx(a, c); } finally { timings.emulatorSubmit.push(performance.now() - s); } } };
    const arkSub = {
        finalizeTx: net.ark.finalizeTx.bind(net.ark),
        submitTx: async (a: string, c: string[]) => { const s = performance.now(); try { return await net.ark.submitTx(a, c); } finally { timings.arkdSubmit.push(performance.now() - s); } },
    };
    const ctx: Ctx = { ark, net: { ...net, indexer, emulator, ark: arkSub as never }, indexer };

    const ov = await api<{ wallets: { operator: { address: string } } }>("/api/admin/overview", { admin: true });
    await faucet(ov.body.wallets.operator.address, 400_000);
    const server = { api } as TestServer;
    const maker = await faucetTrader(server, 150_000);
    const m = await registeredMarket(server, ctx, maker, 3600);

    // Sequential covenant txs: each mint spends the market vault, so they serialize by design.
    const mintLat: number[] = [];
    for (let i = 0; i < 15; i++) {
        const s = performance.now();
        await mintSets(ctx, maker.party, m.terms, 2n);
        mintLat.push(performance.now() - s);
    }
    result.sequentialMint = { latencyMs: stats(mintLat), throughputTxPerSec: +(15 / (mintLat.reduce((a, b) => a + b, 0) / 1000)).toFixed(2) };

    // Independent offers filled concurrently by independent takers (no shared UTXO).
    const takers = await Promise.all(Array.from({ length: 6 }, () => faucetTrader(server, 20_000)));
    const offers: { terms: import("../src/core/offers.js").OfferTerms; coin: import("../src/core/arkadeTx.js").Coin }[] = [];
    for (let i = 0; i < 6; i++) {
        const terms = { side: "sell" as const, maker: maker.key, makerScript: maker.party.script, assetId: m.terms.assets.yes, priceSats: 500n + BigInt(i), minFill: 1n, expiresAt: 0n, reserveSats: 330n, exitDelaySeconds: 512n };
        const { txid } = await postOffer(ctx, maker.party, terms, 2n);
        const coin = await waitFor(async () => (await spendableCoins(ctx, offerContract(ark, terms).pkScript)).find((c) => c.txid === txid), { what: "offer" });
        offers.push({ terms, coin });
    }
    const takeLat: number[] = [];
    let takeErrors = 0;
    const t0 = performance.now();
    await Promise.all(takers.map(async (t, i) => {
        const s = performance.now();
        await takeOffers(ctx, t.party, [{ offer: offers[i]!, qty: 2n }], { maxSpendSats: 2000n }).then(() => takeLat.push(performance.now() - s), () => takeErrors++);
    }));
    result.concurrentTakes = { takers: 6, wallClockMs: Math.round(performance.now() - t0), errors: takeErrors, latencyMs: stats(takeLat) };
    result.phaseTimingsMs = { indexerGetVirtualTxs: stats(timings.getVirtualTxs), emulatorSubmitTx: stats(timings.emulatorSubmit), arkdSubmitTx: stats(timings.arkdSubmit) };

    result.apiReads = [
        await apiLoad("/api/markets?limit=50", 2000, 16),
        await apiLoad(`/api/markets/${m.marketId}`, 2000, 16),
        await apiLoad(`/api/markets/${m.marketId}/offers`, 2000, 16),
    ];
    result.serverProcess = (await api<{ process: unknown }>("/api/admin/overview", { admin: true })).body.process;
    writeFileSync("docs/evidence/perf.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
