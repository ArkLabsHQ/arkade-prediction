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
const labels = (urls: string[]) => urls.map((u, i) => `${new URL(u).host}#${i + 1}`);

interface SetupOpts {
    scenario?: string;
    scenarios?: string[];
    rpcUrls?: string[];
    override?: Override;
    markets?: Record<string, unknown>;
    keyset?: unknown;
    allowlist?: string[];
    creators?: string[];
    negRiskOracles?: string[];
    /** Synthetic exchanges, for reads the live captures in rpc.json do not cover. */
    exchanges?: Exchange[];
}

function setup(opts: SetupOpts = {}) {
    const requests: string[] = [];
    const posts: { url: string; body: unknown }[] = [];
    const scenarios = opts.scenarios ?? (opts.scenario ? [opts.scenario] : []);
    const exchanges: Exchange[] = [...rpc.chainId, ...scenarios.flatMap((s) => rpc.scenarios[s].exchanges as Exchange[]), ...(opts.exchanges ?? [])];
    const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        requests.push(url);
        if (url.startsWith("https://gamma-api.polymarket.com/")) {
            const { pathname } = new URL(url);
            const id = pathname.slice("/markets/".length);
            const body = pathname === "/markets/keyset" ? (opts.keyset ?? gamma.keyset.response) : (opts.markets?.[id] ?? gamma.markets[id]?.response);
            return body ? Response.json(body) : new Response("not found", { status: 404 });
        }
        const body = JSON.parse(String(init?.body));
        posts.push({ url, body });
        // Fixtures are keyed by provider host, so keyed URLs replay them too; `finalized` screen reads reuse the recorded value.
        const answer = (req: { id: unknown; method: string; params: unknown[] }) => {
            const screen = req.method === "eth_call" && req.params[1] === "finalized";
            const key = (params: unknown[]) => JSON.stringify(screen ? params[0] : params).toLowerCase();
            const hit = exchanges.find((e) => new URL(e.rpcUrl).host === new URL(url).host && e.method === req.method && key(e.params) === key(req.params));
            return hit && { jsonrpc: "2.0", id: req.id, result: opts.override ? opts.override(url, req.method, req.params, hit.result) : hit.result };
        };
        if (Array.isArray(body)) return Response.json(body.map((r) => answer(r) ?? { jsonrpc: "2.0", id: r.id, error: { code: -32000, message: "no fixture" } }));
        const hit = answer(body);
        return hit ? Response.json(hit) : new Response(`no fixture for ${body.method}`, { status: 400 });
    };
    const p = createPolymarketProvider({
        rpcUrls: opts.rpcUrls ?? (opts.scenario ? rpc.scenarios[opts.scenario].providers : [PUBLICNODE, DRPC]),
        resolverAllowlist: opts.allowlist ?? ALLOWLIST,
        ...(opts.creators ? { creatorAllowlist: opts.creators } : {}),
        ...(opts.negRiskOracles ? { negRiskOracleAllowlist: opts.negRiskOracles } : {}),
        fetch: fake as typeof fetch,
    });
    return { p, requests, posts };
}

