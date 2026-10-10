import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/core/encoding.js";
import { BASE_CHAIN_ID, LIMITLESS_CTF, LIMITLESS_PROFILE, createLimitlessProvider, evidenceRecord, htmlToText } from "../../../src/server/sources/limitless/index.js";
import type { EligibilityPolicy, ResolutionEvidence, SourceMarket } from "../../../src/server/sources/types.js";

const fx = JSON.parse(readFileSync(new URL("../../fixtures/limitless/limitless.json", import.meta.url), "utf8"));
const API = "https://api.limitless.exchange";
const RPCS: string[] = fx.rpcUrls;
const SAFE = "0x32e52896663de88a65c2d94917b006404415a89f";
const NOW = new Date(fx.scenarios.discovery.now);
const POLICY: EligibilityPolicy = { profiles: [LIMITLESS_PROFILE], tags: [], minHorizonSeconds: 3600, maxHorizonSeconds: 365 * 86400 };
const YES = "malaga-and-espanyol-both-to-score-1791106206210";
const OPEN = "hull-city-and-everton-have-3-or-more-total-goals-1791279007219";
const CHILD = "25-1779377186831";
const H2H = "carlos-alcaraz-vs-alex-de-minaur-1790492403971";
const DEN = "0xdd34de67";
const NUM = "0x0504c814";
const SLOTS = "0xd42dc0c2";

interface Exchange {
    rpcUrl: string;
    method: string;
    params: unknown[];
    result: unknown;
}
/** Returns the replayed result, a replacement, or an Error to answer with a JSON-RPC error. */
type Override = (host: string, method: string, params: unknown[], result: unknown) => unknown;

const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const dataOf = (params: unknown[]) => (params[0] as { data?: string })?.data ?? "";
const isRead = (params: unknown[], selector: string, index?: bigint) =>
    dataOf(params).startsWith(selector) && (index === undefined || BigInt(`0x${dataOf(params).slice(-64)}`) === index);
const payout = (n0: bigint, n1: bigint, den: bigint, only?: string): Override => (host, method, params, r) => {
    if (method !== "eth_call" || (only && host !== only)) return r;
    if (isRead(params, DEN)) return word(den);
    if (isRead(params, NUM, 0n)) return word(n0);
    if (isRead(params, NUM, 1n)) return word(n1);
    return r;
};

function setup(scenario: string, opts: { override?: Override; api?: Record<string, unknown>; rpcUrls?: string[]; allowlist?: string[] } = {}) {
    const s = fx.scenarios[scenario];
    const requests: string[] = [];
    const posts: { host: string; body: unknown }[] = [];
    const used = new Set<Exchange>();
    // Recorded reads replay in order per host, so a head that moved between two `finalized` reads moves here too.
    const replay = (host: string, method: string, params: unknown[]) => {
        const hits = (s.rpc as Exchange[]).filter((e) => new URL(e.rpcUrl).host === host && e.method === method && JSON.stringify(e.params) === JSON.stringify(params));
        const hit = hits.find((e) => !used.has(e)) ?? hits.at(-1);
        if (hit) used.add(hit);
        return hit;
    };
    const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        if (url.startsWith(API)) {
            const path = url.slice(API.length);
            requests.push(path);
            const body = opts.api?.[path] ?? s.api[path];
            return body ? Response.json(body) : new Response("not found", { status: 404 });
        }
        const host = new URL(url).host;
        const body = JSON.parse(String(init?.body));
        posts.push({ host, body });
        const answer = (req: { id: unknown; method: string; params: unknown[] }) => {
            const hit = replay(host, req.method, req.params);
            if (!hit) return { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: "no fixture" } };
            const result = opts.override ? opts.override(host, req.method, req.params, hit.result) : hit.result;
            return result instanceof Error ? { jsonrpc: "2.0", id: req.id, error: { code: -32000, message: result.message } } : { jsonrpc: "2.0", id: req.id, result };
        };
        if (Array.isArray(body)) return Response.json(body.map(answer));
        const out = answer(body);
        // A permanent HTTP error skips the client's retry backoff.
        return "error" in out ? new Response(JSON.stringify(out), { status: 400 }) : Response.json(out);
    };
    const p = createLimitlessProvider({ rpcUrls: opts.rpcUrls ?? RPCS, fetch: fake as typeof fetch, ...(opts.allowlist ? { resolverAllowlist: opts.allowlist } : {}) });
    return { p, requests, posts };
}

