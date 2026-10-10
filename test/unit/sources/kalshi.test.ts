import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../../../src/core/encoding.js";
import { KALSHI_PROFILE, createKalshiProvider } from "../../../src/server/sources/kalshi/index.js";
import type { EligibilityPolicy, ResolutionEvidence, SourceMarket } from "../../../src/server/sources/types.js";

const k = JSON.parse(readFileSync(new URL("../../fixtures/kalshi/kalshi.json", import.meta.url), "utf8"));
const API = "https://api.elections.kalshi.com/trade-api/v2";
const T = k.tickers as { open: string; yes: string; no: string; scalar: string };
const NOW = new Date("2026-10-09T12:00:00Z");
const POLICY: EligibilityPolicy = { profiles: [KALSHI_PROFILE], tags: [], minHorizonSeconds: 3600, maxHorizonSeconds: 365 * 86400 };
const WIDE = { maxHorizonSeconds: 1e10 };

interface SetupOpts {
    apiUrl?: string;
    page?: unknown;
    markets?: Record<string, unknown>;
    reads?: (ticker: string, n: number) => unknown;
}

const marketWith = (ticker: string, fields: Record<string, unknown>) => ({ market: { ...k.markets[ticker].market, ...fields } });

function setup(opts: SetupOpts = {}) {
    const requests: string[] = [];
    const counts = new Map<string, number>();
    const fake = async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        requests.push(url);
        const path = url.startsWith(API) ? new URL(url).pathname.slice(new URL(API).pathname.length) : "";
        let body: unknown;
        if (path === "/markets") body = new URL(url).searchParams.has("tickers") ? k.batch.response : (opts.page ?? k.marketsPage.response);
        else if (path.startsWith("/markets/")) {
            const t = path.slice("/markets/".length);
            const n = (counts.get(t) ?? 0) + 1;
            counts.set(t, n);
            const read = opts.reads?.(t, n);
            body = read !== undefined ? read : opts.markets && t in opts.markets ? opts.markets[t] : k.markets[t];
        } else if (path.startsWith("/events/")) body = k.events[path.slice("/events/".length)];
        else if (path.startsWith("/series/")) body = k.series[path.slice("/series/".length)];
        return body ? Response.json(body) : new Response("not found", { status: 404 });
    };
    return { p: createKalshiProvider({ apiUrl: opts.apiUrl, fetch: fake as typeof fetch }), requests };
}

const definition = (ticker: string, opts: SetupOpts = {}) => setup(opts).p.fetchMarketDefinition(ticker);
const marketReads = (requests: string[], ticker: string) => requests.filter((u) => u === `${API}/markets/${ticker}`).length;

