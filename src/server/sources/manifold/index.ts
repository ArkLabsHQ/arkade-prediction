import { canonicalJson, sha256Hex } from "../../../core/encoding.js";
import { BINARY_VECTORS } from "../../../core/payout.js";
import type { Eligibility, EligibilityPolicy, MarketSourceProvider, ResolutionEvidence, SourceMarket } from "../types.js";

export const MANIFOLD_PROFILE = "manifold-api-v0-binary";
const DEFAULT_API_URL = "https://api.manifold.markets/v0";
const VERSION = "api-v0";
/** About the median among the 500 busiest open binaries: thinner markets are mostly their creator's own. */
export const MIN_TRADERS = 20;
const MAX_OFFSET = 1000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 250;
const DETAIL_CONCURRENCY = 4;
const HEADERS = { accept: "application/json", "user-agent": "arkade-prediction/0.1" };

const SOURCE_ID = /^[A-Za-z0-9]{8,32}$/;
const USER_ID = /^[A-Za-z0-9]{8,40}$/;
const RESOLVER = /^manifold:[A-Za-z0-9]{8,40}$/;
const TOPIC = /^[a-z0-9-]{1,60}$/;

type Rec = Record<string, unknown>;
type Vector = { numerators: readonly bigint[]; denominator: bigint };

class HttpError extends Error {
    constructor(readonly status: number, url: string) {
        super(`HTTP ${status} from ${url}`);
    }
}

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isoMs = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v < 8.64e15 ? new Date(v).toISOString() : null);

const RESOLUTIONS: Record<string, { vector: Vector; label: string }> = {
    YES: { vector: BINARY_VECTORS.yes, label: "Yes" },
    NO: { vector: BINARY_VECTORS.no, label: "No" },
    CANCEL: { vector: BINARY_VECTORS.invalid, label: "invalid (CANCEL / N/A)" },
    MKT: { vector: BINARY_VECTORS.invalid, label: "invalid (MKT: probabilistic resolution is not a supported payout)" },
};

export function evidenceRecord(market: SourceMarket, evidence: ResolutionEvidence) {
    const r = evidence.reads;
    if (evidence.status !== "final" || !evidence.vector || !r) throw new Error("evidence is not a final resolution");
    return { profile: MANIFOLD_PROFILE, sourceId: market.sourceId, resolution: r.resolution, resolutionTime: r.resolutionTime, creatorId: r.creatorId };
}

function tagsOf(v: unknown): string[] {
    const slugs = Array.isArray(v) ? v.map((t) => (typeof t === "string" ? t.trim().toLowerCase().slice(0, 64) : "")) : [];
    return [...new Set([...slugs.filter(Boolean).slice(0, 19), "play-money"])].sort();
}

function urlOf(v: unknown): string {
    if (typeof v !== "string" || v.length > 500 || !URL.canParse(v)) return "";
    const u = new URL(v);
    return u.protocol === "https:" && u.host === "manifold.markets" ? u.href : "";
}

function identityProblem(m: SourceMarket, apiUrl: string): { code: string; reason: string } | null {
    const p = m.protocol;
    if (m.provider !== "manifold" || p.version !== VERSION || p.chainId !== 0 || p.settlementContract !== apiUrl) {
        return { code: "unsupported-version", reason: `${m.provider} ${p.version} via ${p.settlementContract} is not Manifold ${VERSION} at ${apiUrl}` };
    }
    if (!SOURCE_ID.test(m.sourceId) || p.conditionId !== m.sourceId || !RESOLVER.test(p.resolver ?? "")) {
        return { code: "identity", reason: "market id, conditionId or creator is missing or malformed" };
    }
    if (m.outcomes.length !== 2 || m.outcomes[0] !== "Yes" || m.outcomes[1] !== "No") {
        return { code: "not-binary", reason: "not a BINARY cpmm-1 market" };
    }
    return null;
}

const isSupportedVector = (v: Vector) =>
    v.numerators.length === 2 && Object.values(BINARY_VECTORS).some((r) => r.denominator === v.denominator && r.numerators.every((n, i) => n === v.numerators[i]));

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