const definition = (scenario: string, slug: string, opts: Parameters<typeof setup>[1] = {}) => setup(scenario, opts).p.fetchMarketDefinition(slug);
const host = (i: number) => new URL(RPCS[i]!).host;
/** Eligibility needs no I/O. */
const offline = () => setup("headToHead").p;

describe("limitless normalization", () => {
    it("discovers a trending page, flattens groups and pages by number", async () => {
        const { p, requests, posts } = setup("discovery");
        const page = await p.discoverMarkets(null, 100);
        expect(requests).toEqual(["/markets/active?page=1&limit=25&sortBy=trending"]);
        expect(page.next).toBe("2");
        const raw = fx.scenarios.discovery.api[requests[0]!].data as { marketType: string; markets?: unknown[] }[];
        expect(page.markets).toHaveLength(raw.reduce((n, m) => n + (m.marketType === "group" ? (m.markets?.length ?? 0) : 1), 0));
        const codes: Record<string, number> = {};
        for (const m of page.markets) {
            const v = p.evaluateEligibility(m, POLICY, NOW);
            const k = v.eligible ? "eligible" : v.code;
            codes[k] = (codes[k] ?? 0) + 1;
        }
        expect(codes).toEqual({ eligible: 1, "neg-risk": 33, "not-binary": 4, "polymarket-mirror": 25 });
        // Only the one market nothing else excludes costs a chain lookup: an anchor head and two log windows.
        expect(posts.map((x) => (x.body as { method: string }).method)).toEqual(["eth_getBlockByNumber", "eth_getLogs", "eth_getLogs"]);
        await expect(p.discoverMarkets(null, 25, { tag: "sports" })).rejects.toThrow(/no tag filter/);
    });

    it("normalizes an open Yes/No market and reads its oracle from the ConditionPreparation log", async () => {
        const m = await definition("open", OPEN);
        expect(m).toMatchObject({
            provider: "limitless",
            sourceId: OPEN,
            url: `https://limitless.exchange/markets/${OPEN}`,
            question: "Hull City and Everton have 3 or more total goals?",
            outcomes: ["Yes", "No"],
            active: true,
            closed: false,
            archived: false,
            sourceStatus: "FUNDED",
            volume24h: null,
            event: null,
            protocol: {
                version: "clob",
                chainId: BASE_CHAIN_ID,
                negRisk: false,
                resolver: SAFE,
                conditionId: "0xf45f1e4b6fe34c10a7528ef7e3763c08b7526f30341e3ab8d474faa4e38730dc",
                questionId: "0xffab1e215e4988e07bfc3c122998fc0a72c232f2b448690859e4febde73826ea",
                settlementContract: LIMITLESS_CTF,
            },
        });
        expect(m.tags).toEqual(["football", "lumy", "props"]);
        expect(m.description).not.toMatch(/<\/?p>/);
        expect(m.referencePrices?.map((r) => r.outcome)).toEqual(["Yes", "No"]);
        expect(m.gameStartTime).toMatch(/^2026-10-1\dT/);
        expect(m.versionHash).toMatch(/^[0-9a-f]{64}$/);
        expect(offline().evaluateEligibility(m, POLICY, NOW)).toEqual({ eligible: true, profile: LIMITLESS_PROFILE });
    });

    it("normalizes discovery and definition identically", async () => {
        const listed = (await setup("discovery").p.discoverMarkets(null, 25)).markets.find((m) => m.sourceId === OPEN)!;
        const def = await definition("open", OPEN);
        expect(def.versionHash).toBe(listed.versionHash);
    });

    it("composes a group child's question from its group and links the group as its event", async () => {
        const m = await definition("groupChild", CHILD);
        expect(m.question).toBe("AST SpaceMobile BlueBird satellites in orbit above 25 in Q4 2026?");
        expect(m.event).toEqual({ title: "AST SpaceMobile BlueBird satellites in orbit above __ in Q4 2026?", slug: "ast-spacemobile-bluebird-satellites-in-orbit-above-in-q4-2026-1779377186826" });
        expect(m.protocol.resolver).toBe(SAFE);
        expect(offline().evaluateEligibility(m, POLICY, NOW)).toEqual({ eligible: true, profile: LIMITLESS_PROFILE });
    });

    it("excludes head-to-head markets without a chain lookup", async () => {
        const { p: provider, posts } = setup("headToHead");
        const m = await provider.fetchMarketDefinition(H2H);
        expect(m.outcomes).toEqual([]);
        expect(posts).toHaveLength(0);
        expect(provider.evaluateEligibility(m, POLICY, NOW)).toMatchObject({ eligible: false, code: "not-binary" });
        expect(await provider.fetchResolutionEvidence(m)).toMatchObject({ status: "unsupported" });
    });

    it("strips HTML rules to text", () => {
        expect(htmlToText("<p>Resolves &quot;YES&quot; if A &amp; B.</p><p><br></p><p>Else &#39;NO&#39;.</p>")).toBe("Resolves \"YES\" if A & B.\n\nElse 'NO'.");
    });

    it("rejects an invalid slug before any request", async () => {
        const { p: provider, requests } = setup("open");
        await expect(provider.fetchMarketDefinition("../admin")).rejects.toThrow(/invalid Limitless market slug/);
        expect(requests).toHaveLength(0);
    });
});


