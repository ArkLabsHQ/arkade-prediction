import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CTF_ADDRESS, PROFILE, createPolymarketProvider, deriveConditionId } from "../../../src/server/sources/polymarket/index.js";
import type { EligibilityPolicy, ResolutionEvidence, SourceMarket } from "../../../src/server/sources/types.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/polymarket/${name}`, import.meta.url), "utf8"));
const gamma = fixture("gamma.json");
const rpc = fixture("rpc.json");

const PUBLICNODE = "https://polygon-bor-rpc.publicnode.com";
const DRPC = "https://polygon.drpc.org";
const TENDERLY = "https://polygon.gateway.tenderly.co";
const ALLOWLIST = ["0x65070be91477460d8a7aeeb94ef92fe056c2f2a7", "0x157ce2d672854c848c9b79c49a8cc6cc89176a49"];
const NOW = new Date("2026-10-07T17:00:00Z");
const POLICY: EligibilityPolicy = { profiles: [PROFILE], tags: [], minHorizonSeconds: 3600, maxHorizonSeconds: 365 * 86400 };
const DEN = "0xdd34de67";
const NUM = "0x0504c814";

interface Exchange {
    rpcUrl: string;
    method: string;
    params: unknown[];
    result: unknown;
}
interface Call {
    provider: string;
    method: string;
    params: unknown[];
    result?: unknown;
    error?: string;
}
type Override = (provider: string, method: string, params: unknown[], result: unknown) => unknown;

const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const dataOf = (params: unknown[]) => (params[0] as { data?: string }).data ?? "";
const isRead = (params: unknown[], selector: string, index?: bigint) =>
    dataOf(params).startsWith(selector) && (index === undefined || BigInt(`0x${dataOf(params).slice(-64)}`) === index);
const callsOf = (ev: ResolutionEvidence) => ev.reads?.calls as Call[];

function setup(opts: { scenario?: string; override?: Override; markets?: Record<string, unknown>; keyset?: unknown; allowlist?: string[] } = {}) {
    const requests: string[] = [];
    const exchanges: Exchange[] = [...rpc.chainId, ...(opts.scenario ? rpc.scenarios[opts.scenario].exchanges : [])];
    const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        requests.push(url);
        if (url.startsWith("https://gamma-api.polymarket.com/")) {
            const { pathname } = new URL(url);
            const id = pathname.slice("/markets/".length);
            const body = pathname === "/markets/keyset" ? (opts.keyset ?? gamma.keyset.response) : (opts.markets?.[id] ?? gamma.markets[id]?.response);
            return body ? Response.json(body) : new Response("not found", { status: 404 });
        }
        const req = JSON.parse(String(init?.body));
        const key = JSON.stringify(req.params).toLowerCase();
        const hit = exchanges.find((e) => e.rpcUrl === url && e.method === req.method && JSON.stringify(e.params).toLowerCase() === key);
        if (!hit) return new Response(`no fixture for ${req.method} ${key}`, { status: 400 });
        const result = opts.override ? opts.override(url, req.method, req.params, hit.result) : hit.result;
        return Response.json({ jsonrpc: "2.0", id: req.id, result });
    };
    const p = createPolymarketProvider({
        rpcUrls: opts.scenario ? rpc.scenarios[opts.scenario].providers : [PUBLICNODE, DRPC],
        resolverAllowlist: opts.allowlist ?? ALLOWLIST,
        fetch: fake as typeof fetch,
    });
    return { p, requests };
}

const definition = (id: string, opts: Parameters<typeof setup>[0] = {}) => setup(opts).p.fetchMarketDefinition(id);

