import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { all, openDb, run } from "../../../src/server/db.js";
import { EventBus } from "../../../src/server/events.js";
import { getMarket } from "../../../src/server/markets.js";
import { resolutionTick } from "../../../src/server/resolver.js";
import { sourceBinding } from "../../../src/server/sources/definition.js";
import { CTF_ADDRESS, PROFILE, createPolymarketProvider } from "../../../src/server/sources/polymarket/index.js";

const gamma = JSON.parse(readFileSync(new URL("../../fixtures/polymarket/gamma.json", import.meta.url), "utf8"));
const PROVIDERS = ["https://rpc-one.example/v2/SECRET-ONE", "https://rpc-two.example/?key=SECRET-TWO"];
const BLOCK = { number: "0x100", hash: `0x${"11".repeat(32)}`, parentHash: `0x${"10".repeat(32)}`, timestamp: "0x6ac68397" };
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const TERMS = JSON.stringify({
    assets: { ctrl: "aa", yes: "bb", no: "cc" }, unitSats: "1000", capSats: "1000000", oracleKeys: ["aa".repeat(32), "aa".repeat(32), "aa".repeat(32)], oracleThreshold: 1, binding: "bb".repeat(32),
    closeAtUnix: "0", timeoutAtUnix: "0", exitDelaySeconds: "512",
});

type Payout = { den: bigint; n: [bigint, bigint] };
type RpcReq = { id: number; method: string; params: [{ to: string; data: string }, string] };

function setup() {
    const payouts = PROVIDERS.map(() => new Map<string, Payout>());
    const failing = new Set<number>();
    const requests: { provider: number; batch: RpcReq[] | null; req?: RpcReq }[] = [];
    const resultOf = (p: number, r: RpcReq) => {
        if (r.method === "eth_chainId") return "0x89";
        if (r.method === "eth_getBlockByNumber") return BLOCK;
        const data = r.params[0].data;
        const s = payouts[p]!.get(`0x${data.slice(10, 74)}`) ?? { den: 0n, n: [0n, 0n] };
        return word(data.startsWith("0xdd34de67") ? s.den : s.n[Number(BigInt(`0x${data.slice(74)}`))]!);
    };
    const fake = async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith("https://gamma-api.polymarket.com/")) return Response.json(gamma.markets[new URL(url).pathname.slice("/markets/".length)].response);
        const p = PROVIDERS.indexOf(url);
        const body = JSON.parse(String(init!.body)) as RpcReq | RpcReq[];
        requests.push(Array.isArray(body) ? { provider: p, batch: body } : { provider: p, batch: null, req: body });
        if (failing.has(p)) return new Response("unavailable", { status: 500 });
        const answer = (r: RpcReq) => ({ jsonrpc: "2.0", id: r.id, result: resultOf(p, r) });
        return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    };
    const provider = createPolymarketProvider({
        rpcUrls: PROVIDERS,
        resolverAllowlist: ["0x65070be91477460d8a7aeeb94ef92fe056c2f2a7", "0x157ce2d672854c848c9b79c49a8cc6cc89176a49"],
        fetch: fake as typeof fetch,
    });
    const db = openDb(join(mkdtempSync(join(tmpdir(), "apm-resolver-")), "apm.sqlite"));
    const logs: string[] = [];
    const d = {
        cfg: { APM_NETWORK: "regtest", RESOLUTION_INTERVAL_SECONDS: 0, ORACLE_URLS: [] } as never,
        db, bus: new EventBus(db), net: {} as never, providers: [provider],
        log: (msg: string, e?: Record<string, unknown>) => void logs.push(JSON.stringify({ msg, ...e })),
    };
    const addMarket = async (sourceId: string) => {
        const m = await provider.fetchMarketDefinition(sourceId);
        const t = new Date().toISOString();
        run(db, `INSERT INTO markets(id, kind, status, question, rules, outcomes, close_at, timeout_at, source_provider, source_id, source_version, source_snapshot,
                   profile, oracle_policy, oracle_keys, oracle_threshold, oracle_epoch, definition_hash, terms, vault_phase, created_at, updated_at)
                   VALUES (?, 'polymarket', 'open', ?, 'rules', ?, ?, ?, 'polymarket', ?, ?, ?, ?, 'platform-attestor', '[]', 1, 1, 'h', ?, 'open', ?, ?)`,
            `m-${sourceId}`, m.question, JSON.stringify(m.outcomes), Math.floor(Date.now() / 1000) + 3600, Math.floor(Date.now() / 1000) + 7200,
            sourceId, m.versionHash, JSON.stringify({ ...m, binding: sourceBinding(m, PROFILE) }), PROFILE, TERMS, t, t);
        return m.protocol.conditionId;
    };
    return { d, db, payouts, failing, requests, logs, addMarket };
}

