import { redacted } from "./config.js";
import type { ProviderName } from "./sources/types.js";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { hex } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1.js";
import { attestationMessage, signAttestation, evidenceDigest } from "../core/attestation.js";
import { BINARY_VECTORS, type BinaryOutcome } from "../core/payout.js";
import type { CertificateJson, ConfigJson, CreateMarketRequest, MarketEvent, PostOfferRequest, RegisterBoxRequest } from "../shared/api.js";
import { boxJson, boxesByOwner, registerBox } from "./boxes.js";
import { acceptCertificate } from "./certificates.js";
import { backup, now, run } from "./db.js";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Keeper } from "./keeper.js";
import { HttpError, getMarket, listMarkets, marketJson, marketTerms, registerCustomMarket, type Deps } from "./markets.js";
import { listOffers, offerJson, offersByMaker, refreshOffer, registerOffer, trades } from "./offers.js";
import { listProofJobs, proofJob } from "./proofs.js";

export interface ApiDeps extends Deps {
    keeper?: Keeper;
    health: () => Promise<Record<string, { ok: boolean; detail?: string }>>;
    importNow?: () => Promise<unknown>;
    overview: () => Promise<unknown>;
    faucet?: (address: string, amount: number) => Promise<string>;
    replay?: (sourceId: string, provider?: ProviderName) => Promise<string>;
    adminRoutes?: boolean;
}

const MAX_BODY = 64 * 1024;
const SSE_QUEUE_MAX = 1000;
const SSE_REWIND = 100;

async function body<T>(c: Context): Promise<T> {
    try {
        return (await c.req.json()) as T;
    } catch {
        throw new HttpError(400, "json", "body must be JSON");
    }
}

function intParam(raw: string | undefined, def: number, min: number, max: number): number {
    const n = Math.trunc(Number(raw || NaN));
    return Number.isNaN(n) ? def : Math.min(Math.max(n, min), max);
}

