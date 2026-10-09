import { canonicalJson, sha256Hex } from "../../../core/encoding.js";
import { BINARY_VECTORS } from "../../../core/payout.js";
import type { Eligibility, EligibilityPolicy, MarketSourceProvider, ResolutionEvidence, ResolutionStatus, SourceMarket } from "../types.js";

const DISCOVERY_WINDOW_DAYS = 90;
export const KALSHI_PROFILE = "kalshi-api-v1-binary";
const DEFAULT_API_URL = "https://api.elections.kalshi.com/trade-api/v2";
const VERSION = "api-v2";
const RESOLVER = "kalshi";
const READS = ["kalshi#1", "kalshi#2"];
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 250;
const HEADERS = { accept: "application/json", "user-agent": "arkade-prediction/0.1" };

const TICKER = /^[A-Z0-9][A-Z0-9._-]{0,99}$/;
const DOLLARS = /^(0(\.\d{1,4})?|1(\.0{1,4})?)$/;
const OPEN_STATUSES = new Set(["initialized", "inactive", "active"]);

export interface KalshiProviderOptions {
    apiUrl?: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

type Rec = Record<string, unknown>;
type Problem = { code: string; reason: string };
/** The settlement fields of one GET /markets/{ticker} read. */
type Snapshot = Record<"ticker" | "event_ticker" | "market_type" | "status" | "result" | "settlement_value_dollars" | "settlement_ts" | "close_time", string>;

class HttpError extends Error {
    constructor(readonly status: number, url: string) {
        super(`HTTP ${status} from ${url}`);
    }
}

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const tickerOf = (v: unknown) => (typeof v === "string" && TICKER.test(v) ? v : null);
const slugOf = (v: unknown) => str(v, 64).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

function isoDate(v: unknown): string | null {
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Ten-thousandths of a dollar, from Kalshi's "0.0580" strings. */
function basisPoints(v: unknown): number | null {
    return typeof v === "string" && DOLLARS.test(v) ? Math.round(Number(v) * 10_000) : null;
}

function pricesOf(raw: Rec): SourceMarket["referencePrices"] {
    const bid = basisPoints(raw.yes_bid_dollars);
    const ask = basisPoints(raw.yes_ask_dollars);
    const yes = bid !== null && ask !== null && ask > 0 && bid <= ask ? Math.round((bid + ask) / 2) : basisPoints(raw.last_price_dollars) || null;
    if (yes === null) return null;
    const fmt = (n: number) => (n / 10_000).toFixed(4);
    return [{ outcome: "Yes", price: fmt(yes) }, { outcome: "No", price: fmt(10_000 - yes) }];
}

function sourcesOf(v: unknown): string {
    if (!Array.isArray(v)) return "";
    const named = v.slice(0, 20).map((s) => (isRec(s) ? [str(s.name, 100).trim(), str(s.url, 200).trim()].filter(Boolean).join(" ") : ""));
    return named.filter(Boolean).join("; ").slice(0, 1_000);
}

interface Series {
    ticker: string;
    tags: string[];
}

function seriesOf(raw: unknown): Series {
    const s = isRec(raw) ? raw.series : null;
    const ticker = isRec(s) ? tickerOf(s.ticker) : null;
    if (!isRec(s) || !ticker) throw new Error("kalshi series has no valid ticker");
    const extra = Array.isArray(s.tags) ? s.tags.slice(0, 10).map(slugOf) : [];
    // The series category comes first: it becomes the imported market's category.
    return { ticker, tags: [...new Set([slugOf(s.category), ...extra, ticker.toLowerCase()].filter(Boolean))].slice(0, 12) };
}

function normalize(raw: unknown, event: unknown, series: Series, apiUrl: string, fetchedAt: string): SourceMarket {
    if (!isRec(raw) || !isRec(event)) throw new Error("kalshi market or event is not an object");
    const ticker = tickerOf(raw.ticker);
    const eventTicker = tickerOf(raw.event_ticker);
    if (!ticker || !eventTicker || event.event_ticker !== eventTicker || event.series_ticker !== series.ticker) {
        throw new Error("kalshi market has no valid ticker, event or series");
    }
    // Combos (multivariate events) and scalar markets have no Yes/No payout we can mirror.
    if (raw.market_type !== "binary" || raw.mve_collection_ticker !== undefined) throw new Error(`kalshi market ${ticker} is not a plain binary market`);
    const title = str(raw.title, 400).trim() || str(event.title, 400).trim();
    const sub = str(raw.yes_sub_title, 100).trim();
    // Multi-market events often share one title ("Who will the next Pope be?"); the Yes label names the market.
    const question = sub && !title.toLowerCase().includes(sub.toLowerCase()) ? `${title} (${sub})` : title;
    if (!question) throw new Error(`kalshi market ${ticker} has no title`);
    const status = str(raw.status, 32);
    const core = {
        provider: "kalshi" as const,
        sourceId: ticker,
        slug: ticker.toLowerCase(),
        url: `https://kalshi.com/markets/${series.ticker.toLowerCase()}`,
        question: question.slice(0, 500),
        description: [str(raw.rules_primary, 10_000), str(raw.rules_secondary, 10_000)].filter(Boolean).join("\n\n"),
        resolutionSource: sourcesOf(event.settlement_sources),
        outcomes: ["Yes", "No"],
        endDate: isoDate(raw.close_time),
        tags: series.tags,
        active: status === "active",
        closed: !OPEN_STATUSES.has(status),
        archived: false,
        sourceStatus: status || null,
        protocol: { version: VERSION, chainId: 0, negRisk: false, resolver: RESOLVER, conditionId: ticker, questionId: eventTicker, settlementContract: apiUrl },
    };
    const eventTitle = str(event.title, 200).trim();
    return {
        ...core,
        referencePrices: pricesOf(raw),
        image: null,
        event: eventTitle ? { title: eventTitle, slug: eventTicker.toLowerCase() } : null,
        gameStartTime: null,
        versionHash: sha256Hex(canonicalJson(core)),
        fetchedAt,
    };
}

function snapshotOf(body: unknown): Snapshot {
    const m = isRec(body) ? body.market : null;
    if (!isRec(m)) throw new Error("unexpected /markets/{ticker} response");
    const f = (k: keyof Snapshot) => str(m[k], 64);
    return {
        ticker: f("ticker"), event_ticker: f("event_ticker"), market_type: f("market_type"), status: f("status"), result: f("result"),
        settlement_value_dollars: f("settlement_value_dollars"), settlement_ts: f("settlement_ts"), close_time: f("close_time"),
    };
}

function identityProblem(m: SourceMarket, apiUrl: string): Problem | null {
    const p = m.protocol;
    if (m.provider !== "kalshi" || p.version !== VERSION || p.chainId !== 0 || p.negRisk || p.resolver !== RESOLVER || p.settlementContract !== apiUrl) {
        return { code: "unsupported-version", reason: `${m.provider} ${p.version} via ${p.settlementContract} is not Kalshi ${VERSION} at ${apiUrl}` };
    }
    if (!TICKER.test(m.sourceId) || p.conditionId !== m.sourceId || !TICKER.test(p.questionId)) {
        return { code: "condition-mismatch", reason: "conditionId must be the market ticker and questionId its event ticker" };
    }
    if (m.outcomes.length !== 2 || m.outcomes[0] !== "Yes" || m.outcomes[1] !== "No") {
        return { code: "not-binary", reason: `outcomes ${JSON.stringify(m.outcomes).slice(0, 200)}` };
    }
    return null;
}

const sameVector = (a: { numerators: readonly bigint[]; denominator: bigint }, b: { numerators: readonly bigint[]; denominator: bigint }) =>
    a.denominator === b.denominator && a.numerators.length === b.numerators.length && a.numerators.every((n, i) => n === b.numerators[i]);

/** Settlement facts only, no read times or labels, so independent attestors sign the same digest. */
export function evidenceRecord(market: SourceMarket, evidence: ResolutionEvidence) {
    const m = evidence.reads?.market as Snapshot | undefined;
    if (evidence.status !== "final" || !evidence.vector || !isRec(m)) throw new Error("evidence is not a final resolution");
    return {
        profile: KALSHI_PROFILE, sourceId: market.sourceId, eventTicker: market.protocol.questionId,
        status: m.status, result: m.result, settlementValue: m.settlement_value_dollars, settledAt: m.settlement_ts, closeTime: m.close_time,
        payout: { numerators: evidence.vector.numerators.map(String), denominator: evidence.vector.denominator.toString() },
    };
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (e) {
            const permanent = e instanceof HttpError && e.status < 500 && e.status !== 429;
            if (permanent || attempt >= MAX_RETRIES) throw e;
            await sleep(RETRY_BASE_MS * 2 ** attempt * (0.5 + Math.random()));
        }
    }
}

export function createKalshiProvider(opts: KalshiProviderOptions = {}): MarketSourceProvider {
    const apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const doFetch = opts.fetch ?? fetch;

    async function getJson(path: string): Promise<unknown> {
        const url = `${apiUrl}${path}`;
        const res = await doFetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new HttpError(res.status, url);
        return res.json();
    }

    // Events and series are shared by many markets; bounded caches keep a pass to one read of each.
    const eventCache = new Map<string, Rec>();
    async function event(ticker: string): Promise<Rec> {
        let e = eventCache.get(ticker);
        if (!e) {
            const body = await withRetry(() => getJson(`/events/${ticker}`));
            e = isRec(body) && isRec(body.event) ? body.event : undefined;
            if (!e || tickerOf(e.event_ticker) !== ticker) throw new Error(`kalshi returned no event for ${ticker}`);
            if (eventCache.size >= 5000) eventCache.clear();
            eventCache.set(ticker, e);
        }
        return e;
    }

    const seriesCache = new Map<string, Series>();
    async function series(ticker: string): Promise<Series> {
        let s = seriesCache.get(ticker);
        if (!s) {
            s = seriesOf(await withRetry(() => getJson(`/series/${ticker}`)));
            if (s.ticker !== ticker) throw new Error(`kalshi returned series ${s.ticker} for ${ticker}`);
            seriesCache.set(ticker, s);
        }
        return s;
    }

    return {
        name: "kalshi",
        profile: KALSHI_PROFILE,
        evidenceRecord,

        async discoverMarkets(cursor, limit, opts = {}) {
            const tag = opts.tag?.toLowerCase();
            if (tag !== undefined && !/^[a-z0-9-]{1,60}$/.test(tag)) throw new Error(`invalid Kalshi category ${JSON.stringify(tag.slice(0, 40))}`);
            // /events lists in no useful order (page 1 is decades-long markets), so markets are paged within a close
            // window instead; Kalshi has no volume order, so each page is sorted.
            const nowS = Math.floor(Date.now() / 1000);
            const q = new URLSearchParams({
                status: "open", mve_filter: "exclude", limit: String(Math.min(1000, Math.max(1, Math.trunc(limit) || 1))),
                min_close_ts: String(nowS + 3600), max_close_ts: String(nowS + DISCOVERY_WINDOW_DAYS * 86_400),
            });
            if (cursor) q.set("cursor", cursor);
            const body = await withRetry(() => getJson(`/markets?${q}`));
            if (!isRec(body) || !Array.isArray(body.markets)) throw new Error("unexpected /markets response");
            const fetchedAt = new Date().toISOString();
            const ranked: [number, SourceMarket][] = [];
            for (const m of body.markets) {
                const et = isRec(m) ? tickerOf(m.event_ticker) : null;
                const e = et ? await event(et).catch(() => null) : null;
                const st = e ? tickerOf(e.series_ticker) : null;
                const sr = st ? await series(st).catch(() => null) : null;
                if (!e || !sr) continue;
                try {
                    const market = normalize(m, e, sr, apiUrl, fetchedAt);
                    if (!tag || market.tags.includes(tag)) ranked.push([Number(str((m as Rec).volume_24h_fp, 32)) || 0, market]);
                } catch {
                    // a malformed entry is skipped, not fatal to the page
                }
            }
            const next = typeof body.cursor === "string" && body.cursor && body.cursor.length <= 500 ? body.cursor : null;
            return { markets: ranked.sort((x, y) => y[0] - x[0]).map(([, m]) => m), next };
        },

        async fetchMarketDefinition(sourceId) {
            if (!TICKER.test(sourceId)) throw new Error(`invalid Kalshi ticker ${JSON.stringify(sourceId.slice(0, 40))}`);
            const body = await withRetry(() => getJson(`/markets/${sourceId}`));
            const raw = isRec(body) ? body.market : null;
            const eventTicker = isRec(raw) ? tickerOf(raw.event_ticker) : null;
            if (!eventTicker) throw new Error(`kalshi market ${sourceId} has no valid event ticker`);
            const ev = await withRetry(() => getJson(`/events/${eventTicker}`));
            const event = isRec(ev) ? ev.event : null;
            const st = isRec(event) ? tickerOf(event.series_ticker) : null;
            if (!st) throw new Error(`kalshi event ${eventTicker} has no valid series ticker`);
            const market = normalize(raw, event, await series(st), apiUrl, new Date().toISOString());
            if (market.sourceId !== sourceId) throw new Error(`kalshi returned market ${market.sourceId} for ${sourceId}`);
            return market;
        },

        evaluateEligibility(market: SourceMarket, policy: EligibilityPolicy, now: Date): Eligibility {
            const no = (code: string, reason: string): Eligibility => ({ eligible: false, code, reason });
            if (!policy.profiles.includes(KALSHI_PROFILE)) return no("profile-disabled", `${KALSHI_PROFILE} is not enabled`);
            const bad = identityProblem(market, apiUrl);
            if (bad) return no(bad.code, bad.reason);
            if (!market.active || market.closed) return no("closed", `status ${market.sourceStatus ?? "missing"}`);
            const end = market.endDate ? Date.parse(market.endDate) : NaN;
            const t = now.getTime();
            if (!(end >= t + policy.minHorizonSeconds * 1000 && end <= t + policy.maxHorizonSeconds * 1000)) {
                return no("horizon", `endDate ${market.endDate ?? "missing"} outside [now+${policy.minHorizonSeconds}s, now+${policy.maxHorizonSeconds}s]`);
            }
            if (market.referencePrices?.some((p) => Number(p.price) >= 0.98)) return no("decided", "a reference price is at or above 0.98");
            const wanted = policy.tags.map((tag) => tag.toLowerCase());
            if (wanted.length > 0 && !market.tags.some((tag) => wanted.includes(tag))) return no("tag-filter", "no allowed tag");
            return { eligible: true, profile: KALSHI_PROFILE };
        },

        async fetchResolutionEvidence(market) {
            const observedAt = new Date().toISOString();
            const bad = identityProblem(market, apiUrl);
            if (bad) return { status: "unsupported", detail: `${bad.code}: ${bad.reason}`, observedAt };
            const ticker = market.sourceId;
            // Two reads of the same API must agree, so one stale or torn response cannot settle a market.
            const reads: Snapshot[] = [];
            while (reads.length < READS.length) reads.push(snapshotOf(await withRetry(() => getJson(`/markets/${ticker}`))));
            const [m] = reads as [Snapshot, Snapshot];
            const done = (status: ResolutionStatus, detail: string, vector?: { numerators: bigint[]; denominator: bigint }): ResolutionEvidence => ({
                status,
                detail,
                ...(vector ? { vector } : {}),
                reads: { profile: KALSHI_PROFILE, ticker, eventTicker: market.protocol.questionId, market: m, providers: READS, reads: READS.map((provider, i) => ({ provider, ...reads[i] })) },
                observedAt,
            });
            if (new Set(reads.map((r) => canonicalJson(r))).size > 1) return done("inconsistent", `kalshi reads disagree: ${reads.map((r) => `${r.status}/${r.result || "-"}`).join(" vs ")}`);
            if (m.ticker !== ticker || m.event_ticker !== market.protocol.questionId || m.market_type !== "binary") {
                return done("inconsistent", `kalshi returned ${m.market_type} market ${m.ticker} (${m.event_ticker})`);
            }
            const at = `status=${m.status} result=${m.result || "-"}`;
            if (m.status !== "finalized") {
                const status = m.status === "disputed" ? "disputed" : m.status === "determined" || m.status === "amended" ? "proposed" : m.status === "closed" ? "unresolved" : "too-early";
                return done(status, `kalshi ${at}`);
            }
            // Kalshi documents no void result; "scalar" is a fractional settlement our binary vectors cannot express.
            if (m.result !== "yes" && m.result !== "no") return done(m.result === "scalar" ? "unsupported" : "inconsistent", `kalshi ${at} settlement=${m.settlement_value_dollars || "-"}`);
            const expected = m.result === "yes" ? 10_000 : 0;
            if (m.settlement_value_dollars && basisPoints(m.settlement_value_dollars) !== expected) {
                return done("inconsistent", `kalshi ${at} but settlement value ${m.settlement_value_dollars}`);
            }
            const v = BINARY_VECTORS[m.result];
            const vector = { numerators: [...v.numerators], denominator: v.denominator };
            return done("final", `kalshi ${at} (${m.result === "yes" ? "Yes" : "No"}) settled ${m.settlement_ts || "-"} on ${READS.length} reads`, vector);
        },

        async screenResolved(markets) {
            const tickers = [...new Set(markets.filter((m) => !identityProblem(m, apiUrl)).map((m) => m.protocol.conditionId))];
            const out: string[] = [];
            // No retries: one request per chunk per pass is the budget; the next pass retries.
            for (let i = 0; i < tickers.length; i += 50) {
                const chunk = tickers.slice(i, i + 50);
                const body = await getJson(`/markets?${new URLSearchParams({ tickers: chunk.join(","), limit: "1000" })}`);
                if (!isRec(body) || !Array.isArray(body.markets)) throw new Error("unexpected /markets response");
                for (const m of body.markets) {
                    if (isRec(m) && typeof m.ticker === "string" && chunk.includes(m.ticker) && m.status === "finalized" && m.result) out.push(m.ticker);
                }
            }
            return out;
        },

        verifyFinalResolution(market, evidence, profile) {
            const fail = (reason: string) => ({ ok: false as const, reason });
            if (profile !== KALSHI_PROFILE) return fail(`unsupported profile ${profile}`);
            const bad = identityProblem(market, apiUrl);
            if (bad) return fail(`${bad.code}: ${bad.reason}`);
            if (evidence.status !== "final") return fail(`status is ${evidence.status}`);
            const m = evidence.reads?.market as Snapshot | undefined;
            if (evidence.reads?.ticker !== market.sourceId || !isRec(m) || m.ticker !== market.sourceId) return fail("evidence was read for a different market");
            if (m.status !== "finalized" || (m.result !== "yes" && m.result !== "no")) return fail(`kalshi status ${m.status} result ${m.result}`);
            if (!evidence.vector || !sameVector(evidence.vector, BINARY_VECTORS[m.result])) return fail(`vector is not ${m.result === "yes" ? "[1,0]/1" : "[0,1]/1"}`);
            const providers = new Set(evidence.reads?.providers as string[] | undefined).size;
            if (providers < READS.length) return fail(`${providers} reads < ${READS.length}`);
            return { ok: true };
        },
    };
}
