import "../node/eventsource.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { scriptOfAddress, type Party } from "../core/actions.js";
import { createApi } from "./api.js";
import { loadConfig, redacted } from "./config.js";
import { all, getMeta, one, openDb, setMeta } from "./db.js";
import { EventBus } from "./events.js";
import { Keeper } from "./keeper.js";
import { WriterLease } from "./lease.js";
import { connectNetwork, partyFromMnemonic, type NetworkHandle } from "./network.js";
import { Workflows } from "./workflows.js";
import { importOnce, replayHistorical } from "./importer.js";
import { resolutionTick } from "./resolver.js";
import { createPolymarketProvider } from "./sources/polymarket/index.js";

const cfg = loadConfig();
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg, ...extra }));
log("starting", { config: redacted(cfg) });

const db = openDb(cfg.DB_PATH);
const bus = new EventBus(db);
const lease = new WriterLease(db);
const wf = new Workflows(db, lease);
let ready: Hono | undefined;
let shuttingDown = false;

const root = new Hono();
root.get("/api/health/live", (c) => c.json({ ok: true, shuttingDown }));
root.all("*", async (c, next) => {
    if (!c.req.path.startsWith("/api/")) return next();
    if (ready) return ready.fetch(c.req.raw);
    return c.json({ error: "starting: waiting for arkd/emulator", code: "starting" }, 503);
});
const webDir = join(process.cwd(), "dist", "web");
root.use("/*", serveStatic({ root: "./dist/web" }));
root.get("*", (c) => (existsSync(join(webDir, "index.html")) ? c.html(readFileSync(join(webDir, "index.html"), "utf8")) : c.text("UI not built", 404)));

const server = serve({ fetch: root.fetch, hostname: cfg.HOST, port: cfg.PORT }, (a) => log("listening", { port: a.port }));

/** A volume belongs to one network/operator/emulator; switching them is a drain + migration, not an env edit. */
function guardIdentity(net: NetworkHandle): void {
    const identity = {
        network: cfg.APM_NETWORK,
        deployment: cfg.APM_DEPLOYMENT_ID,
        arkSigner: net.info.signerPubkey,
        emulator: net.emulatorPubkey,
    };
    for (const [k, v] of Object.entries(identity)) {
        const stored = getMeta(db, `identity.${k}`);
        if (stored === undefined) setMeta(db, `identity.${k}`, v);
        else if (stored !== v) throw new Error(`data volume belongs to ${k}=${stored}, runtime reports ${v}; refusing to start (drain and migrate explicitly)`);
    }
}

async function connectWithRetry(): Promise<NetworkHandle> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await connectNetwork(cfg);
        } catch (err) {
            if (String(err).includes("pinned") || String(err).includes("reports network")) throw err;
            log("arkd/emulator unavailable, retrying", { error: String(err), attempt });
            await new Promise((r) => setTimeout(r, Math.min(30_000, 1000 * 2 ** attempt)));
        }
    }
}

