import { describe, expect, it, vi } from "vitest";
import { createApi } from "../../../src/server/api.js";
import { all, now, one, openDb, run, type Db } from "../../../src/server/db.js";
import { EventBus } from "../../../src/server/events.js";
import { jsonRpc, proofTick, ROOT_CHAIN, type ProofDeps } from "../../../src/server/proofs.js";
import type { ProofJobJson } from "../../../src/shared/api.js";
import { tempDb } from "./harness.js";

const COND = `0x${"d4".repeat(32)}`;
const TX = `0x${"ab".repeat(32)}`;
const word = (n: bigint | number) => BigInt(n).toString(16).padStart(64, "0");
const hex = (n: number) => `0x${n.toString(16)}`;

/** Polygon resolves `resolvedAt`; checkpoint k covers Polygon [1000(k-1), 1000k) and is posted in Ethereum block 20000+100k. */
function chain() {
    const s = { resolvedAt: 950_123 as number | null, polygonHead: 1_000_000, checkpoints: 900, finalized: 0, fail: false, calls: 0 };
    const T0 = 1_600_000_000;
    const l1Block = (k: number) => 20_000 + 100 * k;
    const polygon = async (method: string, params: unknown[]) => {
        s.calls++;
        if (s.fail) throw new Error("polygon down");
        if (method === "eth_blockNumber") return hex(s.polygonHead);
        if (method === "eth_call") return `0x${word(s.resolvedAt !== null && Number(params[1]) >= s.resolvedAt ? 1 : 0)}`;
        if (method === "eth_getLogs") {
            const f = params[0] as { fromBlock: string; topics: string[] };
            return Number(f.fromBlock) === s.resolvedAt && f.topics[1] === COND ? [{ transactionHash: TX, logIndex: "0x5" }] : [];
        }
        throw new Error(`unexpected ${method}`);
    };
    const ethereum = async (method: string, params: unknown[]) => {
        s.calls++;
        if (method === "eth_call") {
            const { to, data } = params[0] as { to: string; data: string };
            expect(to).toBe(ROOT_CHAIN);
            if (data === "0xec7e4855") return `0x${word(s.checkpoints * 10_000)}`;
            const k = Number(BigInt(`0x${data.slice(10)}`) / 10_000n);
            if (k < 1 || k > s.checkpoints) return `0x${word(0).repeat(5)}`;
            return `0x${word(k)}${word(1000 * (k - 1))}${word(1000 * k - 1)}${word(T0 + 12 * l1Block(k))}${word(7)}`;
        }
        if (method === "eth_getBlockByNumber") {
            const tag = params[0] as string;
            const n = tag === "latest" ? l1Block(s.checkpoints) + 50 : tag === "finalized" ? s.finalized : Number(tag);
            return { number: hex(n), timestamp: hex(T0 + 12 * n) };
        }
        throw new Error(`unexpected ${method}`);
    };
    return { s, l1Block, rpc: { polygon, ethereum } };
}

function insertMirror(db: Db, id: string, o: { status?: string; provider?: string; policy?: string; condition?: string } = {}) {
    const t = now();
    run(db, `INSERT INTO markets(id, kind, status, question, rules, outcomes, close_at, timeout_at, source_provider, source_id, source_snapshot,
             oracle_policy, oracle_keys, oracle_threshold, oracle_epoch, definition_hash, created_at, updated_at)
             VALUES (?, 'polymarket', ?, ?, 'r', '["Yes","No"]', 1, 2, ?, ?, ?, ?, '[]', 1, 1, 'dh', ?, ?)`,
        id, o.status ?? "closed", `question ${id}`, o.provider ?? "polymarket", `src-${id}`,
        JSON.stringify({ protocol: { conditionId: o.condition ?? COND } }), o.policy ?? "platform-attestor", t, t);
}

function setup() {
    const { db, path } = tempDb();
    const bus = new EventBus(db);
    const c = chain();
    const d: ProofDeps = { cfg: { POLYGON_ARCHIVE_RPC_URLS: [], ETHEREUM_RPC_URLS: [] }, db, bus, log: () => {}, rpc: c.rpc };
    const job = (id = "m1") => one<Record<string, unknown>>(db, "SELECT * FROM proof_jobs WHERE market_id = ?", id);
    const due = () => run(db, "UPDATE proof_jobs SET next_at = 0");
    const stages = () => all<{ data: string }>(db, "SELECT data FROM events WHERE type = 'proof' ORDER BY id").map((e) => JSON.parse(e.data).stage);
    return { db, path, bus, d, ...c, job, due, stages };
}