describe("polymarket normalization", () => {
    it("normalizes a keyset page and pages with after_cursor", async () => {
        const { p, requests } = setup();
        const page = await p.discoverMarkets(null, 500);
        const q = new URL(requests[0]!).searchParams;
        expect([q.get("closed"), q.get("include_tag"), q.get("limit"), q.get("after_cursor")]).toEqual(["false", "true", "100", null]);
        expect(page.markets.map((m) => m.sourceId)).toEqual(["559651", "559652", "559653", "559654", "559655"]);
        expect(page.next).toBe(gamma.keyset.response.next_cursor);

        const m = page.markets[0]!;
        expect(m).toMatchObject({
            provider: "polymarket",
            slug: "xi-jinping-out-before-2027",
            url: "https://polymarket.com/market/xi-jinping-out-before-2027",
            question: "Xi Jinping out before 2027?",
            outcomes: ["Yes", "No"],
            referencePrices: [
                { outcome: "Yes", price: "0.0265" },
                { outcome: "No", price: "0.9735" },
            ],
            endDate: "2027-01-01T04:59:00.000Z",
            tags: ["earn-4", "geopolitics", "hfc", "macro-geopolitics", "world", "world-affairs"],
            active: true,
            closed: false,
            archived: false,
            sourceStatus: null,
            protocol: {
                version: "v1",
                chainId: 137,
                negRisk: false,
                resolver: "0x157ce2d672854c848c9b79c49a8cc6cc89176a49",
                conditionId: "0xa467b14d51f01b957109d9cbb1d6c124fab2a089d52ed8f471d23c2812e743b7",
                questionId: "0x1d925c6933062c2e38031293612d8680ffa097c5d3ba2f87a8ecc565bd47183e",
                settlementContract: CTF_ADDRESS,
            },
        });
        expect(m.versionHash).toMatch(/^[0-9a-f]{64}$/);
        expect(page.markets[1]!.protocol.negRisk).toBe(true);

        await p.discoverMarkets(page.next, 5);
        expect(new URL(requests[1]!).searchParams.get("after_cursor")).toBe(page.next);
    });

    it("normalizes discovery and definition identically; versionHash ignores prices and fetchedAt", async () => {
        const [listed] = (await setup().p.discoverMarkets(null, 5)).markets;
        const raw = gamma.markets["559651"].response;
        const def = await definition("559651");
        expect(def.versionHash).toBe(listed!.versionHash);

        const repriced = await definition("559651", { markets: { "559651": { ...raw, outcomePrices: '["0.5", "0.5"]' } } });
        expect(repriced.referencePrices?.[0]?.price).toBe("0.5");
        expect(repriced.versionHash).toBe(def.versionHash);
        const reworded = await definition("559651", { markets: { "559651": { ...raw, description: `${raw.description} Edited.` } } });
        expect(reworded.versionHash).not.toBe(def.versionHash);
    });

    it("parses untrusted fields defensively and bounds strings", async () => {
        const hostile = {
            id: "1",
            slug: "x",
            question: "q".repeat(600),
            description: "d".repeat(30_000),
            resolutionSource: 7,
            outcomes: "not json",
            outcomePrices: "[1, 2]",
            tags: Array.from({ length: 30 }, (_, i) => ({ slug: `TAG${i}`.padEnd(100, "x") })),
            resolvedBy: "0xZZ",
            conditionId: "0x12",
            version: "v1",
            closed: "no",
        };
        const m = await definition("1", { markets: { "1": hostile } });
        expect([m.question.length, m.description.length, m.resolutionSource]).toEqual([500, 20_000, ""]);
        expect(m.tags).toHaveLength(20);
        expect(m.tags.every((t) => t.length === 64 && t === t.toLowerCase())).toBe(true);
        expect(m).toMatchObject({ outcomes: [], referencePrices: null, endDate: null, closed: true, archived: true, active: false });
        expect(m.protocol).toMatchObject({ resolver: null, conditionId: "", questionId: "", negRisk: true });

        const { p, requests } = setup({ keyset: { markets: [{ question: "no id" }, gamma.markets["559651"].response] } });
        const page = await p.discoverMarkets(null, 5);
        expect(page.markets.map((x) => x.sourceId)).toEqual(["559651"]);
        expect(page.next).toBeNull();
        await expect(p.fetchMarketDefinition("../keyset")).rejects.toThrow(/invalid Polymarket market id/);
        expect(requests).toHaveLength(1);
    });
});

describe("polymarket eligibility", () => {
    it("reproduces Gamma conditionIds from (resolvedBy, questionID, 2)", () => {
        for (const id of ["2758339", "3409541", "4737427", "559651"]) {
            const m = gamma.markets[id].response;
            expect(deriveConditionId(m.resolvedBy.toLowerCase(), m.questionID)).toBe(m.conditionId.toLowerCase());
        }
        const negRisk = gamma.keyset.response.markets[1];
        expect(deriveConditionId(negRisk.resolvedBy.toLowerCase(), negRisk.questionID)).not.toBe(negRisk.conditionId.toLowerCase());
    });

    it("returns machine-readable codes", async () => {
        const { p } = setup();
        const [open, negRisk] = (await p.discoverMarkets(null, 5)).markets as [SourceMarket, SourceMarket];
        const code = (m: SourceMarket, policy: Partial<EligibilityPolicy> = {}, provider = p) => {
            const e = provider.evaluateEligibility(m, { ...POLICY, ...policy }, NOW);
            return e.eligible ? "eligible" : e.code;
        };
        const tweak = (protocol: Partial<SourceMarket["protocol"]>, rest: Partial<SourceMarket> = {}) => ({ ...open, ...rest, protocol: { ...open.protocol, ...protocol } });

        expect(code(open)).toBe("eligible");
        expect(code(negRisk)).toBe("neg-risk");
        expect(code(await p.fetchMarketDefinition("5379000"))).toBe("unknown-resolver");
        expect(code(open, {}, setup({ allowlist: [ALLOWLIST[0]!] }).p)).toBe("unknown-resolver");
        expect(code(await p.fetchMarketDefinition("2758339"))).toBe("closed");
        expect(code(open, { profiles: [] })).toBe("profile-disabled");
        expect(code(tweak({ version: "v2" }))).toBe("unsupported-version");
        expect(code(tweak({}, { outcomes: ["Yes", "No", "Maybe"] }))).toBe("not-binary");
        expect(code(tweak({}, { outcomes: ["Yes", "Yes"] }))).toBe("not-binary");
        expect(code(tweak({ questionId: `0x${"0".repeat(64)}` }))).toBe("condition-mismatch");
        expect(code(open, { maxHorizonSeconds: 30 * 86400 })).toBe("horizon");
        expect(code(tweak({}, { endDate: null }))).toBe("horizon");
        expect(code(open, { tags: ["sports"] })).toBe("tag-filter");
        expect(code(open, { tags: ["sports", "GEOPOLITICS"] })).toBe("eligible");
    });
});