async function main(): Promise<void> {
    const net = await connectWithRetry();
    guardIdentity(net);
    const operator = cfg.OPERATOR_MNEMONIC ? await partyFromMnemonic(cfg, cfg.OPERATOR_MNEMONIC) : undefined;
    const lp = cfg.LP_MNEMONIC ? await partyFromMnemonic(cfg, cfg.LP_MNEMONIC) : undefined;
    const devOracleKey = cfg.DEV_ORACLE_SECRET ? hex.encode(schnorr.getPublicKey(hex.decode(cfg.DEV_ORACLE_SECRET))) : undefined;
    const keeperScript: Uint8Array = operator?.party.script ?? scriptOfAddress(await (lp?.wallet.getAddress() ?? Promise.reject(new Error("keeper needs OPERATOR_MNEMONIC or LP_MNEMONIC"))));
    const deps = { cfg, db, net, bus, devOracleKey };
    const keeper = new Keeper({ ...deps, wf, lease, operator: operator?.party as Party | undefined, lp: lp?.party, keeperScript, log });

    const health = async () => {
        const check = async (p: Promise<unknown>) => p.then(() => ({ ok: true }), (e) => ({ ok: false, detail: String(e).slice(0, 200) }));
        return {
            db: await check(Promise.resolve(one(db, "SELECT 1"))),
            arkd: await check(net.arkProvider.getInfo()),
            emulator: await check(net.emulator.getInfo()),
            writer: { ok: lease.held, detail: lease.held ? "holding writer lease" : "waiting for writer lease" },
            oracle: cfg.ORACLE_URL ? await check(fetch(`${cfg.ORACLE_URL}/info`, { signal: AbortSignal.timeout(3000) }).then((r) => { if (!r.ok) throw new Error(String(r.status)); })) : { ok: true, detail: "not configured" },
        };
    };
    const overview = async () => ({
        health: await health(),
        importLag: { lastRun: getMeta(db, "import.lastRun") ?? null, lastError: getMeta(db, "import.lastError") ?? null },
        oracleLag: all(db, "SELECT id, question, close_at FROM markets WHERE status IN ('closed','resolving') AND close_at < ? ORDER BY close_at LIMIT 50", Math.floor(Date.now() / 1000)),
        workflows: { failed: wf.list({ state: "failed", limit: 50 }), inFlight: wf.list({ state: "submitting", limit: 50 }), pending: wf.list({ state: "pending", limit: 50 }) },
        liquidity: all(db, "SELECT market_id, outcome, side, COUNT(*) offers, SUM(CAST(remaining AS INTEGER)) units FROM offers WHERE status = 'open' GROUP BY market_id, outcome, side"),
        expiries: all(db, "SELECT id, vault_expires_at FROM markets WHERE vault_expires_at IS NOT NULL ORDER BY vault_expires_at LIMIT 20"),
        wallets: {
            operator: operator ? { address: await operator.wallet.getAddress(), available: (await operator.wallet.getBalance()).available } : null,
            lp: lp ? { address: await lp.wallet.getAddress(), available: (await lp.wallet.getBalance()).available } : null,
        },
    });
    const faucet = cfg.DEV_ENDPOINTS && operator
        ? async (address: string, amount: number) => operator.wallet.send({ address, amount })
        : undefined;
    const provider = cfg.POLYMARKET_ENABLED
        ? createPolymarketProvider({ gammaUrl: cfg.POLYMARKET_GAMMA_URL, rpcUrls: cfg.POLYGON_RPC_URLS, resolverAllowlist: cfg.POLYMARKET_RESOLVERS.map((r) => r.toLowerCase()) })
        : undefined;
    const sourceDeps = provider && { ...deps, wf, provider, timeoutDays: cfg.IMPORT_TIMEOUT_DAYS, log };
    const importNow = sourceDeps && (async () => {
        if (!lease.held) throw new Error("not the writer");
        return importOnce(sourceDeps);
    });
    const replay = sourceDeps && cfg.DEV_ENDPOINTS ? (sourceId: string) => replayHistorical(sourceDeps, sourceId) : undefined;
    ready = createApi({ ...deps, keeper, health, overview, faucet, importNow, replay });
    log("api ready", { network: cfg.APM_NETWORK, operator: !!operator, lp: !!lp });

    if (cfg.WORKERS === "all") {
        const acquire = setInterval(() => {
            if (!lease.held && lease.tryAcquire()) log("writer lease acquired", { token: lease.token });
        }, 5000);
        if (lease.tryAcquire()) log("writer lease acquired", { token: lease.token });
        let ticking: Promise<void> | undefined;
        const loop = setInterval(() => {
            if (shuttingDown || !lease.held || ticking) return;
            ticking = keeper.tick().catch((e) => log("keeper tick failed", { error: String(e) })).finally(() => (ticking = undefined));
        }, cfg.KEEPER_INTERVAL_SECONDS * 1000);
        const sourceLoops = sourceDeps
            ? [
                  setInterval(() => void (lease.held && importOnce(sourceDeps).then((r) => log("import pass", { ...r }), (e) => log("import failed", { error: String(e) }))), cfg.IMPORT_INTERVAL_SECONDS * 1000),
                  setInterval(() => void (lease.held && resolutionTick(sourceDeps).catch((e) => log("resolution tick failed", { error: String(e) }))), 15_000),
              ]
            : [];
        onShutdown.push(async () => {
            sourceLoops.forEach(clearInterval);
            clearInterval(acquire);
            clearInterval(loop);
            await Promise.race([ticking, new Promise((r) => setTimeout(r, 20_000))]);
            lease.release();
        });
    }
}

const onShutdown: (() => Promise<void>)[] = [];
async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutting down", { signal });
    for (const f of onShutdown) await f().catch((e) => log("shutdown step failed", { error: String(e) }));
    server.close();
    db.close();
    process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
    console.error(JSON.stringify({ level: "fatal", msg: "startup failed", error: String(err) }));
    process.exit(1);
});
