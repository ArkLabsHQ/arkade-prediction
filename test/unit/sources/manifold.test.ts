import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MANIFOLD_PROFILE, MIN_TRADERS, createManifoldProvider } from "../../../src/server/sources/manifold/index.js";
import type { EligibilityPolicy, SourceMarket } from "../../../src/server/sources/types.js";

const api = JSON.parse(readFileSync(new URL("../../fixtures/manifold/api.json", import.meta.url), "utf8"));
const API = "https://api.manifold.markets/v0";
const NOW = new Date("2026-10-09T12:00:00Z");
const POLICY: EligibilityPolicy = { profiles: [MANIFOLD_PROFILE], tags: [], minHorizonSeconds: 3600, maxHorizonSeconds: 365 * 86400 };

type Rec = Record<string, unknown>;
interface SetupOpts {
    search?: unknown;
    markets?: Record<string, Rec>;
    /** Answers the n-th read (1-based) of a market differently. */
    nth?: (id: string, n: number, body: Rec) => Rec;
}

function setup(opts: SetupOpts = {}) {
    const requests: string[] = [];
    const reads = new Map<string, number>();
    const fake = async (input: string | URL | Request): Promise<Response> => {
        const url = new URL(String(input));
        requests.push(url.href);
        if (url.pathname === "/v0/search-markets") {
            return Response.json(url.searchParams.get("filter") === "resolved" ? api.resolved.response : (opts.search ?? api.search.response));
        }
        const id = url.pathname.slice("/v0/market/".length);
        const body = opts.markets?.[id] ?? api.markets[id];
        if (!body) return new Response("not found", { status: 404 });
        const n = (reads.get(id) ?? 0) + 1;
        reads.set(id, n);
        return Response.json(opts.nth ? opts.nth(id, n, body) : body);
    };
    return { p: createManifoldProvider({ apiUrl: `${API}/`, fetch: fake as typeof fetch }), requests };
}

const market = (id: string, opts: SetupOpts = {}) => setup(opts).p.fetchMarketDefinition(id);

