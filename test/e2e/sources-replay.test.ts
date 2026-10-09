import { spawn, type ChildProcess } from "node:child_process";
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

const LIVE = process.env.LIVE_SOURCES === "1";
const ATTESTOR_PORT = 37431;
let server: TestServer | undefined;
let attestor: ChildProcess | undefined;
afterAll(async () => {
    await server?.stop();
    attestor?.kill();
});

// Settled source markets with known results (recorded in test/fixtures/{kalshi,manifold}).
const CASES = [
    { provider: "kalshi", sourceId: "KXIDNSLSPREAD-26OCT09PKEMAU-PKE2", outcome: "yes" },
    { provider: "manifold", sourceId: "nRSlhy5c2L", outcome: "no" },
] as const;

describe.skipIf(!LIVE)("Kalshi and Manifold replays settle through the attestor (LIVE APIs)", () => {
    it("replays a settled market from each source, resolves it on the source's result and pays the holder", { timeout: 1_500_000 }, async () => {
        const ark = await connectArkade();
        const secret = randomBytes(32).toString("hex");
        attestor = spawn(process.execPath, ["--import", "tsx", "src/oracle/main.ts"], {
            env: {
                ...process.env, ORACLE_SECRET_KEY: secret, ORACLE_PORT: String(ATTESTOR_PORT), ORACLE_HOST: "127.0.0.1",
                ORACLE_DATA_DIR: mkdtempSync(join(tmpdir(), "apm-oracle-")), APM_NETWORK: "regtest",
                ARK_SIGNER_XONLY: hex.encode(ark.serverKey), EMULATOR_PUBKEY: hex.encode(ark.emulatorKey!),
                POLYGON_RPC_URLS: "", KALSHI_ENABLED: "true", MANIFOLD_ENABLED: "true",
            },
            stdio: "inherit",
        });
        await waitFor(async () => fetch(`http://127.0.0.1:${ATTESTOR_PORT}/info`).then((r) => r.ok, () => false), { what: "attestor" });

        server = await startServer({
            port: 37404,
            env: {
                KALSHI_ENABLED: "true", MANIFOLD_ENABLED: "true", IMPORT_INTERVAL_SECONDS: "3600", RESOLUTION_INTERVAL_SECONDS: "10",
                ORACLE_URLS: `http://127.0.0.1:${ATTESTOR_PORT}`, ORACLE_PUBKEYS: hex.encode(schnorr.getPublicKey(hex.decode(secret))), ORACLE_THRESHOLD: "1",
            },
        });
        const { api } = server;
        const ov = await api<{ wallets: { operator: { address: string } } }>("/api/admin/overview", { admin: true });
        await faucet(ov.body.wallets.operator.address, 200_000);
        await new Promise((r) => setTimeout(r, 3000));
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };

        for (const c of CASES) {
            const replay = await api<{ marketId: string }>("/api/admin/replay", { method: "POST", admin: true, body: JSON.stringify(c) });
            expect(replay.status, JSON.stringify(replay.body)).toBe(201);
            const id = replay.body.marketId;
            const opened = await waitFor(async () => {
                const r = await api<MarketJson>(`/api/markets/${id}`);
                return r.body.status === "open" && r.body;
            }, { what: `${c.provider} replay activated`, timeoutMs: 180_000, intervalMs: 3000 });
            expect(opened.source?.provider).toBe(c.provider);
            const terms = termsFromJson(opened.terms!);
            const w = await newWallet();
            await faucet(await w.wallet.getAddress(), 20_000);
            await waitFor(async () => (await w.wallet.getBalance()).available >= 20_000, { what: "holder funds" });
            const holder = await walletParty(w.wallet, w.identity);
            await mintSets(ctx, holder, terms, 2n);

            const resolved = await waitFor(async () => {
                const r = await api<MarketJson>(`/api/markets/${id}`);
                return r.body.vault.phase === "resolved" && r.body;
            }, { what: `${c.provider} attested resolution`, timeoutMs: 600_000, intervalMs: 5000 });
            expect(resolved.vault.outcome).toBe(c.outcome);
            const paid = await redeemAll(ctx, holder, terms, c.outcome);
            expect(paid.payout).toBe(2n * terms.unitSats);
            console.log(`${c.provider} ${c.sourceId} resolved ${c.outcome.toUpperCase()} via the attestor; holder redeemed ${paid.payout} sats`);
        }
    });
});