export function createManifoldProvider(opts: { apiUrl?: string; fetch?: typeof fetch; timeoutMs?: number } = {}): MarketSourceProvider {
    const apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    const doFetch = opts.fetch ?? fetch;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    // Bettor counts sit outside SourceMarket (and its versionHash); eligibility reads them for markets this provider built.
    const traders = new WeakMap<SourceMarket, number>();

    async function getJson(path: string): Promise<unknown> {
        return withRetry(async () => {
            const res = await doFetch(`${apiUrl}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
            if (!res.ok) throw new HttpError(res.status, path.split("?")[0]!);
            return res.json();
        });
    }

    function normalize(raw: unknown, fetchedAt: string): SourceMarket {
        if (!isRec(raw)) throw new Error("manifold market is not an object");
        const sourceId = raw.id;
        if (typeof sourceId !== "string" || !SOURCE_ID.test(sourceId)) throw new Error("manifold market has no valid id");
        const creator = typeof raw.creatorId === "string" && USER_ID.test(raw.creatorId) ? raw.creatorId : null;
        const binary = raw.outcomeType === "BINARY" && raw.mechanism === "cpmm-1";
        const endDate = isoMs(raw.closeTime);
        const resolved = raw.isResolved === true;
        const closed = resolved || !endDate || Date.parse(endDate) <= Date.parse(fetchedAt);
        const slug = str(raw.slug, 200);
        const core = {
            provider: "manifold" as const,
            sourceId,
            slug,
            url: urlOf(raw.url),
            question: str(raw.question, 500),
            description: str(raw.textDescription, 20_000),
            resolutionSource: "Resolved by the market's creator on Manifold",
            outcomes: binary ? ["Yes", "No"] : [],
            endDate,
            tags: tagsOf(raw.groupSlugs),
            active: !closed,
            closed,
            archived: false,
            sourceStatus: resolved ? "resolved" : null,
            protocol: {
                version: VERSION,
                chainId: 0,
                negRisk: false,
                resolver: creator ? `manifold:${creator}` : null,
                conditionId: sourceId,
                questionId: slug,
                settlementContract: apiUrl,
            },
        };
        const p = raw.probability;
        const referencePrices =
            binary && typeof p === "number" && p >= 0 && p <= 1
                ? [{ outcome: "Yes", price: p.toFixed(4) }, { outcome: "No", price: (1 - p).toFixed(4) }]
                : null;
        const market: SourceMarket = { ...core, referencePrices, image: null, event: null, gameStartTime: null, versionHash: sha256Hex(canonicalJson(core)), fetchedAt };
        if (typeof raw.uniqueBettorCount === "number") traders.set(market, raw.uniqueBettorCount);
        return market;
    }

    async function fetchDefinition(sourceId: string): Promise<SourceMarket> {
        if (!SOURCE_ID.test(sourceId)) throw new Error(`invalid Manifold market id ${JSON.stringify(sourceId.slice(0, 40))}`);
        const market = normalize(await getJson(`/market/${sourceId}`), new Date().toISOString());
        if (market.sourceId !== sourceId) throw new Error(`manifold returned market ${market.sourceId} for ${sourceId}`);
        return market;
    }

    return {
        name: "manifold",
        profile: MANIFOLD_PROFILE,
        evidenceRecord,
        fetchMarketDefinition: fetchDefinition,

        async discoverMarkets(cursor, limit, opts = {}) {
            const size = Math.min(100, Math.max(1, Math.trunc(limit) || 1));
            const offset = cursor === null ? 0 : Number(cursor);
            if (!Number.isInteger(offset) || offset < 0 || offset >= MAX_OFFSET) throw new Error(`invalid Manifold cursor ${JSON.stringify(String(cursor).slice(0, 20))}`);
            const q = new URLSearchParams({ filter: "open", contractType: "BINARY", sort: "24-hour-vol", limit: String(size), offset: String(offset) });
            if (opts.tag) {
                if (!TOPIC.test(opts.tag)) throw new Error(`invalid Manifold topic ${JSON.stringify(opts.tag.slice(0, 40))}`);
                q.set("topicSlug", opts.tag);
            }
            const body = await getJson(`/search-markets?${q}`);
            if (!Array.isArray(body)) throw new Error("unexpected /search-markets response");
            // Search omits rules and topics, so busy enough hits are re-read in full; thin ones are never imported.
            const ids = body.flatMap((m) => (isRec(m) && typeof m.id === "string" && SOURCE_ID.test(m.id) && Number(m.uniqueBettorCount) >= MIN_TRADERS ? [m.id] : []));
            const markets: SourceMarket[] = [];
            for (let i = 0; i < ids.length; i += DETAIL_CONCURRENCY) {
                const batch = await Promise.all(ids.slice(i, i + DETAIL_CONCURRENCY).map((id) => fetchDefinition(id).catch(() => null)));
                markets.push(...batch.filter((m) => m !== null));
            }
            return { markets, next: body.length === size && offset + size < MAX_OFFSET ? String(offset + size) : null };
        },

        evaluateEligibility(market: SourceMarket, policy: EligibilityPolicy, now: Date): Eligibility {
            const no = (code: string, reason: string): Eligibility => ({ eligible: false, code, reason });
            if (!policy.profiles.includes(MANIFOLD_PROFILE)) return no("profile-disabled", `${MANIFOLD_PROFILE} is not enabled`);
            const bad = identityProblem(market, apiUrl);
            if (bad) return no(bad.code, bad.reason);
            if (market.closed) return no("closed", market.sourceStatus ?? "closed");
            const end = market.endDate ? Date.parse(market.endDate) : NaN;
            const t = now.getTime();
            if (!(end >= t + policy.minHorizonSeconds * 1000 && end <= t + policy.maxHorizonSeconds * 1000)) {
                return no("horizon", `endDate ${market.endDate ?? "missing"} outside [now+${policy.minHorizonSeconds}s, now+${policy.maxHorizonSeconds}s]`);
            }
            const yes = Number(market.referencePrices?.[0]?.price ?? NaN);
            if (!(yes > 0.02 && yes < 0.98)) return no("decided", `probability ${market.referencePrices?.[0]?.price ?? "missing"} is not inside (0.02, 0.98)`);
            const n = traders.get(market);
            if (n === undefined || n < MIN_TRADERS) return no("thin", `${n ?? "unknown"} traders < ${MIN_TRADERS}`);
            const wanted = policy.tags.map((tag) => tag.toLowerCase());
            if (wanted.length > 0 && !market.tags.some((tag) => wanted.includes(tag))) return no("tag-filter", "no allowed tag");
            return { eligible: true, profile: MANIFOLD_PROFILE };
        },

        async fetchResolutionEvidence(market) {
            const observedAt = new Date().toISOString();
            const bad = identityProblem(market, apiUrl);
            if (bad) return { status: "unsupported", detail: `${bad.code}: ${bad.reason}`, observedAt };
            const read = async () => {
                const r = await getJson(`/market/${market.sourceId}`);
                if (!isRec(r)) throw new Error("manifold market is not an object");
                const { id, creatorId, outcomeType, mechanism, isResolved, resolution, resolutionTime, resolverId } = r;
                return { id, creatorId, outcomeType, mechanism, isResolved, resolution, resolutionTime, resolverId };
            };
            const first = await read();
            const second = await read();
            const providers = ["manifold#1", "manifold#2"];
            const done = (status: ResolutionEvidence["status"], detail: string, vector?: ResolutionEvidence["vector"]): ResolutionEvidence => ({
                status,
                detail,
                ...(vector ? { vector } : {}),
                reads: { profile: MANIFOLD_PROFILE, sourceId: market.sourceId, creatorId: first.creatorId, resolution: first.resolution, resolutionTime: first.resolutionTime, resolverId: first.resolverId, providers, raw: [first, second] },
                observedAt,
            });
            if (JSON.stringify(first) !== JSON.stringify(second)) return done("inconsistent", "the two Manifold reads disagree");
            if (first.id !== market.sourceId || `manifold:${String(first.creatorId)}` !== market.protocol.resolver) {
                return done("inconsistent", "Manifold now reports a different id or creator for this market");
            }
            if (first.outcomeType !== "BINARY" || first.mechanism !== "cpmm-1") return done("unsupported", "market is no longer BINARY cpmm-1");
            if (first.isResolved !== true) return done("unresolved", `isResolved is ${String(first.isResolved)} on both reads`);
            const res = typeof first.resolution === "string" ? RESOLUTIONS[first.resolution] : undefined;
            if (!res || !isoMs(first.resolutionTime)) return done("unsupported", `resolution ${JSON.stringify(first.resolution)?.slice(0, 40)} at ${String(first.resolutionTime).slice(0, 20)} is not supported`);
            const v = res.vector;
            return done("final", `resolved ${first.resolution} -> [${v.numerators.join(",")}]/${v.denominator} (${res.label}) on 2 agreeing reads`, { numerators: [...v.numerators], denominator: v.denominator });
        },

        async screenResolved(markets) {
            const ids = new Set(markets.filter((m) => !identityProblem(m, apiUrl)).map((m) => m.protocol.conditionId));
            if (ids.size === 0) return [];
            // No batch-by-id read exposes resolution; the newest 1000 resolved binaries reach back weeks. One request, no quorum: a trigger only.
            const body = await getJson(`/search-markets?filter=resolved&contractType=BINARY&sort=resolve-date&limit=${MAX_OFFSET}`);
            if (!Array.isArray(body)) throw new Error("unexpected /search-markets response");
            return [...new Set(body.flatMap((m) => (isRec(m) && m.isResolved === true && typeof m.id === "string" && ids.has(m.id) ? [m.id] : [])))];
        },

        verifyFinalResolution(market, evidence, profile) {
            const fail = (reason: string) => ({ ok: false as const, reason });
            if (profile !== MANIFOLD_PROFILE) return fail(`unsupported profile ${profile}`);
            const bad = identityProblem(market, apiUrl);
            if (bad) return fail(`${bad.code}: ${bad.reason}`);
            if (evidence.status !== "final") return fail(`status is ${evidence.status}`);
            if (evidence.chain) return fail("Manifold evidence carries no chain read");
            const r = evidence.reads;
            if (!r || r.sourceId !== market.sourceId || `manifold:${String(r.creatorId)}` !== market.protocol.resolver) return fail("evidence was read for a different market or creator");
            const expected = typeof r.resolution === "string" ? RESOLUTIONS[r.resolution]?.vector : undefined;
            const v = evidence.vector;
            if (!v || !expected || !isSupportedVector(v) || canonicalJson(v) !== canonicalJson(expected)) return fail("vector does not match the reported resolution");
            if (!isoMs(r.resolutionTime)) return fail("resolutionTime missing");
            if (!Array.isArray(r.providers) || new Set(r.providers).size < 2) return fail("fewer than 2 agreeing reads");
            return { ok: true };
        },
    };
}