describe("kalshi normalization", () => {
    it("pages open non-combo markets closing in the window, ranks by 24h volume and reads each event and series once", async () => {
        const { p, requests } = setup();
        const nowS = Date.now() / 1000;
        const page = await p.discoverMarkets(null, 5000);
        const q = new URL(requests[0]!).searchParams;
        expect([q.get("status"), q.get("mve_filter"), q.get("limit"), q.get("cursor")]).toEqual(["open", "exclude", "1000", null]);
        const [min, max] = [Number(q.get("min_close_ts")), Number(q.get("max_close_ts"))];
        expect(Math.abs(min - (nowS + 3600))).toBeLessThan(5);
        expect(max - min).toBe(90 * 86400 - 3600);
        expect(page.markets).toHaveLength(20);
        expect(page.markets.slice(0, 3).map((m) => m.sourceId)).toEqual(["KXUNSEC-27JAN-SKAA", "KXUNSEC-27JAN-RGRYN", "KXUNSEC-27JAN-RGRO"]);
        const volume = new Map(k.marketsPage.response.markets.map((m: { ticker: string; volume_24h_fp: string }) => [m.ticker, Number(m.volume_24h_fp)]));
        const ranked = page.markets.map((m) => volume.get(m.sourceId) as number);
        expect(ranked).toEqual([...ranked].sort((a, b) => b - a));
        expect(page.next).toBe(k.marketsPage.response.cursor);
        const lookups = () => requests.filter((u) => u.includes("/events/") || u.includes("/series/")).sort();
        expect(lookups()).toEqual([
            ...["KXNFLWEEKHIGHSCORE-26W16", "KXUNSEC-27JAN"].map((e) => `${API}/events/${e}`),
            ...["KXNFLWEEKHIGHSCORE", "KXUNSEC"].map((s) => `${API}/series/${s}`),
        ]);

        await p.discoverMarkets(page.next, 5);
        expect(new URL(requests.at(-1)!).searchParams.get("cursor")).toBe(page.next);
        expect(lookups()).toHaveLength(4);
    });

    it("normalizes discovery and definition identically; versionHash ignores prices and fetchedAt", async () => {
        const top = "KXUNSEC-27JAN-SKAA";
        const listed = (await setup().p.discoverMarkets(null, 5)).markets.find((m) => m.sourceId === top)!;
        expect((await definition(top)).versionHash).toBe(listed.versionHash);
        expect(listed).toMatchObject({ question: "Who will be the next Secretary-General of UN? (Sigrid Kaag)", tags: ["politics", "international", "kxunsec"] });
        const def = await definition(T.open);
        expect(def).toMatchObject({
            provider: "kalshi",
            sourceId: T.open,
            slug: "kxnewpope-70-ppar",
            url: "https://kalshi.com/markets/kxnewpope",
            question: "Who will the next Pope be? (Pietro Parolin)",
            description: "If Pietro Parolin becomes the first person elected Pope before Jan 1, 2070, then the market resolves to Yes.",
            outcomes: ["Yes", "No"],
            endDate: "2070-01-01T15:00:00.000Z",
            tags: ["elections", "international-elections", "kxnewpope"],
            active: true,
            closed: false,
            archived: false,
            sourceStatus: "active",
            referencePrices: [
                { outcome: "Yes", price: "0.0490" },
                { outcome: "No", price: "0.9510" },
            ],
            image: null,
            event: { title: "Who will the next Pope be?", slug: "kxnewpope-70" },
            gameStartTime: null,
            protocol: { version: "api-v2", chainId: 0, negRisk: false, resolver: "kalshi", conditionId: T.open, questionId: "KXNEWPOPE-70", settlementContract: API },
        });
        expect(def.resolutionSource).toMatch(/^The New York Times https:\/\/www\.nytimes\.com\/; /);
        expect(def.versionHash).toMatch(/^[0-9a-f]{64}$/);

        const repriced = await definition(T.open, { markets: { [T.open]: marketWith(T.open, { yes_bid_dollars: "0.5000", yes_ask_dollars: "0.5000", volume_24h_fp: "12.50" }) } });
        expect(repriced.referencePrices?.[0]?.price).toBe("0.5000");
        expect(repriced.volume24h).toBe(12.5);
        expect(repriced.versionHash).toBe(def.versionHash);
        const reworded = await definition(T.open, { markets: { [T.open]: marketWith(T.open, { rules_secondary: "Edited." }) } });
        expect(reworded.description).toMatch(/\n\nEdited\.$/);
        expect(reworded.versionHash).not.toBe(def.versionHash);
        const unpriced = await definition(T.open, { markets: { [T.open]: marketWith(T.open, { yes_ask_dollars: "0.0000", last_price_dollars: "0.0000" }) } });
        expect(unpriced.referencePrices).toBeNull();
    });

    it("skips malformed, combo and scalar entries, bounds strings and refuses bad tickers without a request", async () => {
        const good = k.marketsPage.response.markets[0];
        const hostile = {
            cursor: "",
            markets: [
                "not an object",
                { ...good, ticker: "KXUNSEC-27JAN-X", event_ticker: "../x" },
                { ...good, ticker: "KXUNSEC-27JAN-N", event_ticker: "KXNOPE-1" },
                { ...good, ticker: undefined },
                { ...good, ticker: "kx/../x" },
                { ...good, ticker: "KXUNSEC-27JAN-S", market_type: "scalar" },
                { ...good, ticker: "KXUNSEC-27JAN-M", mve_collection_ticker: "KXMVE-R" },
                { ...good, ticker: "KXUNSEC-27JAN-L", title: "q".repeat(600), yes_sub_title: 7, rules_primary: "d".repeat(30_000), rules_secondary: "", close_time: "soon" },
            ],
        };
        const { p, requests } = setup({ page: hostile });
        const page = await p.discoverMarkets(null, 5);
        expect(page.markets.map((m) => m.sourceId)).toEqual(["KXUNSEC-27JAN-L"]);
        expect(page.next).toBeNull();
        const [m] = page.markets;
        expect([m!.question.length, m!.description.length, m!.endDate]).toEqual([400, 10_000, null]);
        await expect(p.fetchMarketDefinition("../events")).rejects.toThrow(/invalid Kalshi ticker/);
        await expect(p.discoverMarkets(null, 5, { tag: "../x" })).rejects.toThrow(/invalid Kalshi category/);
        expect(requests.filter((u) => !u.includes("/series/")).sort()).toEqual([`${API}/events/KXNOPE-1`, `${API}/events/KXUNSEC-27JAN`, requests[0]]);
    });

    it("narrows discovery to a series category and keeps the cursor when a page has none", async () => {
        const { p } = setup();
        const politics = await p.discoverMarkets(null, 5, { tag: "Politics" });
        expect(politics.markets).toHaveLength(15);
        expect(new Set(politics.markets.map((m) => m.protocol.questionId))).toEqual(new Set(["KXUNSEC-27JAN"]));
        expect((await p.discoverMarkets(null, 5, { tag: "sports" })).markets.map((m) => m.protocol.questionId)).toEqual(Array(5).fill("KXNFLWEEKHIGHSCORE-26W16"));
        expect((await p.discoverMarkets(null, 5, { tag: "football" })).markets).toHaveLength(5);
        const elections = await p.discoverMarkets(null, 5, { tag: "elections" });
        expect(elections).toEqual({ markets: [], next: k.marketsPage.response.cursor });
    });
});