describe("polymarket resolution evidence", () => {
    it.each([
        ["2758339", [0n, 1n], 1n, "95124407", "0xe362f8fdf41ac94813ea01969524c1ac64789b81ac58511a9237b3b9b5732d01", "(No)"],
        ["3409541", [1n, 0n], 1n, "95124446", "0x26985c455b7c39c0d2cb2ee5df060dff9e9744b2c53a7783cc6d0a04229f8f19", "(Yes)"],
        ["4737427", [1n, 1n], 2n, "95124752", "0x182d9404fb6dd6305154b6d00d46e23d12c3ee9dadf974b385a12c33ba48dcbb", "(50-50)"],
    ])("reads final %s at one finalized block on every provider", async (id, numerators, denominator, blockNumber, blockHash, label) => {
        const { p } = setup({ scenario: id });
        const market = await p.fetchMarketDefinition(id);
        const ev = await p.fetchResolutionEvidence(market);
        const providers = rpc.scenarios[id].providers as string[];
        expect(ev.status).toBe("final");
        expect(ev.detail).toContain(label);
        expect(ev.vector).toEqual({ numerators, denominator });
        expect(ev.chain).toEqual({ chainId: 137, blockNumber, blockHash, providers });
        const calls = callsOf(ev);
        expect(calls).toHaveLength(providers.length * 6);
        expect(calls.every((c) => providers.includes(c.provider) && c.method && c.params && c.result !== undefined && !c.error)).toBe(true);
        expect(calls.filter((c) => c.method === "eth_call").every((c) => c.params[1] === `0x${BigInt(blockNumber).toString(16)}`)).toBe(true);
        expect(p.verifyFinalResolution(market, ev, PROFILE)).toEqual({ ok: true });
    });

    it("treats denominator 0 as unresolved and surfaces Gamma proposed/disputed", async () => {
        const { p } = setup({ scenario: "559651" });
        const market = await p.fetchMarketDefinition("559651");
        const ev = await p.fetchResolutionEvidence(market);
        expect(ev).toMatchObject({ status: "unresolved", chain: { blockNumber: "95126347", providers: [PUBLICNODE, DRPC] } });
        expect(ev.vector).toBeUndefined();
        expect(ev.reads?.payout).toEqual({ numerators: [0n, 0n], denominator: 0n });
        expect(p.verifyFinalResolution(market, ev, PROFILE)).toMatchObject({ ok: false });
        for (const s of ["proposed", "disputed"] as const) {
            const hinted = await p.fetchResolutionEvidence({ ...market, sourceStatus: s });
            expect(hinted.status).toBe(s);
            expect(hinted.detail).toContain(`umaResolutionStatus=${s}`);
        }
    });

    it("reports provider disagreement, a block-hash mismatch and a wrong chain as inconsistent", async () => {
        const cases: Override[] = [
            (u, m, params, r) => (u === DRPC && m === "eth_call" && isRead(params, NUM, 0n) ? word(0n) : r),
            (u, m, params, r) => (u === DRPC && m === "eth_getBlockByNumber" && params[0] !== "finalized" ? { ...(r as object), hash: `0x${"ab".repeat(32)}` } : r),
            (u, m, _params, r) => (u === DRPC && m === "eth_chainId" ? "0x1" : r),
        ];
        for (const override of cases) {
            const { p } = setup({ scenario: "4737427", override });
            const ev = await p.fetchResolutionEvidence(await p.fetchMarketDefinition("4737427"));
            expect(ev.status).toBe("inconsistent");
            expect(ev.vector).toBeUndefined();
        }
    });

    it("reports a vector outside the three supported shapes as unsupported, with the raw vector", async () => {
        const raw: [string, bigint | undefined, bigint][] = [
            [DEN, undefined, 3n],
            [NUM, 0n, 1n],
            [NUM, 1n, 2n],
        ];
        const override: Override = (_u, m, params, r) => {
            const hit = m === "eth_call" ? raw.find(([sel, i]) => isRead(params, sel, i)) : undefined;
            return hit ? word(hit[2]) : r;
        };
        const { p } = setup({ scenario: "4737427", override });
        const market = await p.fetchMarketDefinition("4737427");
        const ev = await p.fetchResolutionEvidence(market);
        expect(ev.status).toBe("unsupported");
        expect(ev.vector).toBeUndefined();
        expect(ev.reads?.payout).toEqual({ numerators: [1n, 2n], denominator: 3n });
        expect(p.verifyFinalResolution(market, ev, PROFILE)).toMatchObject({ ok: false });
    });

    it("never turns a failed or empty read into unresolved", async () => {
        const emptyDen =
            (target?: string): Override =>
            (u, m, params, r) =>
                (target === undefined || u === target) && m === "eth_call" && isRead(params, DEN) ? "0x" : r;

        const three = setup({ scenario: "2758339", override: emptyDen(TENDERLY) }).p;
        const ev = await three.fetchResolutionEvidence(await three.fetchMarketDefinition("2758339"));
        expect(ev).toMatchObject({ status: "final", chain: { providers: [PUBLICNODE, DRPC] } });
        expect(callsOf(ev).some((c) => c.provider === TENDERLY && c.error?.includes("not a uint256 word"))).toBe(true);

        for (const target of [DRPC, undefined]) {
            const two = setup({ scenario: "4737427", override: emptyDen(target) }).p;
            const market = await two.fetchMarketDefinition("4737427");
            await expect(two.fetchResolutionEvidence(market)).rejects.toThrow(/CTF payout reads: \d\/2 providers answered/);
        }
    }, 20_000);

    it("does no chain reads for markets outside the profile", async () => {
        const { p, requests } = setup({ scenario: "559651" });
        const [, negRisk] = (await p.discoverMarkets(null, 5)).markets;
        const ev = await p.fetchResolutionEvidence(negRisk!);
        expect(ev).toMatchObject({ status: "unsupported" });
        expect(ev.detail).toMatch(/^neg-risk/);
        expect(requests.filter((u) => !u.startsWith("https://gamma-api"))).toHaveLength(0);
    });
});

