import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULT_ORACLES, OPINION_PROFILE, createOpinionProvider } from "../../../src/server/sources/opinion/index.js";
import type { EligibilityPolicy, SourceMarket } from "../../../src/server/sources/types.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../fixtures/opinion/${name}`, import.meta.url), "utf8"));
const api = fixture("api.json").responses as Record<string, { result: { data?: Record<string, unknown> } }>;
const rpc = fixture("rpc.json");

const API = "https://openapi.opinion.trade/openapi";
const [PUBLICNODE, BLOCKRAZOR] = rpc.providers as [string, string];
const LIST = "/market?status=activated&marketType=2&sortBy=5&limit=5&page=1";
const NOW = new Date("2026-10-10T07:00:00Z");
const POLICY: EligibilityPolicy = { profiles: [OPINION_PROFILE], tags: [], minHorizonSeconds: 3600, maxHorizonSeconds: 365 * 86400 };
const NUM = "0x0504c814";

interface Exchange {
    rpcUrl: string;
    method: string;
    params: unknown[];
    result: unknown;
}
type Override = (host: string, method: string, params: unknown[], result: unknown) => unknown;

const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const dataOf = (params: unknown[]) => (params[0] as { data?: string }).data ?? "";
const withData = (path: string, patch: Record<string, unknown>) => ({ ...api[path], result: { data: { ...api[path]!.result.data, ...patch } } });

interface SetupOpts {
    scenario?: string;
    rpcUrls?: string[];
    override?: Override;
    down?: string[];
    apiOverride?: Record<string, unknown>;
    allowlist?: string[];
    minIntervalMs?: number;
}

function setup(opts: SetupOpts = {}) {
    const apiCalls: { path: string; at: number }[] = [];
    const exchanges: Exchange[] = opts.scenario ? rpc.scenarios[opts.scenario].exchanges : [];
    const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.startsWith(API)) {
            const path = url.slice(API.length);
            apiCalls.push({ path, at: Date.now() });
            const body = opts.apiOverride?.[path] ?? api[path];
            if (typeof body === "number") return new Response("limited", { status: body });
            return body ? Response.json(body) : Response.json({ errmsg: "Topic ID does not exist", errno: 10200, result: null });
        }
        const host = new URL(url).host;
        if (opts.down?.includes(host)) return new Response("down", { status: 400 });
        const body = JSON.parse(String(init?.body));
        // Recorded per scenario and keyed by host, so provider order does not matter.
        const answer = (req: { id: unknown; method: string; params: unknown[] }) => {
            const hit = exchanges.find((e) => new URL(e.rpcUrl).host === host && e.method === req.method && JSON.stringify(e.params) === JSON.stringify(req.params));
            if (!hit) return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "no fixture" } };
            return { jsonrpc: "2.0", id: req.id, result: opts.override ? opts.override(host, req.method, req.params, hit.result) : hit.result };
        };
        return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    };
    const p = createOpinionProvider({
        rpcUrls: opts.rpcUrls ?? [PUBLICNODE, BLOCKRAZOR],
        resolverAllowlist: opts.allowlist ?? DEFAULT_ORACLES,
        fetch: fake as typeof fetch,
        minIntervalMs: opts.minIntervalMs ?? 0,
    });
    return { p, apiCalls };
}

const definition = (id: string, opts: SetupOpts = {}) => setup(opts).p.fetchMarketDefinition(id);
const evidence = async (id: string, opts: SetupOpts & { atBlock?: bigint } = {}) => {
    const { p } = setup(opts);
    return { p, ev: await p.fetchResolutionEvidence(await p.fetchMarketDefinition(id), opts.atBlock === undefined ? {} : { atBlock: opts.atBlock }) };
};

