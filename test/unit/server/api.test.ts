import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { describe, expect, it, vi } from "vitest";
import { createApi } from "../../../src/server/api.js";
import { openDb, run, tx } from "../../../src/server/db.js";
import { EventBus } from "../../../src/server/events.js";
import { WriterLease } from "../../../src/server/lease.js";
import { Workflows } from "../../../src/server/workflows.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

function fresh() {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "apm-api-")), "apm.sqlite"));
    const bus = new EventBus(db);
    const app = createApi({ cfg: { APM_NETWORK: "regtest" } as never, db, bus, net: {} as never, health: async () => ({}), overview: async () => ({}) });
    return { db, bus, app };
}

function publishMany(f: ReturnType<typeof fresh>, n: number) {
    tx(f.db, () => {
        for (let i = 0; i < n; i++) f.bus.publish("market", `m${i}`, { i });
    });
}

/** Reads SSE frames and collects their ids; keeps one pending read so no chunk is dropped between calls. */
async function sse(app: ReturnType<typeof fresh>["app"], headers: Record<string, string> = {}) {
    const res = await app.request("/api/events", { headers });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const ids: number[] = [];
    let buf = "";
    let ended = false;
    let pending: ReturnType<typeof reader.read> | null = null;
    const readUntil = async (done: (ids: number[]) => boolean, ms = 5000) => {
        const deadline = Date.now() + ms;
        while (!done(ids) && !ended && Date.now() < deadline) {
            pending ??= reader.read();
            const r = await Promise.race([pending, sleep(deadline - Date.now()).then(() => null)]);
            if (!r) break;
            pending = null;
            if (r.done) ended = true;
            else buf += decoder.decode(r.value, { stream: true });
            const frames = buf.split("\n\n");
            buf = frames.pop()!;
            for (const f of frames) {
                const id = /^id: (\d+)$/m.exec(f);
                if (id) ids.push(Number(id[1]));
            }
        }
        return ids;
    };
    return { readUntil, ended: () => ended, close: () => reader.cancel() };
}

describe("api request limits", () => {
    it("caps the bytes actually read, including chunked bodies without Content-Length", async () => {
        const { app } = fresh();
        const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
        await new Promise((r) => server.once("listening", r));
        const port = (server.address() as AddressInfo).port;
        const post = (path: string, body: string, chunked: boolean) =>
            new Promise<string>((resolve) => {
                const length = chunked ? { "transfer-encoding": "chunked" } : { "content-length": String(Buffer.byteLength(body)) };
                const req = request({ host: "127.0.0.1", port, path, method: "POST", agent: false, headers: { "content-type": "application/json", ...length } }, (res) => {
                    let text = "";
                    res.on("data", (c) => (text += c));
                    res.on("error", () => {});
                    res.on("close", () => resolve(`${res.statusCode} ${text}`));
                });
                req.on("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? String(e)));
                for (let i = 0; i < body.length; i += 16_384) req.write(body.slice(i, i + 16_384));
                req.end();
            });
        try {
            const big = JSON.stringify({ marketId: "not-hex", pad: "A".repeat(1024 * 1024) });
            // An oversized chunked upload is answered 413 and then reset mid-upload; either way it is never parsed (400).
            expect(await post("/api/markets", big, true)).toMatch(/^(413 |ECONNRESET|EPIPE)/);
            expect(await post("/api/admin/replay", big, true)).toMatch(/^(413 |ECONNRESET|EPIPE)/);
            // Headers only: a client still uploading can see the reset before the 413 when the host is loaded.
            const declared = await new Promise<string>((resolve) => {
                const req = request({ host: "127.0.0.1", port, path: "/api/markets", method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(big)) } }, (res) => {
                    let text = "";
                    res.on("data", (c) => (text += c));
                    res.on("end", () => resolve(`${res.statusCode} ${text}`));
                });
                req.on("error", () => {});
                req.flushHeaders();
            });
            expect(declared).toMatch(/^413 .*too-large/);
            for (const chunked of [true, false]) expect(await post("/api/markets", JSON.stringify({ marketId: "not-hex" }), chunked)).toMatch(/^400 .*market-id/);
        } finally {
            server.close();
        }
    });

    it("clamps numeric query params into a positive range", async () => {
        const f = fresh();
        tx(f.db, () => {
            for (let i = 0; i < 201; i++) {
                run(f.db, `INSERT INTO markets(id, kind, status, question, rules, outcomes, close_at, timeout_at, oracle_policy, oracle_keys, oracle_threshold, oracle_epoch, definition_hash, created_at, updated_at)
                           VALUES (?, 'custom', 'open', 'q', 'r', '["Yes","No"]', 0, 0, 'external-key', '[]', 1, 1, 'h', ?, ?)`, `m${i}`, `2026-01-01T00:00:${String(i).padStart(3, "0")}`, "x");
            }
            for (let i = 0; i < 501; i++) {
                run(f.db, "INSERT INTO trades(txid, offer_id, market_id, outcome, kind, maker_side, qty, price_sats, at) VALUES (?, 'o', 'm0', 'yes', 'fill', 'sell', '1', '500', ?)", `t${i}`, String(i));
            }
        });
        const count = async (path: string) => Object.values((await (await f.app.request(path)).json()) as Record<string, unknown[]>)[0]!.length;
        expect(await count("/api/markets?limit=-1")).toBe(1);
        expect(await count("/api/markets?limit=0")).toBe(1);
        expect(await count("/api/markets?limit=99999999")).toBe(200);
        expect(await count("/api/markets?limit=abc")).toBe(50);
        expect(await count("/api/markets")).toBe(50);
        expect(await count("/api/markets/m0/trades?limit=-1")).toBe(1);
        expect(await count("/api/markets/m0/trades?limit=1e9")).toBe(500);
    });
});

