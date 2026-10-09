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
import { startEmbeddedAttestor } from "./embeddedAttestor.js";
import { Workflows } from "./workflows.js";
import { importOnce, replayHistorical } from "./importer.js";
import { resolutionTick } from "./resolver.js";
import { createPolymarketProvider } from "./sources/polymarket/index.js";
import { createKalshiProvider } from "./sources/kalshi/index.js";
import { createManifoldProvider } from "./sources/manifold/index.js";
import type { MarketSourceProvider, ProviderName } from "./sources/types.js";
import { captureTick } from "./rounds.js";
import { discoverUpDown, importUpDown, upcomingSlugs } from "./updown.js";

const cfg = loadConfig();
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), level: "info", msg, ...extra }));
log("starting", { config: redacted(cfg) });

const db = openDb(cfg.DB_PATH);
const bus = new EventBus(db);
const lease = new WriterLease(db);
const wf = new Workflows(db, lease);
let ready: { public: Hono; admin: Hono } | undefined;
let shuttingDown = false;

/** Same UI on both listeners; only the admin one mounts /api/admin. */
function listener(kind: "public" | "admin"): Hono {
    const root = new Hono();
    root.get("/api/health/live", (c) => c.json({ ok: true, shuttingDown }));
    root.all("*", async (c, next) => {
        if (!c.req.path.startsWith("/api/")) return next();
        if (ready) return ready[kind].fetch(c.req.raw);
        return c.json({ error: "starting: waiting for arkd/emulator", code: "starting" }, 503);
    });
    const webDir = join(process.cwd(), "dist", "web");
    root.use("/*", serveStatic({ root: "./dist/web" }));
    root.get("*", (c) => (existsSync(join(webDir, "index.html")) ? c.html(readFileSync(join(webDir, "index.html"), "utf8")) : c.text("UI not built", 404)));
    return root;
}