describe("limitless eligibility", () => {
    const edit = (m: SourceMarket, patch: Partial<SourceMarket>, protocol: Partial<SourceMarket["protocol"]> = {}): SourceMarket => ({ ...m, ...patch, protocol: { ...m.protocol, ...protocol } });

    it("returns one code per exclusion", async () => {
        const m = await definition("open", OPEN);
        const resolved = await definition("resolvedYes", YES);
        const code = (x: SourceMarket, policy = POLICY, now = NOW) => {
            const v = offline().evaluateEligibility(x, policy, now);
            return v.eligible ? "eligible" : v.code;
        };
        expect(code(m, { ...POLICY, profiles: ["polymarket-ctf-v1-binary"] })).toBe("profile-disabled");
        expect(code(edit(m, { tags: [...m.tags, "polymarket-mirror"] }))).toBe("polymarket-mirror");
        expect(code(edit(m, {}, { version: "amm" }))).toBe("unsupported-version");
        expect(code(edit(m, {}, { negRisk: true }))).toBe("neg-risk");
        expect(code(edit(m, { outcomes: ["Over", "Under"] }))).toBe("not-binary");
        expect(code(edit(m, {}, { resolver: "0x943b9b8b452edc4bf2ff869326a7a8db4c986d90" }))).toBe("unknown-resolver");
        expect(code(edit(m, {}, { questionId: `0x${"11".repeat(32)}` }))).toBe("condition-mismatch");
        expect(code(resolved)).toBe("closed");
        expect(code(m, POLICY, new Date(Date.parse(m.endDate!) - 1800_000))).toBe("horizon");
        expect(code(m, POLICY, new Date(Date.parse(m.gameStartTime!) + 1))).toBe("started");
        expect(code(edit(m, { referencePrices: [{ outcome: "Yes", price: "0.9850" }, { outcome: "No", price: "0.0150" }] }))).toBe("decided");
        expect(code(m, { ...POLICY, tags: ["politics"] })).toBe("tag-filter");
        expect(code(m)).toBe("eligible");
    });
});

