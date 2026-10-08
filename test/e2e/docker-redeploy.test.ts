import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { takeOffers, type Ctx } from "../../src/core/actions.js";
import { coinFromJson, offerTermsFromJson, type MarketJson, type OfferJson } from "../../src/shared/api.js";
import { connectArkade, faucet, indexerProvider, waitFor } from "./env.js";
import { faucetTrader, postBid, registeredMarket } from "./flows.js";
import { network } from "./market.js";
import type { TestServer } from "./server.js";

const COMPOSE = ["compose", "-f", "compose.yaml", "-f", "compose.regtest.yaml", "--env-file", ".env.regtest"];
const run = promisify(execFile);
const dc = async (...args: string[]) => (await run("docker", [...COMPOSE, ...args], { encoding: "utf8", maxBuffer: 64 << 20 })).stdout;
const env = Object.fromEntries(
    execFileSync("node", ["-e", "process.stdout.write(require('fs').readFileSync('.env.regtest','utf8'))"], { encoding: "utf8" })
        .split("\n").filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const URL = "http://127.0.0.1:37400";
const api: TestServer["api"] = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    if (init.admin) headers.set("authorization", `Bearer ${env.ADMIN_TOKEN}`);
    const r = await fetch(`${URL}${path}`, { ...init, headers });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
};
const ready = () => waitFor(async () => (await fetch(`${URL}/api/health/ready`).then((r) => r.json(), () => undefined))?.components?.writer?.ok === true, { what: "container ready with writer lease", timeoutMs: 120_000, intervalMs: 2000 });
const shim = { api } as TestServer;
const volume = "arkade-prediction_apm-data";
const inVolume = async (cmd: string) => (await run("docker", ["run", "--rm", "-v", `${volume}:/data`, "--entrypoint", "sh", "arkade-prediction:local", "-c", cmd], { encoding: "utf8" })).stdout;

describe.skipIf(process.env.DOCKER_E2E !== "1")("docker image: redeploy, backup and restore on one volume", () => {
    it("persists state across recreation and reconciles a restored backup from the indexer", { timeout: 1_200_000 }, async () => {
        await dc("up", "-d", "--no-build");
        await ready();
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const ov = await api<{ wallets: { operator: { address: string } } }>("/api/admin/overview", { admin: true });
        await faucet(ov.body.wallets.operator.address, 200_000);
        const alice = await faucetTrader(shim, 40_000);
        const bob = await faucetTrader(shim, 20_000);
        const m = await registeredMarket(shim, ctx, alice, 3600);
        await postBid(shim, ctx, m.marketId, bob, m.terms.assets.no, 400n, 4n);

        // Backup now, then trade so the backup is stale.
        const backup = await api<{ path: string }>("/api/admin/backup", { method: "POST", admin: true });
        expect(backup.status).toBe(201);
        const [bid] = (await api<{ offers: OfferJson[] }>(`/api/markets/${m.marketId}/offers?status=open`)).body.offers;
        await waitFor(async () => (await alice.party.coins()).some((c) => c.assets?.some((a) => a.assetId === m.terms.assets.no)), { what: "alice NO" });
        await takeOffers(ctx, alice.party, [{ offer: { terms: offerTermsFromJson(bid!.terms), coin: coinFromJson(bid!.coin!) }, qty: 1n }], { minReceiveSats: 400n });
        await waitFor(async () => (await api<OfferJson>(`/api/offers/${encodeURIComponent(bid!.id)}/refresh`, { method: "POST" })).body.remaining === "3", { what: "fill seen" });

        // Recreate the container on the same volume: state survives, the new process takes the writer lease.
        const recreatedAt = Date.now();
        await dc("up", "-d", "--no-build", "--force-recreate", "app");
        await ready();
        // A graceful SIGTERM released the lease, so the new container did not wait out the 30 s lease TTL.
        expect(Date.now() - recreatedAt).toBeLessThan(30_000);
        expect((await api<MarketJson>(`/api/markets/${m.marketId}`)).body.status).toBe("open");

        // Restore the older backup, then let the keeper reconcile the offer from authoritative indexer state.
        await dc("stop", "app");
        expect(await dc("logs", "app")).toContain("shutting down");
        await inVolume(`cp '${backup.body.path}' /data/apm.sqlite && rm -f /data/apm.sqlite-wal /data/apm.sqlite-shm`);
        const restoredRemaining = (await inVolume(
            `node -e "const { DatabaseSync } = require('node:sqlite'); console.log(new DatabaseSync('/data/apm.sqlite').prepare('SELECT remaining FROM offers WHERE id = ?').get(process.argv[1]).remaining)" '${bid!.id}'`,
        )).trim();
        expect(restoredRemaining).toBe("4");
        await dc("start", "app");
        await ready();
        await waitFor(async () => (await api<{ offers: OfferJson[] }>(`/api/markets/${m.marketId}/offers`)).body.offers.find((o) => o.id === bid!.id)?.remaining === "3", { what: "reconciled after restore", timeoutMs: 120_000, intervalMs: 3000 });
        console.log(`restored remaining=${restoredRemaining} reconciled remaining=3 backup=${backup.body.path}`);
    });
});