const server = serve({ fetch: listener("public").fetch, hostname: cfg.HOST, port: cfg.PORT }, (a) => log("listening", { port: a.port }));
const adminServer = serve({ fetch: listener("admin").fetch, hostname: cfg.HOST, port: cfg.ADMIN_PORT }, (a) => log("admin listening", { port: a.port }));
const stopAttestor = cfg.ORACLE_SECRET_KEY ? startEmbeddedAttestor(cfg, cfg.ORACLE_SECRET_KEY, log) : undefined;

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

    const attestorHealth = async () => {
        if (cfg.ORACLE_URLS.length === 0) return { ok: true, detail: "not configured" };
        const up = await Promise.all(cfg.ORACLE_URLS.map((u) => fetch(`${u}/info`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false)));
        const n = up.filter(Boolean).length;
        return { ok: n >= cfg.ORACLE_THRESHOLD, detail: `${n} of ${cfg.ORACLE_URLS.length} attestors reachable (quorum ${cfg.ORACLE_THRESHOLD})` };
    };
    const health = async () => {
        const check = async (p: Promise<unknown>) => p.then(() => ({ ok: true }), (e) => ({ ok: false, detail: String(e).slice(0, 200) }));
        return {
            db: await check(Promise.resolve(one(db, "SELECT 1"))),
            arkd: await check(net.arkProvider.getInfo()),
            emulator: await check(net.emulator.getInfo()),
            writer: { ok: lease.held, detail: lease.held ? "holding writer lease" : "waiting for writer lease" },
            oracle: await attestorHealth(),
        };
    };
    // Each slow read is capped so one hung dependency cannot blank the whole operator page.
    const capped = <T,>(p: Promise<T>, ms = 10_000) =>
        Promise.race([p, new Promise<{ error: string }>((r) => setTimeout(() => r({ error: `timed out after ${ms / 1000}s` }), ms))]).catch((e) => ({ error: String(e).slice(0, 200) }));
    // The SDK balance syncs the wallet's whole history; the indexer's spendable coins answer in one read.
    const walletInfo = (w: NonNullable<typeof operator>) => capped((async () => ({
        address: await w.wallet.getAddress(),
        available: (await w.party.coins()).reduce((sum, c) => sum + c.value, 0),
    }))());
    const overview = async () => {
        const [h, op, lpw] = await Promise.all([capped(health()), operator && walletInfo(operator), lp && walletInfo(lp)]);
        return {
            process: { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed, cpu: process.cpuUsage(), uptimeSeconds: Math.round(process.uptime()) },
            health: h,
            importLag: { lastRun: getMeta(db, "import.lastRun") ?? null, lastError: getMeta(db, "import.lastError") ?? null },
            oracleLag: all(db, "SELECT id, question, close_at FROM markets WHERE status IN ('halted','closed','resolving') AND close_at < ? ORDER BY close_at LIMIT 50", Math.floor(Date.now() / 1000)),
            workflows: { failed: wf.list({ state: "failed", limit: 50 }), inFlight: wf.list({ state: "submitting", limit: 50 }), pending: wf.list({ state: "pending", limit: 50 }), done: wf.list({ state: "done", limit: 30 }) },
            liquidity: all(db, "SELECT market_id, outcome, side, COUNT(*) offers, SUM(CAST(remaining AS INTEGER)) units FROM offers WHERE status = 'open' GROUP BY market_id, outcome, side"),
            expiries: all(db, "SELECT id, vault_expires_at FROM markets WHERE vault_expires_at IS NOT NULL ORDER BY vault_expires_at LIMIT 20"),
            wallets: {
                operator: op ?? null,
                lp: lpw ?? null,
            },
        };
    };
    const faucet = cfg.DEV_ENDPOINTS && operator
        ? async (address: string, amount: number) => operator.wallet.send({ address, amount })
        : undefined;
    const providers: MarketSourceProvider[] = [
        ...(cfg.POLYMARKET_ENABLED
            ? [createPolymarketProvider({
                  gammaUrl: cfg.POLYMARKET_GAMMA_URL, rpcUrls: cfg.POLYGON_RPC_URLS,
                  resolverAllowlist: cfg.POLYMARKET_RESOLVERS.map((r) => r.toLowerCase()),
                  creatorAllowlist: cfg.POLYMARKET_CREATORS, negRiskOracleAllowlist: cfg.POLYMARKET_NEGRISK_ORACLES,
              })]
            : []),
        ...(cfg.KALSHI_ENABLED ? [createKalshiProvider({ apiUrl: cfg.KALSHI_API_URL })] : []),
        ...(cfg.MANIFOLD_ENABLED ? [createManifoldProvider({ apiUrl: cfg.MANIFOLD_API_URL })] : []),
    ];
    const polymarket = providers.find((p) => p.name === "polymarket");
    const sourceDeps = providers.length > 0 ? { ...deps, wf, providers, timeoutDays: cfg.IMPORT_TIMEOUT_DAYS, log } : undefined;
    const importNow = sourceDeps && (async () => {
        if (!lease.held) throw new Error("not the writer");
        return importOnce(sourceDeps);
    });
    const replay = sourceDeps && cfg.DEV_ENDPOINTS ? (sourceId: string, provider?: ProviderName) => replayHistorical(sourceDeps, sourceId, provider) : undefined;
    const apiDeps = { ...deps, keeper, health, overview, faucet, importNow, replay };
    ready = { public: createApi(apiDeps), admin: createApi({ ...apiDeps, adminRoutes: true }) };
    log("api ready", { network: cfg.APM_NETWORK, operator: !!operator, lp: !!lp });

    if (cfg.WORKERS === "all") {
        const acquire = setInterval(() => {
            if (!lease.held && lease.tryAcquire()) log("writer lease acquired", { token: lease.token });
        }, 5000);
        if (lease.tryAcquire()) log("writer lease acquired", { token: lease.token });
        const stopHeartbeat = lease.keepAlive();
        let ticking: Promise<void> | undefined;
        const loop = setInterval(() => {
            if (shuttingDown || !lease.held || ticking) return;
            ticking = keeper.tick().catch((e) => log("keeper tick failed", { error: String(e) })).finally(() => (ticking = undefined));
        }, cfg.KEEPER_INTERVAL_SECONDS * 1000);
        // Up/Down mirrors: discovery every minute, and round capture while a start or end round is live.
        let capturing = false;
        const upDownLoops = cfg.UPDOWN_ENABLED && cfg.UPDOWN_SETTLEMENT === "redstone"
            ? [
                  setInterval(() => void (lease.held && discoverUpDown(cfg.POLYMARKET_GAMMA_URL, upcomingSlugs(cfg.UPDOWN_WINDOWS, cfg.UPDOWN_ASSETS, cfg.UPDOWN_LEAD_SECONDS))
                      .then((found) => importUpDown({ ...deps, wf }, found))
                      .then((ids) => ids.length && log("up/down import", { created: ids.length }), (e) => log("up/down import failed", { error: String(e) }))), 60_000),
                  setInterval(() => {
                      if (!lease.held || capturing) return;
                      capturing = true;
                      captureTick(db, 3).then((n) => n && log("RedStone round captured", { rounds: n }), (e) => log("round capture failed", { error: String(e) })).finally(() => (capturing = false));
                  }, 2_000),
              ]
            : [];
        // With UPDOWN_SETTLEMENT=polymarket, upcoming Up/Down markets join each import pass as ordinary CTF mirrors.
        const upcomingCtfUpDown = async () => (cfg.UPDOWN_ENABLED && cfg.UPDOWN_SETTLEMENT === "polymarket" && polymarket?.fetchMarketsBySlug
            ? polymarket.fetchMarketsBySlug(upcomingSlugs(cfg.UPDOWN_WINDOWS, cfg.UPDOWN_ASSETS, cfg.UPDOWN_LEAD_SECONDS))
            : []);
        let importing = false;
        const sourceLoops = sourceDeps
            ? [
                  // One pass at a time: activation awaits on-chain vetting between its cap check and its insert.
                  setInterval(() => {
                      if (!lease.held || importing) return;
                      importing = true;
                      upcomingCtfUpDown().then((upcoming) => importOnce(sourceDeps, upcoming))
                          .then((r) => log("import pass", { ...r }), (e) => log("import failed", { error: String(e) }))
                          .finally(() => (importing = false));
                  }, cfg.IMPORT_INTERVAL_SECONDS * 1000),
                  setInterval(() => void (lease.held && resolutionTick(sourceDeps).catch((e) => log("resolution tick failed", { error: String(e) }))), 15_000),
              ]
            : [];
        onShutdown.push(async () => {
            sourceLoops.forEach(clearInterval);
            upDownLoops.forEach(clearInterval);
            clearInterval(acquire);
            clearInterval(loop);
            await Promise.race([ticking, new Promise((r) => setTimeout(r, 20_000))]);
            stopHeartbeat();
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
    stopAttestor?.();
    server.close();
    adminServer.close();
    db.close();
    process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((err) => {
    console.error(JSON.stringify({ level: "fatal", msg: "startup failed", error: String(err) }));
    stopAttestor?.();
    process.exit(1);
});
