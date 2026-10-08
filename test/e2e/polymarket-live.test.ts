import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { mintSets, redeemAll, walletParty, type Ctx } from "../../src/core/actions.js";
import { termsFromJson, type MarketJson } from "../../src/shared/api.js";
import { connectArkade, faucet, indexerProvider, newWallet, waitFor } from "./env.js";
import { network } from "./market.js";
import { startServer, type TestServer } from "./server.js";

const LIVE = process.env.LIVE_POLYMARKET === "1";
const RPCS = "https://polygon-bor-rpc.publicnode.com,https://polygon.drpc.org";
const RESOLVERS = "0x65070BE91477460D8A7AeEb94ef92fe056C2f2A7,0x157Ce2d672854c848c9b79C49a8Cc6cc89176a49";
let server: TestServer | undefined;
const attestors: ChildProcess[] = [];
const ATTESTOR_PORTS = [37421, 37422, 37423];
afterAll(async () => {
    await server?.stop();
    for (const a of attestors) a.kill();
});

describe.skipIf(!LIVE)("polymarket import and attested settlement (LIVE network)", () => {
    it("imports a live market and settles a historical replay from finalized Polygon state", { timeout: 1_200_000 }, async () => {
        const ark = await connectArkade();
        // Three independent attestor processes, each with its own key; markets need two of them.
        const secrets = ATTESTOR_PORTS.map(() => randomBytes(32).toString("hex"));
        const pubs = secrets.map((k) => hex.encode(schnorr.getPublicKey(hex.decode(k))));
        for (const [i, port] of ATTESTOR_PORTS.entries()) {
            attestors.push(spawn(process.execPath, ["--import", "tsx", "src/oracle/main.ts"], {
                env: {
                    ...process.env, ORACLE_SECRET_KEY: secrets[i], ORACLE_PORT: String(port), ORACLE_HOST: "127.0.0.1",
                    ORACLE_DATA_DIR: mkdtempSync(join(tmpdir(), "apm-oracle-")), APM_NETWORK: "regtest",
                    ARK_SIGNER_XONLY: hex.encode(ark.serverKey), EMULATOR_PUBKEY: hex.encode(ark.emulatorKey!),
                    POLYGON_RPC_URLS: RPCS, POLYMARKET_RESOLVERS: RESOLVERS,
                },
                stdio: "inherit",
            }));
            await waitFor(async () => fetch(`http://127.0.0.1:${port}/info`).then((r) => r.ok, () => false), { what: `attestor ${i + 1}` });
        }

        server = await startServer({
            port: 37403,
            env: {
                POLYMARKET_ENABLED: "true", POLYGON_RPC_URLS: RPCS, POLYMARKET_RESOLVERS: RESOLVERS, IMPORT_MAX_ACTIVE: "1",
                IMPORT_INTERVAL_SECONDS: "3600", IMPORT_MAX_PAGES: "3", ORACLE_URLS: ATTESTOR_PORTS.map((p) => `http://127.0.0.1:${p}`).join(","), ORACLE_PUBKEYS: pubs.join(","), ORACLE_THRESHOLD: "2",
            },
        });
        const { api } = server;
        const ov = await api<{ wallets: { operator: { address: string } } }>("/api/admin/overview", { admin: true });
        await faucet(ov.body.wallets.operator.address, 200_000);
        await new Promise((r) => setTimeout(r, 3000));

        // 1. Discovery imports and activates a live eligible market with no outcome entered by hand.
        const pass = await api<{ seen: number; eligible: number; activated: string[]; ineligibleByCode: Record<string, number> }>("/api/admin/import/run", { method: "POST", admin: true });
        console.log("import pass", JSON.stringify(pass.body));
        expect(pass.status).toBe(200);
        if (pass.body.activated.length > 0) {
            const live = await waitFor(async () => {
                const r = await api<MarketJson>(`/api/markets/${pass.body.activated[0]}`);
                return r.body.status === "open" && r.body;
            }, { what: "live market activated", timeoutMs: 180_000, intervalMs: 3000 });
            expect(live.source?.conditionId).toMatch(/^0x[0-9a-f]{64}$/);
            console.log(`imported live market ${live.source?.sourceId}: ${live.question} [${live.outcomes.join(" / ")}]`);
        }

        // 2. Historical replay of a market Polymarket resolved NO (2758339): the attestor re-reads finalized CTF state.
        const replay = await api<{ marketId: string }>("/api/admin/replay", { method: "POST", admin: true, body: JSON.stringify({ sourceId: "2758339" }) });
        expect(replay.status).toBe(201);
        const marketId = replay.body.marketId;
        const opened = await waitFor(async () => {
            const r = await api<MarketJson>(`/api/markets/${marketId}`);
            return r.body.status === "open" && r.body;
        }, { what: "replay activated", timeoutMs: 180_000, intervalMs: 3000 });
        const terms = termsFromJson(opened.terms!);
        const w = await newWallet();
        await faucet(await w.wallet.getAddress(), 20_000);
        await waitFor(async () => (await w.wallet.getBalance()).available >= 20_000, { what: "holder funds" });
        const holder = await walletParty(w.wallet, w.identity);
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        await mintSets(ctx, holder, terms, 4n);

        const resolved = await waitFor(async () => {
            const r = await api<MarketJson>(`/api/markets/${marketId}`);
            return r.body.vault.phase === "resolved" && r.body;
        }, { what: "attested resolution", timeoutMs: 600_000, intervalMs: 5000 });
        expect(resolved.vault.outcome).toBe("no");
        expect(resolved.resolution.certificate?.sourceBlock?.number).toBeTruthy();
        const db = new DatabaseSync(join(server.dataDir, "apm.sqlite"), { readOnly: true });
        const signed = db.prepare("SELECT evidence_digest, COUNT(DISTINCT signer) n FROM certificates WHERE market_id = ? AND outcome = 'no' GROUP BY evidence_digest").all(marketId) as { evidence_digest: string; n: number }[];
        db.close();
        expect(Math.max(...signed.map((g) => g.n))).toBeGreaterThanOrEqual(2);
        console.log(`replay resolved NO at Polygon block ${resolved.resolution.certificate?.sourceBlock?.number} ${resolved.resolution.certificate?.sourceBlock?.hash}; identical evidence signed by ${Math.max(...signed.map((g) => g.n))} of 3 attestors`);
        const paid = await redeemAll(ctx, holder, terms, "no");
        expect(paid.payout).toBe(4n * terms.unitSats);
    });
});
