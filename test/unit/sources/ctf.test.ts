import { describe, expect, it } from "vitest";
import { createCtfReader, header, quantity, type CtfReaderOptions } from "../../../src/server/sources/ctf.js";

const CTF = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const COND = `0x${"c0".repeat(32)}`;
const A = "https://a.example/SECRET-A";
const B = "https://b.example/SECRET-B";
const C = "https://c.example/SECRET-C";
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

interface Node {
    head?: bigint;
    payout?: [bigint, bigint, bigint];
    slots?: bigint;
    status?: number;
    error?: unknown;
    softError?: boolean;
    noBatch?: boolean;
    noTimestamp?: boolean;
}

function chain(nodes: Record<string, Node>, chainId = 137) {
    const seen: { host: string; body: unknown }[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const n = nodes[url.host] ?? { status: 400 };
        const body = JSON.parse(String(init?.body));
        seen.push({ host: url.host, body });
        if (n.status) return new Response("{}", { status: n.status });
        const [den, n0, n1] = n.payout ?? [0n, 0n, 0n];
        const result = (method: string, params: unknown[]) => {
            if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
            if (method === "eth_getBlockByNumber") {
                const b = params[0] === "finalized" ? (n.head ?? 100n) : BigInt(params[0] as string);
                return { number: `0x${b.toString(16)}`, hash: word(b), ...(n.noTimestamp ? {} : { timestamp: "0x10" }) };
            }
            const data = (params[0] as { data: string }).data;
            if (data.startsWith("0xdd34de67")) return word(den);
            if (data.startsWith("0x0504c814")) return word(BigInt(`0x${data.slice(-64)}`) === 0n ? n0 : n1);
            return word(n.slots ?? 2n);
        };
        const answer = (r: { id: unknown; method: string; params: unknown[] }) =>
            n.error !== undefined ? { jsonrpc: "2.0", id: r.id, error: n.error } : { jsonrpc: "2.0", id: r.id, result: result(r.method, r.params) };
        if (Array.isArray(body)) return n.noBatch ? Response.json(answer(body[0])) : Response.json(body.map(answer));
        return n.error !== undefined && !n.softError ? new Response(JSON.stringify(answer(body)), { status: 400 }) : Response.json(answer(body));
    }) as typeof fetch;
    return { f, seen };
}

const reader = (f: typeof fetch, extra: Partial<CtfReaderOptions> = {}) =>
    createCtfReader({ rpcUrls: [A, B, C], chainId: 137, ctf: CTF, minProviders: 2, timeoutMs: 1000, fetch: f, ...extra });

describe("CTF reader quorum", () => {
    it("reads one payout every provider agrees on, at the lowest finalized head", async () => {
        const { f, seen } = chain({ "a.example": { head: 120n, payout: [1n, 1n, 0n] }, "b.example": { head: 110n, payout: [1n, 1n, 0n] }, "c.example": { head: 130n, payout: [1n, 1n, 0n] } });
        const r = await reader(f).readPayout(COND);
        expect(r).toMatchObject({ ok: true, payout: { numerators: [1n, 0n], denominator: 1n }, chain: { chainId: 137, blockNumber: "110", providers: ["a.example#1", "b.example#2", "c.example#3"] } });
        const calls = seen.filter((s) => (s.body as { method: string }).method === "eth_call").map((s) => (s.body as { params: unknown[] }).params[1]);
        expect(new Set(calls)).toEqual(new Set(["0x6e"]));
    });

    it("reads at a pinned block, and refuses one not yet finalized everywhere", async () => {
        const { f } = chain({ "a.example": { head: 120n, payout: [1n, 1n, 0n] }, "b.example": { head: 110n, payout: [1n, 1n, 0n] } });
        expect(await reader(f).readPayout(COND, 105n)).toMatchObject({ ok: true, chain: { blockNumber: "105", blockHash: word(105n) } });
        expect(await reader(f).readPayout(COND, 111n)).toMatchObject({ ok: false, detail: "block 111 is not finalized on every provider yet (finalized 110)" });
    });

    it("fails closed when providers disagree, keeping the chain it read", async () => {
        const { f } = chain({ "a.example": { payout: [1n, 1n, 0n] }, "b.example": { payout: [1n, 0n, 1n] } });
        const r = await reader(f).readPayout(COND);
        expect(r).toMatchObject({ ok: false, detail: "CTF payouts differ across providers at block 100", chain: { blockNumber: "100" } });
    });

    it("drops a provider that is down, and throws below quorum naming hosts only", async () => {
        const { f } = chain({ "a.example": { payout: [1n, 1n, 0n] }, "b.example": { payout: [1n, 1n, 0n] } });
        expect(await reader(f).readPayout(COND)).toMatchObject({ ok: true, chain: { providers: ["a.example#1", "b.example#2"] } });
        const lone = chain({ "a.example": { payout: [1n, 1n, 0n] }, "c.example": { status: 400 } });
        const err = await reader(lone.f).readPayout(COND).catch((e: Error) => e.message);
        expect(err).toBe("finalized head: 1/2 providers answered; b.example#2 eth_chainId: HTTP 400 from b.example#2; c.example#3 eth_chainId: HTTP 400 from c.example#3");
        expect(err).not.toContain("SECRET");
    });

    it("refuses a provider on another chain", async () => {
        const { f } = chain({ "a.example": {}, "b.example": {} }, 1);
        expect(await reader(f).readPayout(COND)).toMatchObject({ ok: false, detail: "not on chain 137: a.example#1, b.example#2" });
    });

    it("refuses RPC URLs with credentials or that do not parse", () => {
        const { f } = chain({});
        expect(() => reader(f, { rpcUrls: ["https://u:p@a.example/"] })).toThrow("RPC URL #1 must be a valid URL without user:password");
        expect(() => reader(f, { rpcUrls: ["a.example/SECRET"] })).toThrow("RPC URL #1 must be a valid URL without user:password");
    });
});