describe("early source resolution", () => {
    it("screens open markets with one batched read per provider and flags only verified final payouts", async () => {
        const s = setup();
        const [open, early, oneSided, odd] = [await s.addMarket("559651"), await s.addMarket("3409541"), await s.addMarket("2758339"), await s.addMarket("4737427")];
        for (const p of s.payouts) {
            p.set(early, { den: 1n, n: [1n, 0n] });
            p.set(odd, { den: 3n, n: [1n, 2n] });
        }
        s.payouts[0]!.set(oneSided, { den: 1n, n: [0n, 1n] });
        const status = (id: string) => getMarket(s.db, `m-${id}`)!;
        const batches = () => s.requests.filter((r) => r.batch);
        const singles = () => s.requests.filter((r) => !r.batch);

        await resolutionTick(s.d);
        expect(batches().map((r) => r.provider)).toEqual([0, 1]);
        for (const { batch } of batches()) {
            expect(batch!.every((r) => r.method === "eth_call" && r.params[0].to === CTF_ADDRESS && r.params[1] === "finalized" && r.params[0].data.startsWith("0xdd34de67"))).toBe(true);
            expect(batch!.map((r) => `0x${r.params[0].data.slice(10)}`).sort()).toEqual([open, early, oneSided, odd].sort());
        }
        // Full finalized verification only where both providers report a payout: 6 reads per provider each.
        const verified = new Set(singles().filter((r) => r.req!.method === "eth_call").map((r) => `0x${r.req!.params[0].data.slice(10, 74)}`));
        expect([...verified].sort()).toEqual([early, odd].sort());
        expect(singles()).toHaveLength(2 * 2 * 6);

        expect(status("3409541")).toMatchObject({ status: "open", resolution_status: "source-final", resolution_detail: "Polymarket resolved early: Yes at Polygon block 256" });
        for (const id of ["559651", "2758339", "4737427"]) expect(status(id).resolution_status).toBe("pending");
        expect(s.d.bus.since(0)).toMatchObject([{ type: "market", marketId: "m-3409541", data: { resolution: "source-final", outcome: "Yes", sourceBlock: { number: "256" } } }]);

        s.requests.length = 0;
        await resolutionTick(s.d);
        expect(batches().map((r) => r.batch!.length)).toEqual([3, 3]);
        expect(singles().filter((r) => r.req!.params[0]?.data?.includes(early.slice(2)))).toHaveLength(0);

        s.requests.length = 0;
        s.failing.add(1);
        await resolutionTick(s.d);
        expect(s.requests.map((r) => r.provider).sort()).toEqual([0, 1]);
        expect(s.logs.at(-1)).toMatch(/early resolution screen failed.*rpc-two\.example#2/);
        s.failing.clear();

        s.requests.length = 0;
        run(s.db, "UPDATE markets SET close_at = ? WHERE id = 'm-3409541'", Math.floor(Date.now() / 1000) - 1);
        await resolutionTick(s.d);
        expect(singles().filter((r) => r.req!.params[0]?.data?.includes(early.slice(2)))).toHaveLength(2 * 3);
        expect(status("3409541")).toMatchObject({ resolution_status: "source-unavailable", resolution_detail: expect.stringContaining("ORACLE_URLS") });

        expect(JSON.stringify([all(s.db, "SELECT resolution_detail FROM markets"), s.d.bus.since(0), s.logs])).not.toMatch(/SECRET/);
    });
});