describe("api event stream", () => {
    it("replays a backlog past one page and keeps events published during the replay", async () => {
        const f = fresh();
        publishMany(f, 600);
        const s = await sse(f.app);
        await s.readUntil((ids) => ids.length >= 10);
        f.bus.publish("market", "during-replay", {});
        await s.readUntil((ids) => ids.includes(601));
        f.bus.publish("market", "after", {});
        const ids = await s.readUntil((ids) => ids.includes(602));
        await s.close();
        expect(ids).toEqual(range(1, 602));
    });

    it("gives a client ahead of the log (restored database) a recent window, then live events", async () => {
        const f = fresh();
        publishMany(f, 150);
        const s = await sse(f.app, { "last-event-id": "100000" });
        await s.readUntil((ids) => ids.includes(150));
        f.bus.publish("market", "new", {});
        const ids = await s.readUntil((ids) => ids.includes(151));
        await s.close();
        expect(ids).toEqual(range(51, 151));
    });

    it("closes a client that cannot keep up; Last-Event-ID resumes without loss", async () => {
        const f = fresh();
        const slow = await sse(f.app);
        publishMany(f, 1100);
        const first = [...(await slow.readUntil(() => false, 4000))];
        expect(slow.ended()).toBe(true);
        const resumed = await sse(f.app, { "last-event-id": String(first.at(-1) ?? 0) });
        const rest = await resumed.readUntil((ids) => ids.includes(1100));
        await resumed.close();
        expect([...first, ...rest]).toEqual(range(1, 1100));
    });

    it("trims its own log as it publishes", () => {
        const f = fresh();
        const trim = vi.spyOn(f.bus, "trim");
        publishMany(f, 2000);
        expect(trim).toHaveBeenCalledTimes(2);
    });
});

describe("admin workflow retry", () => {
    it("returns a failed workflow to pending with its payload and refuses other states", async () => {
        const db = openDb(join(mkdtempSync(join(tmpdir(), "apm-api-")), "apm.sqlite"));
        const lease = new WriterLease(db);
        lease.tryAcquire();
        const wf = new Workflows(db, lease);
        const token = "t".repeat(32);
        const app = createApi({
            cfg: { APM_NETWORK: "regtest", ADMIN_TOKEN: token } as never, db, bus: new EventBus(db), net: {} as never,
            health: async () => ({}), overview: async () => ({}), keeper: { deps: { wf, lease } } as never,
        });
        const w = wf.enqueue("lp:m:1", "lp-liquidity", "m", { sets: "5", yesTerms: { priceSats: "600" } });
        wf.transition(w, "failed", { error: "registration failed", attempt: true });
        const retry = () => app.request("/api/admin/workflows/lp:m:1/retry", { method: "POST", headers: { authorization: `Bearer ${token}` } });

        expect((await retry()).status).toBe(200);
        expect(wf.get("lp:m:1")).toMatchObject({ state: "pending", attempts: 0, error: null, payload: { sets: "5", yesTerms: { priceSats: "600" } } });
        expect((await retry()).status).toBe(409);
        expect((await app.request("/api/admin/workflows/lp:m:1/retry", { method: "POST" })).status).toBe(401);
    });
});