describe("proof tracker", () => {
    it("tracks only closed Polymarket mirrors on the attestor path, and waits while the result is not on Polygon", async () => {
        const t = setup();
        t.s.resolvedAt = null;
        insertMirror(t.db, "m1");
        insertMirror(t.db, "open", { status: "open" });
        insertMirror(t.db, "kalshi", { provider: "kalshi" });
        insertMirror(t.db, "redstone", { policy: "redstone" });
        insertMirror(t.db, "nocond", { condition: "" });
        await proofTick(t.d);
        expect(all<{ market_id: string }>(t.db, "SELECT market_id FROM proof_jobs").map((r) => r.market_id)).toEqual(["m1"]);
        expect(t.job()).toMatchObject({ stage: "waiting-source", polygon_block: null, attempts: 0 });
        expect(String(t.job()!.detail)).toMatch(/not recorded/);
        expect(t.stages()).toEqual(["waiting-source"]);
    });

    it("finds the resolution block, the covering checkpoint and its finalized Ethereum block in one visit", async () => {
        const t = setup();
        t.s.checkpoints = 1000;
        t.s.finalized = t.l1Block(1000);
        insertMirror(t.db, "m1");
        await proofTick(t.d);
        expect(t.job()).toMatchObject({
            stage: "witness-ready", polygon_block: 950_123, tx_hash: TX, log_index: 5, header_block_id: 9_510_000,
            checkpoint_root: `0x${word(951)}`, checkpoint_l1_block: t.l1Block(951), attempts: 0,
        });
        expect(t.stages()).toEqual(["waiting-source", "waiting-checkpoint", "waiting-l1-finality", "witness-ready"]);
    });

    it("waits for a checkpoint that covers the block, then for Ethereum finality", async () => {
        const t = setup();
        insertMirror(t.db, "m1");
        await proofTick(t.d);
        expect(t.job()).toMatchObject({ stage: "waiting-checkpoint", polygon_block: 950_123, header_block_id: null });
        expect(String(t.job()!.detail)).toMatch(/reaches 899999/);

        t.s.checkpoints = 951;
        t.s.finalized = t.l1Block(951) - 1;
        t.due();
        await proofTick(t.d);
        expect(t.job()).toMatchObject({ stage: "waiting-l1-finality", header_block_id: 9_510_000, checkpoint_l1_block: t.l1Block(951) });

        t.s.finalized = t.l1Block(951);
        t.due();
        await proofTick(t.d);
        expect(t.job()!.stage).toBe("witness-ready");
    });

    it("reads each job at most once a minute and backs off on RPC errors without throwing", async () => {
        const t = setup();
        t.s.resolvedAt = null;
        insertMirror(t.db, "m1");
        await proofTick(t.d);
        const calls = t.s.calls;
        await proofTick(t.d);
        expect(t.s.calls).toBe(calls);

        t.s.fail = true;
        t.due();
        await expect(proofTick(t.d)).resolves.toBeUndefined();
        const j = t.job()!;
        expect(j).toMatchObject({ stage: "waiting-source", attempts: 1 });
        expect(String(j.detail)).toMatch(/read error/);
        expect(String(j.detail)).not.toMatch(/polygon down/);
        expect(Number(j.next_at)).toBeGreaterThan(Date.now() + 100_000);
    });

    it("names only the provider host when every RPC fails", async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "archive required" } })))
            .mockRejectedValueOnce(new TypeError("fetch failed https://b.example/secret-key"));
        vi.stubGlobal("fetch", fetch);
        try {
            const err = await jsonRpc(["https://a.example/key-1", "https://b.example/secret-key"])("eth_call", []).catch((e: Error) => e.message);
            expect(err).toBe("eth_call failed (a.example: archive required; b.example: unreachable)");
        } finally {
            vi.unstubAllGlobals();
        }
    });
});

describe("migration 6", () => {
    it("creates proof_jobs on a fresh database and on one at version 5, keeping its rows", () => {
        const { db, path } = tempDb();
        expect(one<{ user_version: number }>(db, "PRAGMA user_version")!.user_version).toBe(6);
        insertMirror(db, "m1");
        db.exec("DROP TABLE proof_jobs; PRAGMA user_version = 5;");
        db.close();
        const again = openDb(path);
        expect(one<{ user_version: number }>(again, "PRAGMA user_version")!.user_version).toBe(6);
        expect(one(again, "SELECT id FROM markets WHERE id = 'm1'")).toBeTruthy();
        run(again, "INSERT INTO proof_jobs(market_id, stage, started_at, updated_at) VALUES ('m1', 'waiting-source', 'x', 'x')");
        expect(() => run(again, "INSERT INTO proof_jobs(market_id, stage, started_at, updated_at) VALUES ('m1', 'waiting-source', 'x', 'x')")).toThrow(/UNIQUE/);
        expect(() => run(again, "UPDATE proof_jobs SET stage = 'bogus'")).toThrow(/CHECK/);
    });
});

describe("proof api", () => {
    it("serves one market's job and the public list, hiding hidden markets", async () => {
        const t = setup();
        t.s.checkpoints = 1000;
        t.s.finalized = t.l1Block(1000);
        insertMirror(t.db, "m1");
        insertMirror(t.db, "m2", { status: "open" });
        insertMirror(t.db, "gone");
        await proofTick(t.d);
        run(t.db, "UPDATE markets SET status = 'hidden' WHERE id = 'gone'");
        const app = createApi({ cfg: { APM_NETWORK: "regtest" } as never, db: t.db, bus: t.bus, net: {} as never, health: async () => ({}), overview: async () => ({}) });
        const get = async (p: string) => {
            const r = await app.request(p);
            return { status: r.status, body: (await r.json()) as { job?: ProofJobJson | null; jobs?: ProofJobJson[] } };
        };
        const one1 = await get("/api/markets/m1/proof");
        expect(one1.status).toBe(200);
        expect(one1.body.job).toMatchObject({ marketId: "m1", question: "question m1", stage: "witness-ready", polygonBlock: 950_123, txHash: TX, headerBlockId: 9_510_000 });
        expect((await get("/api/markets/m2/proof")).body).toEqual({ job: null });
        expect((await get("/api/markets/gone/proof")).status).toBe(404);
        expect((await get("/api/markets/nope/proof")).status).toBe(404);
        expect((await get("/api/proofs?limit=10")).body.jobs!.map((j) => j.marketId)).toEqual(["m1"]);
    });
});