describe("limitless resolution", () => {
    it("reads a YES payout at one finalized block across three providers", async () => {
        const m = await definition("resolvedYes", YES);
        const ev = await setup("resolvedYes").p.fetchResolutionEvidence(m);
        expect(ev).toMatchObject({ status: "final", vector: { numerators: [1n, 0n], denominator: 1n } });
        expect(ev.chain).toEqual({
            chainId: BASE_CHAIN_ID,
            blockNumber: "52412890",
            blockHash: "0xbbee284fb28d30fa7283fb3e2a7c0fb609731411381e80fecb6f5ed155d85fef",
            providers: RPCS.map((u, i) => `${new URL(u).host}#${i + 1}`),
        });
        expect(ev.detail).toMatch(/\(Yes\)/);
        expect(setup("resolvedYes").p.verifyFinalResolution(m, ev, LIMITLESS_PROFILE)).toEqual({ ok: true });
    });

    it("maps [0,1]/1 to NO and Limitless's [50,50]/100 to INVALID [1,1]/2", async () => {
        const m = await definition("resolvedYes", YES);
        const no = await setup("resolvedYes", { override: payout(0n, 1n, 1n) }).p.fetchResolutionEvidence(m);
        expect(no).toMatchObject({ status: "final", vector: { numerators: [0n, 1n], denominator: 1n } });
        const { p: provider } = setup("resolvedYes", { override: payout(50n, 50n, 100n) });
        const invalid = await provider.fetchResolutionEvidence(m);
        expect(invalid).toMatchObject({ status: "final", vector: { numerators: [1n, 1n], denominator: 2n } });
        expect(provider.verifyFinalResolution(m, invalid, LIMITLESS_PROFILE)).toEqual({ ok: true });
        expect(evidenceRecord(m, invalid)).toMatchObject({ payout: { numerators: ["1", "1"], denominator: "2" }, chainPayout: { numerators: ["50", "50"], denominator: "100" } });
    });

    it("refuses payouts that are not all-yes, all-no or 50-50", async () => {
        const m = await definition("resolvedYes", YES);
        const ev = await setup("resolvedYes", { override: payout(1n, 2n, 3n) }).p.fetchResolutionEvidence(m);
        expect(ev.status).toBe("unsupported");
        expect(ev.vector).toBeUndefined();
    });

    it("reports an open market unresolved", async () => {
        const m = await definition("open", OPEN);
        const ev = await setup("open").p.fetchResolutionEvidence(m);
        expect(ev).toMatchObject({ status: "unresolved" });
        expect(ev.detail).toMatch(/payoutDenominator is 0/);
    });

    it("follows the chain when the API already says RESOLVED", async () => {
        const raw = fx.scenarios.open.api[`/markets/${OPEN}`];
        const m = await definition("open", OPEN, { api: { [`/markets/${OPEN}`]: { ...raw, status: "RESOLVED", winningOutcomeIndex: 0 } } });
        const ev = await setup("open").p.fetchResolutionEvidence(m);
        expect(ev.status).toBe("inconsistent");
        expect(ev.vector).toBeUndefined();
    });

    it("fails closed when providers disagree, a block hash differs, or too few answer", async () => {
        const m = await definition("resolvedYes", YES);
        const split = await setup("resolvedYes", { override: payout(0n, 1n, 1n, host(1)) }).p.fetchResolutionEvidence(m);
        expect(split).toMatchObject({ status: "inconsistent" });
        expect(split.detail).toMatch(/differ across providers/);

        const fork: Override = (h, method, params, r) =>
            method === "eth_getBlockByNumber" && params[0] !== "finalized" && h === host(2) ? { ...(r as object), hash: `0x${"ab".repeat(32)}` } : r;
        expect(await setup("resolvedYes", { override: fork }).p.fetchResolutionEvidence(m)).toMatchObject({ status: "inconsistent" });

        const down: Override = (h, _m, _p, r) => (h === host(0) ? r : new Error("down"));
        await expect(setup("resolvedYes", { override: down }).p.fetchResolutionEvidence(m)).rejects.toThrow(/1\/2 providers answered/);
    });

    it("refuses an atBlock that is not finalized everywhere", async () => {
        const m = await definition("resolvedYes", YES);
        const ev = await setup("resolvedYes").p.fetchResolutionEvidence(m, { atBlock: 10n ** 12n });
        expect(ev).toMatchObject({ status: "inconsistent" });
    });

    it("signs the same evidence record whichever providers answered and when", async () => {
        const m = await definition("resolvedYes", YES);
        const a = await setup("resolvedYes").p.fetchResolutionEvidence(m);
        const b = await setup("resolvedYes", { rpcUrls: [...RPCS].reverse() }).p.fetchResolutionEvidence(m);
        expect(a.chain?.providers).not.toEqual(b.chain?.providers);
        expect(canonicalJson(evidenceRecord(m, a))).toBe(canonicalJson(evidenceRecord(m, b)));
        expect(evidenceRecord(m, a)).toEqual({
            profile: LIMITLESS_PROFILE, chainId: BASE_CHAIN_ID, ctf: LIMITLESS_CTF, sourceId: YES,
            conditionId: m.protocol.conditionId, questionId: m.protocol.questionId, resolver: SAFE,
            block: { number: "52412890", hash: "0xbbee284fb28d30fa7283fb3e2a7c0fb609731411381e80fecb6f5ed155d85fef" },
            payout: { numerators: ["1", "0"], denominator: "1" },
            chainPayout: { numerators: ["1", "0"], denominator: "1" },
        });
        expect(() => evidenceRecord(m, { status: "unresolved", detail: "", observedAt: "" })).toThrow();
    });

    it("verifyFinalResolution rejects tampered or foreign evidence", async () => {
        const m = await definition("resolvedYes", YES);
        const { p: provider } = setup("resolvedYes");
        const ev = await provider.fetchResolutionEvidence(m);
        const flipped: ResolutionEvidence = { ...ev, vector: { numerators: [0n, 1n], denominator: 1n } };
        expect(provider.verifyFinalResolution(m, flipped, LIMITLESS_PROFILE)).toMatchObject({ ok: false, reason: /chain payout/ });
        expect(provider.verifyFinalResolution(m, ev, "polymarket-ctf-v1-binary")).toMatchObject({ ok: false });
        expect(provider.verifyFinalResolution(m, { ...ev, chain: { ...ev.chain!, providers: [ev.chain!.providers[0]!] } }, LIMITLESS_PROFILE)).toMatchObject({ ok: false });
        expect(provider.verifyFinalResolution(m, { ...ev, reads: { ...ev.reads, conditionId: `0x${"00".repeat(32)}` } }, LIMITLESS_PROFILE)).toMatchObject({ ok: false });
    });
});