describe("manifold normalization", () => {
    it("discovers open binaries busiest first, re-reads busy hits in full and pages by offset", async () => {
        const { p, requests } = setup();
        const page = await p.discoverMarkets(null, 5, { tag: "politics-default" });
        const q = new URL(requests[0]!).searchParams;
        expect(Object.fromEntries(q)).toEqual({ filter: "open", contractType: "BINARY", sort: "24-hour-vol", limit: "5", offset: "0", topicSlug: "politics-default" });
        expect(page.markets.map((m) => m.sourceId)).toEqual(["CL56c9sqQp", "EU2P5AdyuE", "uISNlAqC2E"]);
        expect(page.next).toBe("5");
        expect((await p.discoverMarkets("995", 5)).next).toBeNull();
        await expect(p.discoverMarkets("1000", 5)).rejects.toThrow(/cursor/);
        await expect(p.discoverMarkets(null, 5, { tag: "../x" })).rejects.toThrow(/topic/);

        const m = page.markets[0]!;
        expect(m).toMatchObject({
            provider: "manifold",
            slug: "will-another-millennium-prize-probl",
            url: "https://manifold.markets/HumanClanker/will-another-millennium-prize-probl",
            question: "Will ANOTHER millennium prize problem be solved in 2026?",
            outcomes: ["Yes", "No"],
            endDate: "2027-01-01T07:59:00.000Z",
            tags: ["ai", "mathematics", "millenium-prize-problems", "play-money"],
            referencePrices: [{ outcome: "Yes", price: "0.3802" }, { outcome: "No", price: "0.6198" }],
            active: true,
            closed: false,
            sourceStatus: null,
            protocol: {
                version: "api-v0", chainId: 0, negRisk: false, resolver: "manifold:wYKRtPHh40dVdWvBdWYFyht8Yta2",
                conditionId: "CL56c9sqQp", questionId: "will-another-millennium-prize-probl", settlementContract: API,
            },
        });
        expect(m.description).toMatch(/^Resolution criteria/);
        expect(m.versionHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("keeps versionHash independent of prices and fetch time", async () => {
        const raw = api.markets.CL56c9sqQp;
        const a = await market("CL56c9sqQp");
        const b = await market("CL56c9sqQp", { markets: { CL56c9sqQp: { ...raw, probability: 0.5, uniqueBettorCount: 1, volume24Hours: 321.5 } } });
        expect([a.volume24h, b.volume24h]).toEqual([raw.volume24Hours, 321.5]);
        const c = await market("CL56c9sqQp", { markets: { CL56c9sqQp: { ...raw, question: "edited?" } } });
        expect(b.versionHash).toBe(a.versionHash);
        expect(c.versionHash).not.toBe(a.versionHash);
    });

    it("bounds strings, rejects foreign urls and skips malformed entries", async () => {
        const raw = api.markets.CL56c9sqQp;
        const m = await market("CL56c9sqQp", {
            markets: { CL56c9sqQp: { ...raw, question: "q".repeat(9000), textDescription: "d".repeat(50_000), url: "https://evil.example/x", groupSlugs: ["A", 7, "a"] } },
        });
        expect([m.question.length, m.description.length, m.url]).toEqual([500, 20_000, ""]);
        expect(m.tags).toEqual(["a", "play-money"]);
        await expect(market("bad/id")).rejects.toThrow(/invalid/);

        const search = [{ id: "../../x", uniqueBettorCount: 99 }, null, { ...api.search.response[0] }, { id: "EU2P5AdyuE", uniqueBettorCount: 99 }];
        const page = await setup({ search, markets: { EU2P5AdyuE: { ...api.markets.EU2P5AdyuE, id: 5 } } }).p.discoverMarkets(null, 10);
        expect(page.markets.map((x) => x.sourceId)).toEqual(["CL56c9sqQp"]);
        expect(page.next).toBeNull();
    });
});

describe("manifold eligibility", () => {
    const verdict = async (patch: Rec, policy = POLICY) => {
        const { p } = setup({ markets: { CL56c9sqQp: { ...api.markets.CL56c9sqQp, ...patch } } });
        const r = p.evaluateEligibility(await p.fetchMarketDefinition("CL56c9sqQp"), policy, NOW);
        return r.eligible ? "eligible" : r.code;
    };

    it("returns machine-readable codes", async () => {
        expect(await verdict({})).toBe("eligible");
        expect(await verdict({}, { ...POLICY, profiles: [] })).toBe("profile-disabled");
        expect(await verdict({ outcomeType: "MULTIPLE_CHOICE" })).toBe("not-binary");
        expect(await verdict({ mechanism: "dpm-2" })).toBe("not-binary");
        expect(await verdict({ creatorId: "x" })).toBe("identity");
        expect(await verdict({ isResolved: true, resolution: "YES" })).toBe("closed");
        expect(await verdict({ closeTime: Date.parse("2026-10-01T00:00:00Z") })).toBe("closed");
        expect(await verdict({ closeTime: Date.parse("2028-01-01T00:00:00Z") })).toBe("horizon");
        expect(await verdict({ probability: 0.985 })).toBe("decided");
        expect(await verdict({ probability: 0.02 })).toBe("decided");
        expect(await verdict({ uniqueBettorCount: MIN_TRADERS - 1 })).toBe("thin");
        expect(await verdict({}, { ...POLICY, tags: ["sports"] })).toBe("tag-filter");
        expect(await verdict({}, { ...POLICY, tags: ["Mathematics"] })).toBe("eligible");
    });

    it("refuses a market whose API differs from the provider's", async () => {
        const m = await market("CL56c9sqQp");
        const other = createManifoldProvider({ apiUrl: "https://example.com/v0", fetch: (() => {}) as unknown as typeof fetch });
        expect(other.evaluateEligibility(m, POLICY, NOW)).toMatchObject({ eligible: false, code: "unsupported-version" });
    });

    it("treats a snapshot it did not build (no trader count) as thin", async () => {
        const { p } = setup();
        const copy = JSON.parse(JSON.stringify(await p.fetchMarketDefinition("CL56c9sqQp"))) as SourceMarket;
        expect(p.evaluateEligibility(copy, POLICY, NOW)).toMatchObject({ eligible: false, code: "thin" });
    });
});

describe("manifold resolution evidence", () => {
    const evidenceFor = async (id: string, opts: SetupOpts = {}) => {
        const { p, requests } = setup(opts);
        const m = await p.fetchMarketDefinition(id);
        const before = requests.length;
        const ev = await p.fetchResolutionEvidence(m);
        return { p, m, ev, reads: requests.length - before };
    };

    it.each([
        ["nRSlhy5c2L", "NO", [0n, 1n], 1n],
        ["h9N8d85uCn", "YES", [1n, 0n], 1n],
        ["5SEnEAddg5", "CANCEL", [1n, 1n], 2n],
        ["ZQ68UAANNS", "MKT", [1n, 1n], 2n],
    ])("maps %s (%s) to its vector after two agreeing reads", async (id, resolution, numerators, denominator) => {
        const { p, m, ev, reads } = await evidenceFor(id);
        expect(reads).toBe(2);
        expect(ev).toMatchObject({ status: "final", vector: { numerators, denominator } });
        expect(ev.chain).toBeUndefined();
        expect(ev.reads).toMatchObject({ sourceId: id, resolution, providers: ["manifold#1", "manifold#2"] });
        if (resolution === "MKT") expect(ev.detail).toMatch(/probabilistic/);
        expect(p.verifyFinalResolution(m, ev, MANIFOLD_PROFILE)).toEqual({ ok: true });
    });

    it("reports open markets as unresolved and unknown resolutions as unsupported", async () => {
        expect((await evidenceFor("CL56c9sqQp")).ev.status).toBe("unresolved");
        const odd = { ...api.markets.nRSlhy5c2L, resolution: "MAYBE" };
        expect((await evidenceFor("nRSlhy5c2L", { markets: { nRSlhy5c2L: odd } })).ev.status).toBe("unsupported");
    });

    it("reports disagreeing reads or a changed creator as inconsistent", async () => {
        const flip = await evidenceFor("nRSlhy5c2L", { nth: (_id, n, body) => (n === 3 ? { ...body, resolution: "YES" } : body) });
        expect(flip.ev).toMatchObject({ status: "inconsistent", detail: expect.stringMatching(/disagree/) });
        expect(flip.ev.vector).toBeUndefined();
        const creator = await evidenceFor("nRSlhy5c2L", { nth: (_id, n, body) => (n > 1 ? { ...body, creatorId: "AAAAAAAAAAAAAAAAAAAAAAAAAAAA" } : body) });
        expect(creator.ev.status).toBe("inconsistent");
    });

    it("never turns a failed read into unresolved", async () => {
        const { p } = setup();
        const m = await p.fetchMarketDefinition("nRSlhy5c2L");
        const broken = createManifoldProvider({ apiUrl: API, fetch: (async () => new Response("gone", { status: 404 })) as typeof fetch });
        await expect(broken.fetchResolutionEvidence(m)).rejects.toThrow(/404/);
    });

    it("produces a deterministic evidence record", async () => {
        const a = await evidenceFor("nRSlhy5c2L");
        const b = await evidenceFor("nRSlhy5c2L");
        expect(a.ev.observedAt <= b.ev.observedAt).toBe(true);
        expect(a.p.evidenceRecord(a.m, a.ev)).toEqual({
            profile: MANIFOLD_PROFILE, sourceId: "nRSlhy5c2L", resolution: "NO", resolutionTime: 1791540192716, creatorId: "85nJB0gHwPMXmUtBO72YrwlNDI22",
        });
        expect(JSON.stringify(b.p.evidenceRecord(b.m, b.ev))).toBe(JSON.stringify(a.p.evidenceRecord(a.m, a.ev)));
        expect(() => a.p.evidenceRecord(a.m, { ...a.ev, status: "unresolved" })).toThrow();
    });

    it("verifyFinalResolution re-checks profile, identity, vector and read count", async () => {
        const { p, m, ev } = await evidenceFor("nRSlhy5c2L");
        const check = (patch: Partial<typeof ev>, market: SourceMarket = m, profile = MANIFOLD_PROFILE) => p.verifyFinalResolution(market, { ...ev, ...patch }, profile).ok;
        expect(check({}, m, "polymarket-ctf-v1-binary")).toBe(false);
        expect(check({ status: "unresolved" })).toBe(false);
        expect(check({ vector: { numerators: [1n, 0n], denominator: 1n } })).toBe(false);
        expect(check({ vector: { numerators: [2n, 1n], denominator: 3n } })).toBe(false);
        expect(check({ chain: { chainId: 0, blockNumber: "1", blockHash: "0x", providers: [] } })).toBe(false);
        expect(check({ reads: { ...ev.reads, providers: ["manifold#1"] } })).toBe(false);
        expect(check({ reads: { ...ev.reads, sourceId: "h9N8d85uCn" } })).toBe(false);
        expect(check({}, { ...m, protocol: { ...m.protocol, resolver: "manifold:someoneElse123" } })).toBe(false);
        expect(check({}, { ...m, outcomes: ["No", "Yes"] })).toBe(false);
    });
});

describe("manifold early-resolution screen", () => {
    it("returns ids one resolved-page read reports resolved", async () => {
        const { p, requests } = setup();
        const ms = await Promise.all(["nRSlhy5c2L", "ZQ68UAANNS", "CL56c9sqQp", "5SEnEAddg5"].map((id) => p.fetchMarketDefinition(id)));
        const before = requests.length;
        expect((await p.screenResolved(ms)).sort()).toEqual(["ZQ68UAANNS", "nRSlhy5c2L"]);
        expect(requests.length - before).toBe(1);
        expect(Object.fromEntries(new URL(requests.at(-1)!).searchParams)).toMatchObject({ filter: "resolved", sort: "resolve-date", limit: "1000" });
    });

    it("does no reads for markets outside the profile", async () => {
        const { p, requests } = setup();
        const m = await p.fetchMarketDefinition("CL56c9sqQp");
        const before = requests.length;
        expect(await p.screenResolved([{ ...m, outcomes: [] }])).toEqual([]);
        expect(requests.length).toBe(before);
    });
});