describe("CTF reader agreement and screening", () => {
    it("agrees on an outcome slot count, or says why not", async () => {
        expect(await reader(chain({ "a.example": {}, "b.example": {} }).f).outcomeSlotCount(COND)).toEqual({ ok: true, value: 2n });
        const split = await reader(chain({ "a.example": {}, "b.example": { slots: 3n } }).f).outcomeSlotCount(COND);
        expect(split).toEqual({ ok: false, reason: "outcome slot count differs across providers: a.example#1=2, b.example#2=3" });
        const down = await reader(chain({ "a.example": {} }).f, { rpcUrls: [A, "https://c.example/"] }).outcomeSlotCount(COND);
        expect(down).toMatchObject({ ok: false, reason: expect.stringMatching(/^outcome slot count: 1\/2 providers answered; c\.example#2: HTTP 400/) });
    });

    it("screens in one batch per provider, counting a condition resolved only at quorum", async () => {
        const other = `0x${"d0".repeat(32)}`;
        const { f, seen } = chain({ "a.example": { payout: [1n, 1n, 0n] }, "b.example": { payout: [1n, 1n, 0n] }, "c.example": { noBatch: true } });
        expect(await reader(f).screenResolved([COND, other, COND])).toEqual([COND, other]);
        expect(seen.map((s) => [s.host, (s.body as unknown[]).length])).toEqual([["a.example", 2], ["b.example", 2], ["c.example", 2]]);
        expect(await reader(f).screenResolved([])).toEqual([]);
        const err = await reader(chain({ "a.example": {}, "b.example": { error: { code: -1 } } }).f, { rpcUrls: [A, B] }).screenResolved([COND]).catch((e: Error) => e.message);
        expect(err).toBe('resolution screen: 1/2 providers answered; b.example#2: batch item 0: {"code":-1}');
    });
});

describe("CTF reader per-provider options", () => {
    it("truncates JSON-RPC errors only when rpcErrorMax is set", async () => {
        const nodes = { "a.example": { error: { message: "x".repeat(400) }, softError: true } };
        const opts = { rpcUrls: [A, "https://c.example/"] };
        const full = await reader(chain(nodes).f, opts).outcomeSlotCount(COND);
        const cut = await reader(chain(nodes).f, { ...opts, rpcErrorMax: 20 }).outcomeSlotCount(COND);
        expect(full.ok || full.reason).toContain(`a.example#1: JSON-RPC error {"message":"${"x".repeat(200)}`);
        expect(cut.ok || cut.reason).toMatch(/a\.example#1: JSON-RPC error \{"message":"x{8}$/);
    });

    it("lets a stricter block decoder fail a provider whose head has no timestamp", async () => {
        const timed = (r: unknown) => ({ ...header(r), timestamp: quantity((r as { timestamp?: unknown }).timestamp) });
        const nodes = { "a.example": { payout: [1n, 1n, 0n] as [bigint, bigint, bigint] }, "b.example": { payout: [1n, 1n, 0n] as [bigint, bigint, bigint], noTimestamp: true } };
        expect(await reader(chain(nodes).f, { rpcUrls: [A, B] }).readPayout(COND)).toMatchObject({ ok: true });
        await expect(reader(chain(nodes).f, { rpcUrls: [A, B], header: timed }).readPayout(COND)).rejects.toThrow(/finalized head: 1\/2 providers answered; b\.example#2 eth_getBlockByNumber: not a hex quantity/);
    });
});