describe("limitless source vetting and screening", () => {
    it("vets a condition the allowlisted Safe prepared with two slots", async () => {
        const m = await definition("open", OPEN);
        expect(await setup("open").p.vetSource!(m)).toEqual({ ok: true });
    });

    it("fails the vet closed on a wrong slot count, disagreement, too few answers or an unlisted oracle", async () => {
        const m = await definition("open", OPEN);
        const slots = (n: bigint, only?: string): Override => (h, method, params, r) => (method === "eth_call" && isRead(params, SLOTS) && (!only || h === only) ? word(n) : r);
        expect(await setup("open", { override: slots(0n) }).p.vetSource!(m)).toMatchObject({ ok: false, reason: /0 outcome slots/ });
        expect(await setup("open", { override: slots(3n, host(2)) }).p.vetSource!(m)).toMatchObject({ ok: false, reason: /differs across providers/ });
        const down: Override = (h, _m, _p, r) => (h === host(0) ? r : new Error("down"));
        expect(await setup("open", { override: down }).p.vetSource!(m)).toMatchObject({ ok: false, reason: /1\/2 providers answered/ });
        expect(await setup("open", { allowlist: ["0x943b9b8b452edc4bf2ff869326a7a8db4c986d90"] }).p.vetSource!(m)).toMatchObject({ ok: false, reason: /unknown-resolver/ });
    });

    it("screens resolved conditions from one batch per provider", async () => {
        const yes = await definition("resolvedYes", YES);
        expect(await setup("resolvedYes").p.screenResolved([yes])).toEqual([yes.protocol.conditionId]);
        const open = await definition("open", OPEN);
        expect(await setup("open").p.screenResolved([open])).toEqual([]);
    });
});