const definition = (id: string, opts: SetupOpts = {}) => setup(opts).p.fetchMarketDefinition(id);

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

    it("keeps images only from Polymarket's bucket, reads the event, and leaves them out of versionHash", async () => {
        const raw = gamma.keyset.response.markets[0];
        const ok = "https://polymarket-upload.s3.us-east-2.amazonaws.com/x.png";
        const page = (image: string) => setup({ keyset: { markets: [{ ...raw, image, events: [{ title: "Big event", slug: "big-event" }] }] } }).p.discoverMarkets(null, 5);
        const [good] = (await page(ok)).markets;
        expect(good).toMatchObject({ image: ok, event: { title: "Big event", slug: "big-event" } });
        expect((await page("https://evil.example/pixel.png")).markets[0]!.image).toBeNull();
        expect((await page(ok.replace("https:", "http:"))).markets[0]!.image).toBeNull();
        expect((await page("https://evil.example/pixel.png")).markets[0]!.versionHash).toBe(good!.versionHash);
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
        const adapter = "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296";
        expect(deriveConditionId(adapter, negRisk.protocol.questionId)).toBe(negRisk.protocol.conditionId);
        const withAdapter = setup({ allowlist: [...ALLOWLIST, adapter] }).p;
        const wide = { minHorizonSeconds: 0, maxHorizonSeconds: 1e10 };
        expect(code((await withAdapter.discoverMarkets(null, 5)).markets[1]!, wide, withAdapter)).toBe("eligible");
        const raw = gamma.keyset.response.markets[1];
        const other = setup({ allowlist: [...ALLOWLIST, adapter], keyset: { markets: [{ ...raw, negRiskOther: true }] } }).p;
        expect(code((await other.discoverMarkets(null, 5)).markets[0]!, wide, other)).toBe("neg-risk");
        expect((await withAdapter.discoverMarkets(null, 5)).markets[0]!.versionHash).toBe(open.versionHash);
        expect(code(await p.fetchMarketDefinition("5379000"))).toBe("unknown-resolver");
        expect(code(open, {}, setup({ allowlist: [ALLOWLIST[0]!] }).p)).toBe("unknown-resolver");
        expect(code(await p.fetchMarketDefinition("2758339"))).toBe("closed");
        expect(code(open, { profiles: [] })).toBe("profile-disabled");
        expect(code({ ...open, gameStartTime: new Date(NOW.getTime() - 60_000).toISOString() })).toBe("started");
        expect(code({ ...open, gameStartTime: new Date(NOW.getTime() + 3_600_000).toISOString() })).toBe("eligible");
        expect(code({ ...open, referencePrices: [{ outcome: "a", price: "0.985" }, { outcome: "b", price: "0.015" }] })).toBe("decided");
        const kicked = setup({ keyset: { markets: [{ ...gamma.keyset.response.markets[0], gameStartTime: "2026-10-09 00:15:00+00" }] } }).p;
        expect((await kicked.discoverMarkets(null, 5)).markets[0]!.gameStartTime).toBe("2026-10-09T00:15:00.000Z");
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
        expect(ev.chain).toEqual({ chainId: 137, blockNumber, blockHash, providers: labels(providers) });
        const calls = callsOf(ev);
        expect(calls).toHaveLength(providers.length * 6);
        expect(calls.every((c) => labels(providers).includes(c.provider) && c.method && c.params && c.result !== undefined && !c.error)).toBe(true);
        expect(calls.filter((c) => c.method === "eth_call").every((c) => c.params[1] === `0x${BigInt(blockNumber).toString(16)}`)).toBe(true);
        expect(p.verifyFinalResolution(market, ev, PROFILE)).toEqual({ ok: true });
    });

    it("treats denominator 0 as unresolved and surfaces Gamma proposed/disputed", async () => {
        const { p } = setup({ scenario: "559651" });
        const market = await p.fetchMarketDefinition("559651");
        const ev = await p.fetchResolutionEvidence(market);
        expect(ev).toMatchObject({ status: "unresolved", chain: { blockNumber: "95126347", providers: labels([PUBLICNODE, DRPC]) } });
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
        const [publicnode, drpc, tenderly] = labels([PUBLICNODE, DRPC, TENDERLY]);
        expect(ev).toMatchObject({ status: "final", chain: { providers: [publicnode, drpc] } });
        expect(callsOf(ev).some((c) => c.provider === tenderly && c.error?.includes("not a uint256 word"))).toBe(true);

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

describe("polymarket early-resolution screen", () => {
    const IDS = ["559651", "4737427", "2758339"];
    const load = (p: ReturnType<typeof setup>["p"]) => Promise.all(IDS.map((id) => p.fetchMarketDefinition(id)));

    it("sends one finalized payoutDenominator batch per provider and needs a quorum of resolved reports", async () => {
        const { p, posts } = setup({ scenarios: IDS });
        const markets = await load(p);
        const [open, fifty, no] = markets.map((m) => m.protocol.conditionId);
        expect((await p.screenResolved(markets)).sort()).toEqual([fifty, no].sort());
        expect(posts.map((x) => x.url)).toEqual([PUBLICNODE, DRPC]);
        for (const { body } of posts) {
            const batch = body as { method: string; params: [{ to: string; data: string }, string] }[];
            expect(batch.map((r) => [r.method, r.params[0].to, r.params[1]])).toEqual(IDS.map(() => ["eth_call", CTF_ADDRESS, "finalized"]));
            expect(batch.map((r) => r.params[0].data)).toEqual([open, fifty, no].map((c) => `${DEN}${c!.slice(2)}`));
        }

        const lagging: Override = (u, _m, params, r) => (u === DRPC && dataOf(params).includes(no!.slice(2)) ? word(0n) : r);
        const one = setup({ scenarios: IDS, override: lagging }).p;
        expect(await one.screenResolved(await load(one))).toEqual([fifty]);
    });

    it("counts a malformed or partial batch answer as a failed provider, never as unresolved, and does not retry", async () => {
        const { p, posts } = setup({ scenarios: IDS, override: (u, _m, _params, r) => (u === DRPC ? "0x" : r) });
        await expect(p.screenResolved(await load(p))).rejects.toThrow(/1\/2 providers answered; polygon\.drpc\.org#2: .*not a uint256 word/);
        expect(posts).toHaveLength(2);
        const partial = setup({ scenarios: ["559651", "4737427"] });
        await expect(partial.p.screenResolved(await load(partial.p))).rejects.toThrow(/0\/2 providers answered/);
    });

    it("does no reads for markets outside the profile", async () => {
        const { p, posts } = setup({ scenarios: IDS });
        const [, negRisk] = (await p.discoverMarkets(null, 5)).markets;
        expect(await p.screenResolved([negRisk!])).toEqual([]);
        expect(posts).toHaveLength(0);
    });
});

describe("polymarket provider labels", () => {
    const KEYED = ["https://polygon-bor-rpc.publicnode.com/v2/SECRET-ONE", "https://polygon.drpc.org/ogrpc?dkey=SECRET-TWO", "https://rpc.example/SECRET-THREE"];
    const show = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

    it("never puts provider URLs, which may embed API keys, into evidence, details or errors", async () => {
        const { p } = setup({ scenario: "4737427", rpcUrls: KEYED });
        const market = await p.fetchMarketDefinition("4737427");
        const ev = await p.fetchResolutionEvidence(market);
        expect(ev).toMatchObject({ status: "final", chain: { providers: ["polygon-bor-rpc.publicnode.com#1", "polygon.drpc.org#2"] } });
        expect(callsOf(ev).filter((c) => c.error).map((c) => [c.provider, c.error])).toContainEqual(["rpc.example#3", "HTTP 400 from rpc.example#3"]);

        const forked: Override = (u, m, params, r) => (u === KEYED[1] && m === "eth_getBlockByNumber" && params[0] !== "finalized" ? { ...(r as object), hash: `0x${"ab".repeat(32)}` } : r);
        const inconsistent = await setup({ scenario: "4737427", rpcUrls: KEYED, override: forked }).p.fetchResolutionEvidence(market);
        expect(inconsistent.detail).toContain(`polygon.drpc.org#2=0x${"ab".repeat(32)}`);
        const down = setup({ scenario: "4737427", rpcUrls: [KEYED[0]!, KEYED[2]!] }).p;
        const failed = await down.fetchResolutionEvidence(market).catch((e: Error) => e.message);
        expect(failed).toMatch(/1\/2 providers answered; rpc\.example#2 eth_chainId: HTTP 400 from rpc\.example#2/);
        const screen = await down.screenResolved([market]).catch((e: Error) => e.message);
        expect(screen).toMatch(/1\/2 providers answered; rpc\.example#2: batch item 0/);
        expect(show([ev, inconsistent, failed, screen])).not.toMatch(/SECRET/);
    });

    it("refuses URLs that fetch would echo back in its errors", () => {
        for (const bad of ["polygon.drpc.org/SECRET", "https://user:SECRET@polygon.drpc.org/"]) {
            let message = "";
            try {
                createPolymarketProvider({ rpcUrls: [PUBLICNODE, bad], resolverAllowlist: ALLOWLIST });
            } catch (e) {
                message = (e as Error).message;
            }
            expect(message).toMatch(/^RPC URL #2 /);
            expect(message).not.toMatch(/SECRET/);
        }
    });
});

describe("crypto Up/Down markets on the CTF path", () => {
    const UPDOWN_RESOLVER = "0x58e1745bedda7312c4cddb72618923da1b90efde";
    const questionID = `0x${"0f".repeat(32)}`;
    const raw = (start: Date) => ({
        ...gamma.keyset.response.markets[0], id: "5425619", slug: "btc-updown-4h-1791532800", resolvedBy: undefined, negRisk: false, negRiskOther: false,
        outcomes: '["Up", "Down"]', questionID, conditionId: deriveConditionId(UPDOWN_RESOLVER, questionID), gameStartTime: undefined,
        eventStartTime: start.toISOString(), endDate: new Date(start.getTime() + 4 * 3600_000).toISOString(),
    });
    const code = (p: ReturnType<typeof setup>["p"], m: SourceMarket) => {
        const e = p.evaluateEligibility(m, { ...POLICY, minHorizonSeconds: 0 }, NOW);
        return e.eligible ? "eligible" : e.code;
    };

    it("finds the oracle from the conditionId when gamma omits resolvedBy, and takes the window start as the start", async () => {
        const upcoming = raw(new Date(NOW.getTime() + 3600_000));
        const { p } = setup({ allowlist: [...ALLOWLIST, UPDOWN_RESOLVER], markets: { "": [upcoming] } });
        const [m] = await p.fetchMarketsBySlug!(["btc-updown-4h-1791532800"]);
        expect(m!.gameStartTime).toBe(upcoming.eventStartTime);
        expect(code(p, m!)).toBe("eligible");
        expect(code(setup().p, m!)).toBe("unknown-resolver");
        const live = (await setup({ allowlist: [...ALLOWLIST, UPDOWN_RESOLVER], markets: { "": [raw(new Date(NOW.getTime() - 60_000))] } }).p.fetchMarketsBySlug!(["x"]))[0]!;
        expect(code(p, live)).toBe("started");
    });

    it("cannot be vetted: the resolver has no creator to read, so it is refused", async () => {
        const { p } = setup({ allowlist: [...ALLOWLIST, UPDOWN_RESOLVER], markets: { "": [raw(new Date(NOW.getTime() + 3600_000))] } });
        const [m] = await p.fetchMarketsBySlug!(["btc-updown-4h-1791532800"]);
        const vet = await p.vetSource!(m!);
        expect(vet).toMatchObject({ ok: false });
        expect((vet as { reason: string }).reason).toMatch(/question creator: 0\/2 providers answered/);
    });
});

describe("source vetting", () => {
    const SEL_QUESTIONS = "0x95addb90";
    const SEL_GET_ORACLE = "0xdafaf94a";
    const CREATOR = "0xac9930b2ae455a671b62de86876a7e8587825294";
    const NEG_RISK_ORACLE = "0x71523d0f655b41e805cec45b17163f528b59b820";
    const ADAPTER = "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296";
    const uma = gamma.markets["559651"].response;
    const marketIdOf = (questionId: string) => `0x${(BigInt(questionId) & ~0xffn).toString(16).padStart(64, "0")}`;

    /** A `questions()` return: 12 head words, ancillaryData's offset at word 11 and the creator at word 10. */
    const questionData = (creator: string, offset = 384n) => {
        const w = Array.from({ length: 13 }, () => "0".repeat(64));
        w[10] = creator.slice(2).padStart(64, "0");
        w[11] = offset.toString(16).padStart(64, "0");
        w[12] = (32n).toString(16).padStart(64, "0");
        return `0x${w.join("")}${"ab".repeat(32)}`;
    };
    const reads = (to: string, data: string, byProvider: Record<string, unknown>): Exchange[] =>
        Object.entries(byProvider).map(([rpcUrl, result]) => ({ rpcUrl, method: "eth_call", params: [{ to, data }, "finalized"], result }));
    const umaReads = (byProvider: Record<string, unknown>) =>
        reads(uma.resolvedBy, `${SEL_QUESTIONS}${uma.questionID.slice(2)}`, byProvider);
    const both = (result: unknown) => ({ [PUBLICNODE]: result, [DRPC]: result });
    const vetUma = async (byProvider: Record<string, unknown>, opts: SetupOpts = {}) => {
        const { p } = setup({ ...opts, exchanges: umaReads(byProvider) });
        return p.vetSource!(await p.fetchMarketDefinition("559651"));
    };

    it("passes a question an allowlisted Polymarket creator created", async () => {
        await expect(vetUma(both(questionData(CREATOR)))).resolves.toEqual({ ok: true });
        await expect(vetUma(both(questionData(CREATOR.toUpperCase().replace("0X", "0x"))))).resolves.toEqual({ ok: true });
    });

    it("refuses an unknown creator", async () => {
        const vet = await vetUma(both(questionData("0xdead00000000000000000000000000000000beef")));
        expect(vet).toMatchObject({ ok: false });
        expect((vet as { reason: string }).reason).toMatch(/question creator 0xdead.*not allowlisted/);
        await expect(vetUma(both(questionData(CREATOR)), { creators: ["0x91430cad2d3975766499717fa0d66a78d814e5c5"] })).resolves.toMatchObject({ ok: false });
    });

    it("refuses an uninitialized question and a return that is not QuestionData", async () => {
        for (const result of [
            questionData(`0x${"0".repeat(40)}`),
            questionData(CREATOR, 320n),
            `0x${"0".repeat(64)}`,
            "0x",
        ]) {
            await expect(vetUma(both(result))).resolves.toMatchObject({ ok: false });
        }
    });

    it("fails closed when the providers disagree or too few answer", async () => {
        const split = await vetUma({ [PUBLICNODE]: questionData(CREATOR), [DRPC]: questionData("0xdead00000000000000000000000000000000beef") });
        expect((split as { reason: string }).reason).toMatch(/question creator differs/);
        const alone = await vetUma({ [PUBLICNODE]: questionData(CREATOR) });
        expect((alone as { reason: string }).reason).toMatch(/question creator: 1\/2 providers answered/);
    });

    it("checks the neg-risk operator that prepared the market, not the resolver", async () => {
        const raw = gamma.keyset.response.markets[1];
        const data = `${SEL_GET_ORACLE}${marketIdOf(raw.questionID).slice(2)}`;
        const vet = async (oracle: string, opts: SetupOpts = {}) => {
            const { p } = setup({ ...opts, allowlist: [...ALLOWLIST, ADAPTER], keyset: { markets: [raw] }, exchanges: reads(ADAPTER, data, both(`0x${oracle.slice(2).padStart(64, "0")}`)) });
            const [m] = (await p.discoverMarkets(null, 5)).markets;
            return p.vetSource!(m!);
        };
        await expect(vet(NEG_RISK_ORACLE)).resolves.toEqual({ ok: true });
        const bad = await vet("0xdead00000000000000000000000000000000beef");
        expect((bad as { reason: string }).reason).toMatch(/neg-risk oracle 0xdead.*not allowlisted/);
        await expect(vet(`0x${"0".repeat(40)}`)).resolves.toMatchObject({ ok: false });
        await expect(vet(NEG_RISK_ORACLE, { negRiskOracles: ["0x661992aebf6becf7ba5abb66f6b0bf62aa7a2e93"] })).resolves.toMatchObject({ ok: false });
    });

    it("refuses an identity the eligibility check already rejects, without reading the chain", async () => {
        const { p, posts } = setup();
        const m = await p.fetchMarketDefinition("559651");
        const vet = await p.vetSource!({ ...m, protocol: { ...m.protocol, questionId: `0x${"0".repeat(64)}` } });
        expect(vet).toMatchObject({ ok: false, reason: expect.stringMatching(/^condition-mismatch/) });
        expect(posts).toHaveLength(0);
    });
});