describe("opinion normalization", () => {
    it("expands categorical markets into binary children ordered by 24h volume", async () => {
        const { p, apiCalls } = setup();
        const page = await p.discoverMarkets(null, 5);
        expect(apiCalls[0]!.path).toBe(LIST);
        expect(page.next).toBe("2");
        expect(page.markets).toHaveLength(40);
        expect(page.markets.slice(0, 3).map((m) => m.sourceId)).toEqual(["337-5350", "360-6146", "380-6816"]);
        const volumes = page.markets.map((m) => m.volume24h ?? 0);
        expect(volumes).toEqual([...volumes].sort((a, b) => b - a));
        expect(page.markets[0]).toMatchObject({
            provider: "opinion",
            url: "https://app.opinion.trade/detail?topicId=337&type=multi",
            question: "Which companies will be acquired before 2027? (Anthropic)",
            outcomes: ["Yes", "No"],
            endDate: "2026-12-31T00:00:00.000Z",
            tags: ["business"],
            event: { title: "Which companies will be acquired before 2027?", slug: "which-companies-will-be-acquired-before-2027" },
            volume24h: 6446285.1585,
            referencePrices: null,
            protocol: {
                version: "ctf", chainId: 56, negRisk: false, resolver: "0x12521af17f36d533de35347ce4e959cbbfd07034",
                conditionId: "0xd263d287c6cee560701ddfa7ac0ca2ef3eabdd618310ce05556e0acdbfbdcfd7",
                questionId: "0x2b41ec4ef3eba3873dbcf419fe3fe98c1a689e45b578f39b04f330b78710b05b",
                settlementContract: "0xad1a38cec043e70e83a3ec30443db285ed10d774",
            },
        });
        expect(page.markets[0]!.description).toMatch(/^This market will resolve to “Yes”/);
    });

    it("caps the page size at 20 and ends paging at the total", async () => {
        const list = api[LIST] as unknown as { result: { list: unknown[]; total: number } };
        const { p, apiCalls } = setup({ apiOverride: { "/market?status=activated&marketType=2&sortBy=5&limit=20&page=3": { errno: 0, errmsg: "", result: { list: [], total: list.result.total } } } });
        expect(await p.discoverMarkets("3", 500)).toEqual({ markets: [], next: null });
        expect(apiCalls[0]!.path).toBe("/market?status=activated&marketType=2&sortBy=5&limit=20&page=3");
    });

    it("keeps binary labels and names sports sides", async () => {
        expect(await definition("8453")).toMatchObject({ question: "Will Reza Pahlavi lead Iran in 2026?", outcomes: ["Yes", "No"], volume24h: 8686.887999999999, event: null });
        expect(await definition("45914")).toMatchObject({ outcomes: ["Turma do Pagode", "Galorys"], active: false, closed: true, sourceStatus: "resolved:finalized" });
    });

    it("re-derives a child only through the parent that lists it", async () => {
        const child = await definition("337-5346");
        expect(child.question).toBe("Which companies will be acquired before 2027? (Pizza Hut)");
        await expect(definition("360-5346")).rejects.toThrow(/not a child of 360/);
        await expect(definition("337-5346", { apiOverride: { "/market/5346": withData("/market/5346", { conditionId: "11".repeat(32) }) } })).rejects.toThrow(/not a child/);
        await expect(definition("12345678901234")).rejects.toThrow(/invalid Opinion market id/);
        await expect(definition("999")).rejects.toThrow(/Topic ID does not exist/);
    });

    it("keeps versionHash off volume and stable across reads", async () => {
        const a = await definition("8453");
        const b = await definition("8453", { apiOverride: { "/market/8453": withData("/market/8453", { volume24h: "1.5" }) } });
        expect(b.volume24h).toBe(1.5);
        expect(b.versionHash).toBe(a.versionHash);
    });
});

describe("opinion rate limiting", () => {
    it("spaces API requests, concurrent ones included", async () => {
        const { p, apiCalls } = setup({ minIntervalMs: 40 });
        await Promise.all([p.fetchMarketDefinition("8453"), p.fetchMarketDefinition("45914"), p.fetchMarketDefinition("45810")]);
        expect(apiCalls.map((c, i) => c.at - apiCalls[0]!.at >= i * 40 - 5)).toEqual([true, true, true]);
    });

    it("backs off a 429 and retries", async () => {
        let hits = 0;
        const { p } = setup({
            apiOverride: {
                get "/market/8453"() {
                    return hits++ === 0 ? 429 : api["/market/8453"];
                },
            },
        });
        const t = Date.now();
        expect((await p.fetchMarketDefinition("8453")).sourceId).toBe("8453");
        expect(hits).toBe(2);
        expect(Date.now() - t).toBeGreaterThanOrEqual(950);
    });
});