describe("polymarket verifyFinalResolution", () => {
    it("re-checks profile, identity, chain, vector shape, providers and condition binding", async () => {
        const { p } = setup({ scenario: "2758339" });
        const market = await p.fetchMarketDefinition("2758339");
        const ev = await p.fetchResolutionEvidence(market);
        const chain = ev.chain!;
        const yes = setup({ scenario: "3409541" }).p;
        const otherEv = await yes.fetchResolutionEvidence(await yes.fetchMarketDefinition("3409541"));
        const reason = (e: ResolutionEvidence, m = market, profile = PROFILE, provider = p) => {
            const r = provider.verifyFinalResolution(m, e, profile);
            return r.ok ? "ok" : r.reason;
        };

        expect(reason(ev)).toBe("ok");
        expect(reason(ev, market, "ctf-uma-binary-v1")).toMatch(/unsupported profile/);
        expect(reason(ev, market, PROFILE, setup({ allowlist: [ALLOWLIST[1]!] }).p)).toMatch(/^unknown-resolver/);
        expect(reason(ev, { ...market, protocol: { ...market.protocol, conditionId: otherEv.reads?.conditionId as string } })).toMatch(/^condition-mismatch/);
        expect(reason(otherEv)).toMatch(/different condition/);
        expect(reason({ ...ev, status: "unresolved" })).toMatch(/status is unresolved/);
        expect(reason({ ...ev, vector: { numerators: [2n, 0n], denominator: 2n } })).toMatch(/vector/);
        expect(reason({ ...ev, vector: { numerators: [1n, 0n, 0n], denominator: 1n } })).toMatch(/vector/);
        expect(reason({ ...ev, chain: { ...chain, chainId: 1 } })).toMatch(/chain 137/);
        expect(reason({ ...ev, chain: { ...chain, blockHash: "" } })).toMatch(/block number\/hash/);
        expect(reason({ ...ev, chain: { ...chain, providers: [PUBLICNODE, PUBLICNODE] } })).toMatch(/1 providers < 2/);
    });
});