describe("kalshi eligibility", () => {
    it("returns machine-readable codes", async () => {
        const { p } = setup();
        const open = await p.fetchMarketDefinition(T.open);
        const code = (m: SourceMarket, policy: Partial<EligibilityPolicy> = WIDE, provider = p) => {
            const e = provider.evaluateEligibility(m, { ...POLICY, ...policy }, NOW);
            return e.eligible ? "eligible" : e.code;
        };
        const tweak = (protocol: Partial<SourceMarket["protocol"]>, rest: Partial<SourceMarket> = {}) => ({ ...open, ...rest, protocol: { ...open.protocol, ...protocol } });

        expect(code(open)).toBe("eligible");
        expect(code(open, {})).toBe("horizon");
        expect(code(tweak({}, { endDate: null }))).toBe("horizon");
        expect(code(open, { ...WIDE, profiles: [] })).toBe("profile-disabled");
        expect(code(await p.fetchMarketDefinition(T.yes))).toBe("closed");
        expect(code(tweak({}, { active: false, sourceStatus: "inactive" }))).toBe("closed");
        expect(code({ ...open, referencePrices: [{ outcome: "Yes", price: "0.9850" }, { outcome: "No", price: "0.0150" }] })).toBe("decided");
        expect(code(open, { ...WIDE, tags: ["sports"] })).toBe("tag-filter");
        expect(code(open, { ...WIDE, tags: ["sports", "ELECTIONS"] })).toBe("eligible");
        expect(code(tweak({}, { outcomes: ["Yes", "No", "Maybe"] }))).toBe("not-binary");
        expect(code(tweak({}, { outcomes: ["No", "Yes"] }))).toBe("not-binary");
        expect(code(tweak({ conditionId: T.yes }))).toBe("condition-mismatch");
        expect(code(tweak({ chainId: 137 }))).toBe("unsupported-version");
        expect(code(open, WIDE, setup({ apiUrl: "https://demo-api.kalshi.co/trade-api/v2" }).p)).toBe("unsupported-version");
    });
});

describe("kalshi resolution evidence", () => {
    it.each([
        [T.yes, [1n, 0n], "(Yes)"],
        [T.no, [0n, 1n], "(No)"],
    ])("reads final %s twice and requires agreement", async (ticker, numerators, label) => {
        const { p, requests } = setup();
        const market = await p.fetchMarketDefinition(ticker);
        const before = marketReads(requests, ticker);
        const ev = await p.fetchResolutionEvidence(market);
        expect(marketReads(requests, ticker) - before).toBe(2);
        expect(ev).toMatchObject({ status: "final", vector: { numerators, denominator: 1n }, reads: { ticker, providers: ["kalshi#1", "kalshi#2"] } });
        expect(ev.detail).toContain(label);
        expect(ev.chain).toBeUndefined();
        expect(p.verifyFinalResolution(market, ev, KALSHI_PROFILE)).toEqual({ ok: true });
    });

    it("maps Kalshi's lifecycle to non-final statuses and a scalar settlement to unsupported", async () => {
        const { p } = setup();
        expect((await p.fetchResolutionEvidence(await p.fetchMarketDefinition(T.open))).status).toBe("too-early");
        const scalar = await p.fetchResolutionEvidence(await p.fetchMarketDefinition(T.scalar));
        expect(scalar).toMatchObject({ status: "unsupported", reads: { market: { result: "scalar", settlement_value_dollars: "0.3300" } } });
        expect(scalar.vector).toBeUndefined();

        const yes = await p.fetchMarketDefinition(T.yes);
        const as = async (fields: Record<string, unknown>) => (await setup({ markets: { [T.yes]: marketWith(T.yes, fields) } }).p.fetchResolutionEvidence(yes)).status;
        expect(await as({ status: "closed", result: "" })).toBe("unresolved");
        expect(await as({ status: "determined" })).toBe("proposed");
        expect(await as({ status: "amended" })).toBe("proposed");
        expect(await as({ status: "disputed" })).toBe("disputed");
        expect(await as({ status: "active", result: "" })).toBe("too-early");
        expect(await as({ result: "" })).toBe("inconsistent");
        expect(await as({ settlement_value_dollars: "0.0000" })).toBe("inconsistent");
        expect(await as({ ticker: T.no })).toBe("inconsistent");
    });

    it("reports two disagreeing reads as inconsistent and never settles on a failed read", async () => {
        const market = await definition(T.yes);
        const torn = setup({ reads: (t, n) => (n === 2 ? marketWith(t, { status: "determined" }) : undefined) }).p;
        const ev = await torn.fetchResolutionEvidence(market);
        expect(ev.status).toBe("inconsistent");
        expect(ev.detail).toContain("finalized/yes vs determined/yes");
        expect(ev.vector).toBeUndefined();

        const down = setup({ reads: (_t, n) => (n === 2 ? null : undefined) }).p;
        await expect(down.fetchResolutionEvidence(market)).rejects.toThrow(/HTTP 404/);
    });

    it("does no reads for markets outside the profile", async () => {
        const market = await definition(T.yes);
        const { p, requests } = setup();
        const ev = await p.fetchResolutionEvidence({ ...market, protocol: { ...market.protocol, conditionId: T.no } });
        expect(ev).toMatchObject({ status: "unsupported" });
        expect(ev.detail).toMatch(/^condition-mismatch/);
        expect(requests).toHaveLength(0);
    });
});