describe("opinion eligibility", () => {
    const tamper = (m: SourceMarket, patch: Partial<SourceMarket["protocol"]>, rest: Partial<SourceMarket> = {}) => ({ ...m, ...rest, protocol: { ...m.protocol, ...patch } });

    it("admits an allowlisted live binary and names each refusal", async () => {
        const { p } = setup();
        const open = await p.fetchMarketDefinition("8453");
        const code = (m: SourceMarket, policy = POLICY) => {
            const v = p.evaluateEligibility(m, policy, NOW);
            return v.eligible ? "eligible" : v.code;
        };
        expect(code(open)).toBe("eligible");
        expect(code(open, { ...POLICY, profiles: [] })).toBe("profile-disabled");
        expect(code(await p.fetchMarketDefinition("45914"))).toBe("closed");
        expect(code(open, { ...POLICY, maxHorizonSeconds: 30 * 86400 })).toBe("horizon");
        expect(code(open, { ...POLICY, tags: ["sports"] })).toBe("tag-filter");
        expect(code(tamper(open, {}, { outcomes: ["Yes", "Yes"] }))).toBe("not-binary");
        expect(code(tamper(open, { conditionId: "" }))).toBe("no-condition");
        expect(code(tamper(open, { chainId: 1 }))).toBe("unsupported-version");
        expect(code(tamper(open, { questionId: word(1n) }))).toBe("condition-mismatch");
        const narrow = setup({ allowlist: ["0x2e5466c11531fbd91b44cb196e3e0debfec8ee31"] }).p;
        const unlisted = await narrow.fetchMarketDefinition("8453");
        expect(unlisted.protocol.resolver).toBeNull();
        expect(narrow.evaluateEligibility(unlisted, POLICY, NOW)).toMatchObject({ eligible: false, code: "unknown-resolver" });
    });
});