export function createApi(d: ApiDeps): Hono {
    const app = new Hono();
    const faucetSeen = new Map<string, number>();

    app.onError((err, c) => {
        if (err instanceof HttpError) return c.json({ error: err.message, code: err.code }, err.status as 400);
        console.error(JSON.stringify({ level: "error", msg: "api error", path: c.req.path, error: String(err) }));
        return c.json({ error: "internal error", code: "internal" }, 500);
    });
    const tooLarge = (c: Context) => c.json({ error: "request body too large", code: "too-large" }, 413);
    // Declared lengths are refused before bodyLimit opens the body stream: node-server can only drain an unopened one.
    app.use("*", async (c, next) => (Number(c.req.header("content-length") ?? 0) > MAX_BODY ? tooLarge(c) : next()));
    app.use("*", bodyLimit({ maxSize: MAX_BODY, onError: tooLarge }));

    app.get("/api/health/live", (c) => c.json({ ok: true }));
    app.get("/api/health/ready", async (c) => {
        const components = await d.health();
        const ok = components.db?.ok && components.arkd?.ok;
        return c.json({ ok: !!ok, components }, ok ? 200 : 503);
    });

    app.get("/api/config", (c) => {
        const cfg: ConfigJson = {
            network: d.cfg.APM_NETWORK,
            deploymentId: d.cfg.APM_DEPLOYMENT_ID,
            // Browsers may need different hostnames than the server uses on the container network.
            arkServerUrl: d.cfg.PUBLIC_ARK_SERVER_URL ?? d.cfg.ARK_SERVER_URL,
            emulatorUrl: d.cfg.PUBLIC_EMULATOR_URL ?? d.cfg.EMULATOR_URL,
            esploraUrl: d.cfg.PUBLIC_ESPLORA_URL ?? d.cfg.ESPLORA_URL,
            arkSignerPubkey: d.net.info.signerPubkey,
            emulatorPubkey: d.net.emulatorPubkey,
            explorerUrl: d.cfg.EXPLORER_URL ?? null,
            unitSats: String(d.cfg.MARKET_UNIT_SATS),
            exitDelaySeconds: d.net.exitDelaySeconds.toString(),
            devFaucet: d.cfg.DEV_ENDPOINTS && !!d.faucet,
            testNetwork: true,
            admin: !!d.adminRoutes,
            maxCloseHorizonSeconds: String(d.cfg.IMPORT_MAX_HORIZON_SECONDS),
        };
        return c.json(cfg);
    });

    app.get("/api/markets", (c) => {
        const limit = intParam(c.req.query("limit"), 50, 1, 200);
        const rows = listMarkets(d.db, {
            status: c.req.query("status") || undefined, kind: c.req.query("kind") || undefined,
            q: c.req.query("q")?.slice(0, 100) || undefined, limit, cursor: c.req.query("cursor") || undefined,
        });
        return c.json({ markets: rows.map((r) => marketJson(d.db, r)), next: rows.length === limit ? rows[rows.length - 1]!.created_at : null });
    });

    app.get("/api/markets/:id", (c) => {
        const row = getMarket(d.db, c.req.param("id"));
        if (!row || row.status === "hidden") throw new HttpError(404, "market", "unknown market");
        return c.json(marketJson(d.db, row));
    });

    app.get("/api/markets/:id/proof", (c) => {
        const row = getMarket(d.db, c.req.param("id"));
        if (!row || row.status === "hidden") throw new HttpError(404, "market", "unknown market");
        return c.json({ job: proofJob(d.db, row.id) });
    });
    app.get("/api/proofs", (c) => c.json({ jobs: listProofJobs(d.db, intParam(c.req.query("limit"), 50, 1, 200)) }));

    app.get("/api/markets/:id/offers", (c) => c.json({ offers: listOffers(d.db, c.req.param("id"), c.req.query("status") || undefined).map(offerJson) }));
    app.get("/api/markets/:id/trades", (c) => c.json({ trades: trades(d.db, { marketId: c.req.param("id"), limit: intParam(c.req.query("limit"), 100, 1, 500) }) }));

    app.post("/api/markets", async (c) => {
        const row = await registerCustomMarket(d, await body<CreateMarketRequest>(c));
        return c.json(marketJson(d.db, row), 201);
    });

    app.post("/api/markets/:id/certificates", async (c) => {
        const row = getMarket(d.db, c.req.param("id"));
        const terms = row && marketTerms(row);
        if (!row || !terms) throw new HttpError(404, "market", "unknown market");
        const { quorum } = acceptCertificate(d, row.id, terms, await body<CertificateJson>(c));
        return c.json({ accepted: true, quorum });
    });

    app.post("/api/offers", async (c) => c.json(await registerOffer(d, await body<PostOfferRequest>(c)), 201));
    app.post("/api/boxes", async (c) => c.json(await boxJson(d, registerBox(d, await body<RegisterBoxRequest>(c))), 201));
    app.get("/api/boxes", async (c) => {
        const owner = c.req.query("ownerScript") ?? "";
        if (!/^5120[0-9a-f]{64}$/.test(owner)) throw new HttpError(400, "script", "ownerScript must be a P2TR pkScript hex");
        return c.json({ boxes: await Promise.all(boxesByOwner(d.db, owner).map((b) => boxJson(d, b))) });
    });
    app.post("/api/offers/:id/refresh", async (c) => c.json(await refreshOffer(d, c.req.param("id"))));

    app.get("/api/portfolio", (c) => {
        const script = c.req.query("script") ?? "";
        if (!/^5120[0-9a-f]{64}$/.test(script)) throw new HttpError(400, "script", "script must be a P2TR pkScript hex");
        const offers = offersByMaker(d.db, script).map(offerJson);
        return c.json({ offers, trades: offers.length ? trades(d.db, { offerIds: offers.map((o) => o.id), limit: 500 }) : [] });
    });

    app.get("/api/events", (c) =>
        streamSSE(c, async (stream) => {
            let last = intParam(c.req.header("last-event-id") ?? c.req.query("since"), 0, 0, Number.MAX_SAFE_INTEGER);
            // Subscribed before the replay so nothing published meanwhile is lost. A full queue closes the stream: the
            // client reconnects with Last-Event-ID and replays from the log.
            const queue: MarketEvent[] = [];
            let overflow = false;
            const unsubscribe = d.bus.subscribe((e) => {
                if (queue.length < SSE_QUEUE_MAX) queue.push(e);
                else overflow = true;
            });
            stream.onAbort(unsubscribe);
            // Ids rewind after a database restore; a client ahead of the log gets a recent window instead of silence.
            const max = d.bus.lastId();
            if (last > max) last = Math.max(0, max - SSE_REWIND);
            const send = async (e: MarketEvent) => {
                if (e.id <= last) return;
                last = e.id;
                await stream.writeSSE({ id: String(e.id), event: e.type, data: JSON.stringify(e) });
            };
            for (let page = d.bus.since(last); page.length > 0 && !stream.aborted; page = d.bus.since(last)) {
                for (const e of page) await send(e);
            }
            while (!stream.aborted && !overflow) {
                while (queue.length && !overflow) await send(queue.shift()!);
                await stream.sleep(1000);
                if (queue.length === 0) await stream.writeSSE({ event: "ping", data: "{}" });
            }
            unsubscribe();
        }),
    );

    const admin = new Hono();
    // No token here, so edge credentials ride along on cross-site browser requests; refuse those (CSRF).
    admin.use("*", async (c, next) => {
        const site = c.req.header("sec-fetch-site");
        if (site && site !== "same-origin" && site !== "none") return c.json({ error: "cross-site admin request", code: "csrf" }, 403);
        await next();
    });
    admin.get("/overview", async (c) => c.json(await d.overview()));
    admin.get("/config", (c) => c.json(redacted(d.cfg)));
    admin.post("/import/run", async (c) => {
        if (!d.importNow) throw new HttpError(409, "disabled", "source import is disabled");
        return c.json(await d.importNow());
    });
    admin.post("/markets/:id/activate", (c) => {
        const row = getMarket(d.db, c.req.param("id"));
        if (!row || row.status !== "activating") throw new HttpError(409, "state", "market is not awaiting activation");
        return c.json(d.keeper!.deps.wf.enqueue(`activate:${row.id}`, "activate", row.id, {}));
    });
    admin.post("/markets/:id/hide", (c) => {
        run(d.db, "UPDATE markets SET status = 'hidden', updated_at = ? WHERE id = ?", now(), c.req.param("id"));
        d.bus.publish("market", c.req.param("id"), { status: "hidden" });
        return c.json({ ok: true });
    });
    admin.post("/markets/:id/liquidity", async (c) => {
        const row = getMarket(d.db, c.req.param("id"));
        if (!row?.terms) throw new HttpError(404, "market", "market not active");
        const b = await body<{ sets: string; yesAsk: string; noAsk: string }>(c);
        const sets = BigInt(b.sets);
        if (sets <= 0n || sets > 10_000n) throw new HttpError(400, "sets", "sets must be 1..10000");
        return c.json(d.keeper!.deps.wf.enqueue(`lp:${row.id}:${Date.now()}`, "lp-liquidity", row.id, { sets: b.sets, yesAsk: b.yesAsk, noAsk: b.noAsk }));
    });
    admin.post("/markets/:id/dev-resolve", async (c) => {
        const row = getMarket(d.db, c.req.param("id"));
        const terms = row && marketTerms(row);
        if (!row || !terms || row.oracle_policy !== "dev-oracle" || !d.cfg.DEV_ORACLE_SECRET) throw new HttpError(409, "dev-oracle", "not a dev-oracle market on regtest");
        const { outcome } = await body<{ outcome: BinaryOutcome }>(c);
        if (!(outcome in BINARY_VECTORS)) throw new HttpError(400, "outcome", "bad outcome");
        const evidence = evidenceDigest({ policy: "dev-oracle", market: row.id, outcome, at: now() });
        const vector = BINARY_VECTORS[outcome];
        const signer = hex.encode(schnorr.getPublicKey(hex.decode(d.cfg.DEV_ORACLE_SECRET)));
        acceptCertificate(d, row.id, terms, {
            outcome, numerators: vector.numerators.map(String), denominator: vector.denominator.toString(), evidenceDigest: hex.encode(evidence),
            signature: hex.encode(signAttestation(hex.decode(d.cfg.DEV_ORACLE_SECRET), attestationMessage(terms.binding, evidence, vector))),
            signer, sourceBlock: null, issuedAt: now(),
        });
        return c.json({ ok: true });
    });
    admin.post("/workflows/:id/retry", (c) => {
        const deps = d.keeper?.deps;
        const w = deps?.wf.get(c.req.param("id"));
        if (!deps || !w) throw new HttpError(404, "workflow", "unknown workflow");
        if (w.state !== "failed") throw new HttpError(409, "state", "only failed workflows can be retried");
        if (!deps.lease.held) throw new HttpError(409, "writer", "this process does not hold the writer lease");
        return c.json(deps.wf.transition(w, "pending", { error: null, nextAt: Date.now(), resetAttempts: true }));
    });
    admin.post("/backup", (c) => {
        const target = join(d.cfg.DATA_DIR, "backups", `apm-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite`);
        mkdirSync(dirname(target), { recursive: true });
        backup(d.db, target);
        return c.json({ path: target }, 201);
    });
    admin.post("/replay", async (c) => {
        if (!d.replay) throw new HttpError(409, "disabled", "historical replay needs DEV_ENDPOINTS and a source provider on regtest");
        const { sourceId, provider = "polymarket" } = await body<{ sourceId: string; provider?: string }>(c);
        if (!["polymarket", "kalshi", "manifold"].includes(provider)) throw new HttpError(400, "provider", "provider must be polymarket, kalshi or manifold");
        if (!/^[A-Za-z0-9._-]{1,80}$/.test(String(sourceId))) throw new HttpError(400, "source-id", "source market id expected");
        return c.json({ marketId: await d.replay(String(sourceId), provider as ProviderName) }, 201);
    });
    // Only the admin listener (ADMIN_PORT) mounts these; it is meant to be reachable only through a protected edge.
    if (d.adminRoutes) app.route("/api/admin", admin);

    if (d.cfg.DEV_ENDPOINTS && d.faucet) {
        app.post("/api/dev/faucet", async (c) => {
            const { address, amountSats } = await body<{ address: string; amountSats: string | number }>(c);
            const amount = Number(amountSats ?? 100_000);
            if (typeof address !== "string" || !/^tark1[0-9a-z]{20,200}$/.test(address)) throw new HttpError(400, "address", "expected a regtest Arkade address");
            if (!Number.isSafeInteger(amount) || amount < 1000 || amount > 1_000_000) throw new HttpError(400, "amount", "amount must be 1000..1000000 sats");
            const last = faucetSeen.get(address) ?? 0;
            if (Date.now() - last < 10_000) throw new HttpError(429, "rate", "wait 10 s between faucet requests");
            faucetSeen.set(address, Date.now());
            try {
                return c.json({ txid: await d.faucet!(address, amount) });
            } catch (err) {
                throw new HttpError(503, "faucet-unavailable", `faucet wallet could not pay: ${String(err).slice(0, 160)}`);
            }
        });
    }
    return app;
}