describe("kalshi evidence record and verifyFinalResolution", () => {
    it("commits only settlement facts, identical across independent readers", async () => {
        const read = async () => {
            const { p } = setup();
            const market = await p.fetchMarketDefinition(T.yes);
            return { p, market, ev: await p.fetchResolutionEvidence(market) };
        };
        const a = await read();
        await new Promise((r) => setTimeout(r, 5));
        const b = await read();
        expect(a.ev.observedAt).not.toBe(b.ev.observedAt);
        const doc = a.p.evidenceRecord(a.market, a.ev);
        expect(doc).toEqual({
            profile: KALSHI_PROFILE,
            sourceId: T.yes,
            eventTicker: "KXESOCCERGAME-26OCT090639ADRIMIA",
            status: "finalized",
            result: "yes",
            settlementValue: "1.0000",
            settledAt: "2026-10-09T10:54:33.647361Z",
            closeTime: "2026-10-09T10:50:32Z",
            payout: { numerators: ["1", "0"], denominator: "1" },
        });
        expect(canonicalJson(b.p.evidenceRecord(b.market, b.ev))).toBe(canonicalJson(doc));
        const open = await a.p.fetchMarketDefinition(T.open);
        expect(() => a.p.evidenceRecord(open, { ...a.ev, status: "too-early" })).toThrow(/not a final resolution/);
    });

    it("re-checks profile, identity, status, market binding, vector shape and read count", async () => {
        const { p } = setup();
        const market = await p.fetchMarketDefinition(T.yes);
        const ev = await p.fetchResolutionEvidence(market);
        const noEv = await p.fetchResolutionEvidence(await p.fetchMarketDefinition(T.no));
        const reason = (e: ResolutionEvidence, m = market, profile = KALSHI_PROFILE) => {
            const r = p.verifyFinalResolution(m, e, profile);
            return r.ok ? "ok" : r.reason;
        };
        expect(reason(ev)).toBe("ok");
        expect(reason(ev, market, "polymarket-ctf-v1-binary")).toMatch(/unsupported profile/);
        expect(reason(ev, { ...market, outcomes: ["No", "Yes"] })).toMatch(/^not-binary/);
        expect(reason(noEv)).toMatch(/different market/);
        expect(reason({ ...ev, status: "unresolved" })).toMatch(/status is unresolved/);
        expect(reason({ ...ev, vector: noEv.vector })).toMatch(/vector is not \[1,0\]\/1/);
        expect(reason({ ...ev, vector: { numerators: [1n, 1n], denominator: 2n } })).toMatch(/vector/);
        expect(reason({ ...ev, reads: { ...ev.reads, providers: ["kalshi#1", "kalshi#1"] } })).toMatch(/1 reads < 2/);
    });
});

describe("kalshi early-resolution screen", () => {
    it("asks for every ticker in one batch and reports the finalized ones", async () => {
        const { p, requests } = setup();
        const markets = await Promise.all([T.open, T.yes, T.no, T.scalar].map((t) => p.fetchMarketDefinition(t)));
        const before = requests.length;
        expect((await p.screenResolved(markets)).sort()).toEqual([T.yes, T.no, T.scalar].sort());
        const batch = requests.slice(before);
        expect(batch).toHaveLength(1);
        expect(new URL(batch[0]!).searchParams.get("tickers")).toBe([T.open, T.yes, T.no, T.scalar].join(","));

        expect(await p.screenResolved([{ ...markets[1]!, protocol: { ...markets[1]!.protocol, version: "v1" } }])).toEqual([]);
        expect(requests).toHaveLength(before + 1);
    });
});