describe("opinion resolution", () => {
    it("reads Yes, No and an open market from the chain", async () => {
        const yes = await evidence("45810", { scenario: "yes" });
        expect(yes.ev).toMatchObject({ status: "final", vector: { numerators: [1n, 0n], denominator: 1n }, chain: { chainId: 56, providers: ["bsc-rpc.publicnode.com#1", "bsc.blockrazor.xyz#2"] } });
        const no = await evidence("45914", { scenario: "no" });
        expect(no.ev.status).toBe("final");
        expect(no.ev.vector).toEqual({ numerators: [0n, 1n], denominator: 1n });
        expect(no.ev.detail).toContain("(Galorys)");
        expect(no.p.verifyFinalResolution(await no.p.fetchMarketDefinition("45914"), no.ev, OPINION_PROFILE)).toEqual({ ok: true });
        const open = await evidence("8453", { scenario: "open" });
        expect(open.ev.status).toBe("unresolved");
        expect(open.ev.vector).toBeUndefined();
        expect((await evidence("337-5346", { scenario: "child-resolved" })).ev.vector).toEqual({ numerators: [1n, 0n], denominator: 1n });
    });

    it("maps [1,1]/2 to INVALID", async () => {
        const half = (_h: string, method: string, params: unknown[], result: unknown) =>
            method !== "eth_call" ? result : dataOf(params).startsWith(NUM) ? word(1n) : word(2n);
        const { ev } = await evidence("45914", { scenario: "no", override: half });
        expect(ev).toMatchObject({ status: "final", vector: { numerators: [1n, 1n], denominator: 2n } });
        expect(ev.detail).toContain("50-50");
    });

    it("reports a proposed or disputed result while the CTF payout is still empty", async () => {
        const phase = (p: string) => ({ "/market/8453": withData("/market/8453", { resolution: { phase: p } }) });
        expect((await evidence("8453", { scenario: "open", apiOverride: phase("proposed") })).ev.status).toBe("proposed");
        expect((await evidence("8453", { scenario: "open", apiOverride: phase("disputed") })).ev.status).toBe("disputed");
    });

    it("is inconsistent when the API and the chain disagree", async () => {
        const resolved = { "/market/8453": withData("/market/8453", { status: 4, statusEnum: "Resolved" }) };
        const early = await evidence("8453", { scenario: "open", apiOverride: resolved });
        expect(early.ev.status).toBe("inconsistent");
        expect(early.ev.detail).toMatch(/opinion reports resolved but payoutDenominator is 0/);
        const raw = api["/market/45914"]!.result.data!;
        const flipped = { "/market/45914": withData("/market/45914", { resultTokenId: raw.yesTokenId }) };
        expect((await evidence("45914", { scenario: "no", apiOverride: flipped })).ev.status).toBe("inconsistent");
    });

    it("fails closed when providers disagree or drop out", async () => {
        const lie = (host: string, method: string, params: unknown[], result: unknown) =>
            host === "bsc.blockrazor.xyz" && method === "eth_call" && dataOf(params).startsWith(NUM) && dataOf(params).endsWith(word(0n).slice(2)) ? word(1n) : result;
        expect((await evidence("45914", { scenario: "no", override: lie })).ev.status).toBe("inconsistent");
        const fork = (host: string, method: string, params: unknown[], result: unknown) =>
            host === "bsc.blockrazor.xyz" && method === "eth_getBlockByNumber" && params[0] !== "finalized" ? { ...(result as object), hash: word(7n) } : result;
        expect((await evidence("45914", { scenario: "no", override: fork })).ev.status).toBe("inconsistent");
        await expect(evidence("45914", { scenario: "no", down: ["bsc.blockrazor.xyz"] })).rejects.toThrow(/1\/2 providers answered/);
        const { ev } = await evidence("45914", { scenario: "no" });
        expect(setup().p.verifyFinalResolution(await definition("45914"), { ...ev, chain: { ...ev.chain!, providers: ["one#1"] } }, OPINION_PROFILE)).toMatchObject({ ok: false });
        expect(setup().p.verifyFinalResolution(await definition("45810"), ev, OPINION_PROFILE)).toEqual({ ok: false, reason: "evidence was read for a different condition" });
    });

    it("signs the same evidence whichever providers read the pinned block, in any order", async () => {
        const block = BigInt(rpc.scenarios.no.block);
        const a = await evidence("45914", { scenario: "no", atBlock: block });
        const b = await evidence("45914", { scenario: "no", atBlock: block, rpcUrls: [BLOCKRAZOR, PUBLICNODE] });
        const m = await definition("45914");
        expect(a.p.evidenceRecord(m, a.ev)).toEqual(b.p.evidenceRecord(m, b.ev));
        expect(a.p.evidenceRecord(m, a.ev)).toMatchObject({
            profile: OPINION_PROFILE, chainId: 56, ctf: "0xad1a38cec043e70e83a3ec30443db285ed10d774", sourceId: "45914",
            resolver: "0x2e5466c11531fbd91b44cb196e3e0debfec8ee31", block: { number: String(block) }, payout: { numerators: ["0", "1"], denominator: "1" },
        });
        expect(() => a.p.evidenceRecord(m, { ...a.ev, status: "unresolved" })).toThrow(/not a final resolution/);
    });

    it("screens resolved conditions with one batch per provider", async () => {
        const { p } = setup({ scenario: "screen" });
        const markets = await Promise.all(["45914", "8453", "45810"].map((id) => definition(id)));
        expect(await p.screenResolved(markets)).toEqual([markets[0]!.protocol.conditionId, markets[2]!.protocol.conditionId]);
    });
});

describe("opinion vetSource", () => {
    it("passes a condition prepared on chain with two slots", async () => {
        const { p } = setup({ scenario: "no" });
        expect(await p.vetSource!(await definition("45914"))).toEqual({ ok: true });
    });

    it("fails closed on a missing condition, disagreement, an outage or an unlisted oracle", async () => {
        const m = await definition("45914");
        const slots = (n: bigint, only?: string) => (host: string, _m: string, _p: unknown[], result: unknown) => (!only || host === only ? word(n) : result);
        expect(await setup({ scenario: "no", override: slots(0n) }).p.vetSource!(m)).toMatchObject({ ok: false, reason: expect.stringMatching(/0 outcome slots/) });
        expect(await setup({ scenario: "no", override: slots(3n, "bsc.blockrazor.xyz") }).p.vetSource!(m)).toMatchObject({ ok: false, reason: expect.stringMatching(/differs/) });
        expect(await setup({ scenario: "no", down: ["bsc.blockrazor.xyz"] }).p.vetSource!(m)).toMatchObject({ ok: false, reason: expect.stringMatching(/1\/2 providers/) });
        const narrow = setup({ scenario: "no", allowlist: ["0x12521af17f36d533de35347ce4e959cbbfd07034"] });
        expect(await narrow.p.vetSource!(await narrow.p.fetchMarketDefinition("45914"))).toMatchObject({ ok: false, reason: expect.stringMatching(/^unknown-resolver/) });
    });
});
