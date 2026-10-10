import { canonicalJson, sha256Hex } from "../../../core/encoding.js";
import { BINARY_VECTORS } from "../../../core/payout.js";
import { deriveConditionId } from "../polymarket/index.js";
import type {
    Eligibility,
    EligibilityPolicy,
    MarketSourceProvider,
    ProviderName,
    ResolutionEvidence,
    ResolutionStatus,
    SourceMarket,
} from "../types.js";

export const LIMITLESS_PROFILE = "limitless-ctf-base-binary";
export const BASE_CHAIN_ID = 8453;
export const LIMITLESS_CTF = "0xc9c98965297bc527861c898329ee280632b76e18";
/** Limitless's 2-of-11 Safe (v1.3.0): the CTF oracle of its own markets, read on Base 2026-10-10. */
export const DEFAULT_RESOLVERS = ["0x32e52896663de88a65c2d94917b006404415a89f"];
// ponytail: cast until "limitless" joins ProviderName in types.ts.
const PROVIDER: ProviderName = "limitless";
const DEFAULT_API_URL = "https://api.limitless.exchange";
const VERSION = "clob";
const MIRROR_TAG = "polymarket-mirror";
const PAGE_SIZE = 25;
const CONDITION_PREPARATION = "0xab3760c3bd2bb38b5bcf54dc79802ed67338b4cf29f3054ded67ed24661e4177";
const SEL_PAYOUT_DENOMINATOR = "dd34de67";
const SEL_PAYOUT_NUMERATORS = "0504c814";
const SEL_OUTCOME_SLOT_COUNT = "d42dc0c2";
/**
 * The API omits questionId, so it is read from the ConditionPreparation log near `createdAt` (2 s blocks).
 * All 195 candidates on 2026-10-10 were prepared 5 blocks before to 1831 after it (sports ~1 h after listing).
 */
const LOOKBACK_BLOCKS = 100;
const LOOKAHEAD_BLOCKS = 4000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 250;
const HEADERS = { accept: "application/json", "user-agent": "arkade-prediction/0.1" };

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SLUG = /^[a-z0-9-]{1,200}$/;
const IMAGE_HOST = "cdn.limitless.exchange";

export interface LimitlessProviderOptions {
    apiUrl?: string;
    rpcUrls: string[];
    resolverAllowlist?: string[];
    fetch?: typeof fetch;
    timeoutMs?: number;
    minProviders?: number;
    /** Widest eth_getLogs range the providers accept (Tenderly's public gateway: 1000). */
    logSpan?: number;
}

type Rec = Record<string, unknown>;
type Problem = { code: string; reason: string };
type Prep = { oracle: string; questionId: string } | null;
type Group = { title: string; slug: string; raw: Rec };
interface RpcCall {
    provider: string;
    method: string;
    params: unknown[];
    result?: unknown;
    error?: string;
}

class HttpError extends Error {
    constructor(readonly status: number, url: string) {
        super(`HTTP ${status} from ${url}`);
    }
}

const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const isoMs = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v < 8.64e15 ? new Date(v).toISOString() : null);

function hexOf(v: unknown, re: RegExp): string | null {
    const s = typeof v === "string" ? v.toLowerCase() : "";
    return re.test(s) ? s : null;
}

export function evidenceRecord(market: SourceMarket, evidence: ResolutionEvidence) {
    const raw = evidence.reads?.payout as { numerators: bigint[]; denominator: bigint } | undefined;
    if (evidence.status !== "final" || !evidence.chain || !evidence.vector || !raw) throw new Error("evidence is not a final resolution");
    return {
        profile: LIMITLESS_PROFILE, chainId: evidence.chain.chainId, ctf: LIMITLESS_CTF, sourceId: market.sourceId,
        conditionId: market.protocol.conditionId, questionId: market.protocol.questionId, resolver: market.protocol.resolver,
        block: { number: evidence.chain.blockNumber, hash: evidence.chain.blockHash },
        payout: { numerators: evidence.vector.numerators.map(String), denominator: evidence.vector.denominator.toString() },
        chainPayout: { numerators: raw.numerators.map(String), denominator: raw.denominator.toString() },
    };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

export function htmlToText(html: string): string {
    return html
        .replace(/<br\s*\/?>|<\/(p|div|li|h\d)>/gi, "\n")
        .replace(/<[^>]*>/g, "")
        .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e: string) => ENTITIES[e]!)
        .replace(/[ \t]+\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function tagsOf(raw: Rec, mirror: boolean): string[] {
    const all = [...(Array.isArray(raw.categories) ? raw.categories : []), ...(Array.isArray(raw.tags) ? raw.tags : [])];
    const slugs = all.map((t) => (typeof t === "string" ? t.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 64) : ""));
    return [...new Set([...slugs.filter(Boolean).slice(0, 19), ...(mirror ? [MIRROR_TAG] : [])])].sort();
}

function imageOf(v: unknown): string | null {
    if (typeof v !== "string" || v.length > 500 || !URL.canParse(v)) return null;
    const u = new URL(v);
    return u.protocol === "https:" && u.host === IMAGE_HOST ? u.href : null;
}

/** A group child's title is a fragment ("25") of its group's ("... above __ in Q4 2026?"). */
function questionOf(title: string, group: { title: string } | null): string {
    if (!group) return title;
    return group.title.includes("__") ? group.title.replace("__", title) : `${group.title}: ${title}`;
}

function normalize(raw: unknown, group: Group | null, prep: Prep, fetchedAt: string): SourceMarket {
    if (!isRec(raw)) throw new Error("limitless market is not an object");
    const slug = typeof raw.slug === "string" && SLUG.test(raw.slug) ? raw.slug : null;
    if (!slug) throw new Error("limitless market has no valid slug");
    const meta = isRec(raw.metadata) ? raw.metadata : {};
    const groupMeta = group && isRec(group.raw.metadata) ? group.raw.metadata : {};
    const venue = (r: Rec) => (isRec(r.venue) && r.venue.adapter != null) || r.negRiskRequestId != null;
    const mirror = meta.isPolyArbitrage === true || groupMeta.isPolyArbitrage === true;
    const question = questionOf(str(raw.title, 500).trim(), group);
    // Only "...?" questions name YES/NO; head-to-head and Up/Down titles publish no per-index label.
    const outcomes = question.endsWith("?") ? ["Yes", "No"] : [];
    const endDate = isoMs(raw.expirationTimestamp);
    const status = typeof raw.status === "string" ? raw.status.slice(0, 32) : null;
    const closed = status !== "FUNDED" || raw.expired !== false;
    const core = {
        provider: PROVIDER,
        sourceId: slug,
        slug,
        url: `https://limitless.exchange/markets/${slug}`,
        question,
        description: htmlToText(str(raw.description, 40_000)).slice(0, 20_000),
        resolutionSource: "",
        outcomes,
        endDate,
        tags: tagsOf(raw, mirror),
        active: !closed,
        closed,
        archived: raw.hidden === true,
        sourceStatus: status,
        protocol: {
            version: raw.tradeType === "clob" ? VERSION : str(raw.tradeType, 16),
            chainId: BASE_CHAIN_ID,
            negRisk: venue(raw) || (group !== null && venue(group.raw)) || raw.isOther === true,
            resolver: prep?.oracle ?? null,
            conditionId: hexOf(raw.conditionId, BYTES32) ?? "",
            questionId: prep?.questionId ?? "",
            settlementContract: LIMITLESS_CTF,
        },
    };
    const p = Array.isArray(raw.prices) ? raw.prices : [];
    const referencePrices =
        outcomes.length === 2 && p.length === 2 && p.every((x) => typeof x === "number" && x >= 0 && x <= 1)
            ? outcomes.map((outcome, i) => ({ outcome, price: (p[i] as number).toFixed(4) }))
            : null;
    const kickoff = typeof meta.startMatchTimestampInUTC === "number" ? isoMs(meta.startMatchTimestampInUTC * 1000) : null;
    return {
        ...core, referencePrices, image: imageOf(raw.logo), event: group ? { title: group.title, slug: group.slug } : null,
        // The API publishes lifetime volume only; no 24h figure exists to report.
        volume24h: null, gameStartTime: kickoff, versionHash: sha256Hex(canonicalJson(core)), fetchedAt,
    };
}

function identityProblem(m: SourceMarket, allow: ReadonlySet<string>): Problem | null {
    const p = m.protocol;
    if (m.provider !== PROVIDER || p.version !== VERSION || p.chainId !== BASE_CHAIN_ID || p.settlementContract !== LIMITLESS_CTF) {
        return { code: "unsupported-version", reason: `${p.version || "unknown"} market on chain ${p.chainId} is not a Limitless CLOB market on Base` };
    }
    if (p.negRisk) return { code: "neg-risk", reason: "neg-risk group, adapter venue or Other placeholder" };
    if (m.outcomes.length !== 2 || m.outcomes[0] !== "Yes" || m.outcomes[1] !== "No") {
        return { code: "not-binary", reason: "not a Yes/No question (head-to-head and Up/Down labels are not published per outcome index)" };
    }
    if (!BYTES32.test(p.conditionId)) return { code: "identity", reason: "conditionId missing or malformed" };
    if (!p.resolver || !allow.has(p.resolver)) return { code: "unknown-resolver", reason: `resolver ${p.resolver ?? "not found on chain"} is not allowlisted` };
    if (!BYTES32.test(p.questionId) || deriveConditionId(p.resolver, p.questionId) !== p.conditionId) {
        return { code: "condition-mismatch", reason: "conditionId != keccak256(resolver, questionId, 2)" };
    }
    return null;
}

const isSupportedVector = (v: { numerators: readonly bigint[]; denominator: bigint }) =>
    v.numerators.length === 2 && Object.values(BINARY_VECTORS).some((r) => r.denominator === v.denominator && r.numerators.every((n, i) => n === v.numerators[i]));

/** The same fraction as a supported vector: Limitless reports 50-50 as [50,50]/100 (Base, 2026-10-10). */
function canonicalVector(n0: bigint, n1: bigint, den: bigint): { numerators: bigint[]; denominator: bigint } | null {
    if (den === 0n || n0 + n1 !== den) return null;
    const v = n0 === 0n ? BINARY_VECTORS.no : n1 === 0n ? BINARY_VECTORS.yes : n0 === n1 ? BINARY_VECTORS.invalid : null;
    return v && { numerators: [...v.numerators], denominator: v.denominator };
}

function quantity(r: unknown): bigint {
    if (typeof r !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(r)) throw new Error(`not a hex quantity: ${String(r).slice(0, 80)}`);
    return BigInt(r);
}

function uint256(r: unknown): bigint {
    if (typeof r !== "string" || !/^0x[0-9a-f]{64}$/i.test(r)) throw new Error(`not a uint256 word: ${String(r).slice(0, 80)}`);
    return BigInt(r);
}

function header(r: unknown): { number: bigint; hash: string; timestamp: bigint } {
    const hash = isRec(r) ? hexOf(r.hash, BYTES32) : null;
    if (!isRec(r) || !hash) throw new Error("malformed block");
    return { number: quantity(r.number), hash, timestamp: quantity(r.timestamp) };
}

/** The first ConditionPreparation log for `conditionId`, or null for an empty result; anything else throws. */
function preparationOf(conditionId: string) {
    return (r: unknown): Prep => {
        if (!Array.isArray(r)) throw new Error("eth_getLogs result is not an array");
        const log = r[0];
        if (log === undefined) return null;
        const t = isRec(log) && Array.isArray(log.topics) ? log.topics.map((x) => hexOf(x, BYTES32)) : [];
        if (t[0] !== CONDITION_PREPARATION || t[1] !== conditionId || !t[2] || !t[3] || !t[2].startsWith(`0x${"0".repeat(24)}`)) {
            throw new Error("malformed ConditionPreparation log");
        }
        return { oracle: `0x${t[2].slice(26)}`, questionId: t[3] };
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

async function settle<T>(urls: string[], fn: (url: string) => Promise<T>): Promise<Map<string, T>> {
    const out = await Promise.all(urls.map((u) => fn(u).then((v): [string, T] => [u, v], () => null)));
    return new Map(out.filter((x) => x !== null));
}

export function createLimitlessProvider(opts: LimitlessProviderOptions): MarketSourceProvider {
    const apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    const rpcUrls = [...new Set(opts.rpcUrls)];
    const minProviders = opts.minProviders ?? 2;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const logSpan = opts.logSpan ?? 1000;
    const doFetch = opts.fetch ?? fetch;
    const allow = new Set((opts.resolverAllowlist ?? DEFAULT_RESOLVERS).map((a) => a.toLowerCase()));
    if (!Number.isInteger(minProviders) || minProviders < 2) throw new Error("minProviders must be an integer >= 2");
    if (!Number.isInteger(logSpan) || logSpan < 1) throw new Error("logSpan must be a positive integer");
    for (const a of allow) if (!ADDRESS.test(a)) throw new Error(`invalid resolver address ${a}`);
    const labels = new Map(
        rpcUrls.map((u, i) => {
            const url = URL.canParse(u) ? new URL(u) : null;
            if (!url || url.username || url.password) throw new Error(`RPC URL #${i + 1} must be a valid URL without user:password`);
            return [u, `${url.host}#${i + 1}`] as const;
        }),
    );
    const label = (u: string) => labels.get(u) ?? "rpc";

    async function getJson(url: string, init: RequestInit = { headers: HEADERS }, what = url): Promise<unknown> {
        const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new HttpError(res.status, what);
        return res.json();
    }
    const api = (path: string) => withRetry(() => getJson(`${apiUrl}${path}`, undefined, path.split("?")[0]));
    const post = (provider: string, body: unknown) =>
        getJson(provider, { method: "POST", headers: { ...HEADERS, "content-type": "application/json" }, body: JSON.stringify(body) }, label(provider));

    async function rpc<T>(log: RpcCall[], provider: string, method: string, params: unknown[], decode: (r: unknown) => T): Promise<T> {
        try {
            const [raw, value] = await withRetry(async () => {
                const body = await post(provider, { jsonrpc: "2.0", id: 1, method, params });
                if (!isRec(body) || body.id !== 1) throw new Error("malformed JSON-RPC response");
                if (body.error !== undefined) throw new Error(`JSON-RPC error ${JSON.stringify(body.error).slice(0, 200)}`);
                return [body.result, decode(body.result)] as const;
            });
            const result = isRec(raw) ? { number: raw.number, hash: raw.hash, parentHash: raw.parentHash, timestamp: raw.timestamp } : raw;
            log.push({ provider: label(provider), method, params, result });
            return value;
        } catch (e) {
            log.push({ provider: label(provider), method, params, error: errMsg(e) });
            throw e;
        }
    }

    /** First provider that answers; for lookups whose answer the caller verifies itself. */
    async function anyRpc<T>(method: string, params: unknown[], decode: (r: unknown) => T): Promise<T> {
        const log: RpcCall[] = [];
        for (const u of rpcUrls) {
            try {
                return await rpc(log, u, method, params, decode);
            } catch {
                // next provider
            }
        }
        throw new Error(`${method}: no provider answered; ${log.map((c) => `${c.provider}: ${c.error}`).join("; ")}`);
    }

    const preps = new Map<string, Prep>();
    let anchor: { at: number; number: bigint; timestamp: bigint } | null = null;
    /** Not trusted as such: identityProblem re-derives conditionId from the allowlisted oracle and this questionId. */
    async function preparation(conditionId: string, createdAt: unknown): Promise<Prep> {
        if (preps.has(conditionId)) return preps.get(conditionId)!;
        const created = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
        if (!Number.isFinite(created)) return null;
        if (!anchor || Date.now() - anchor.at > 60_000) anchor = { at: Date.now(), ...(await anyRpc("eth_getBlockByNumber", ["finalized", false], header)) };
        const est = anchor.number - (anchor.timestamp - BigInt(Math.floor(created / 1000))) / 2n;
        const span = BigInt(logSpan);
        const to = est + BigInt(LOOKAHEAD_BLOCKS) < anchor.number ? est + BigInt(LOOKAHEAD_BLOCKS) : anchor.number;
        let found: Prep = null;
        for (let a = est - BigInt(LOOKBACK_BLOCKS); a <= to && !found; a += span) {
            const b = a + span - 1n < to ? a + span - 1n : to;
            const filter = { address: LIMITLESS_CTF, fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}`, topics: [CONDITION_PREPARATION, conditionId] };
            found = await anyRpc("eth_getLogs", [filter], preparationOf(conditionId));
        }
        // A miss is cached only once the window is finalized, so a not-yet-finalized preparation is retried.
        if (found || to === est + BigInt(LOOKAHEAD_BLOCKS)) preps.set(conditionId, found);
        return found;
    }

    /** Looks up the condition's oracle only for markets nothing else already excludes. */
    async function build(raw: unknown, group: Group | null, fetchedAt: string): Promise<SourceMarket> {
        const draft = normalize(raw, group, null, fetchedAt);
        if (identityProblem(draft, allow)?.code !== "unknown-resolver" || draft.tags.includes(MIRROR_TAG)) return draft;
        const prep = await preparation(draft.protocol.conditionId, (raw as Rec).createdAt);
        return prep ? normalize(raw, group, prep, fetchedAt) : draft;
    }

    async function fetchDefinition(sourceId: string): Promise<SourceMarket> {
        if (!SLUG.test(sourceId)) throw new Error(`invalid Limitless market slug ${JSON.stringify(sourceId.slice(0, 40))}`);
        const raw = await api(`/markets/${sourceId}`);
        if (!isRec(raw)) throw new Error("limitless market is not an object");
        if (raw.marketType === "group" || Array.isArray(raw.markets)) throw new Error(`${sourceId} is a group, not a market`);
        let group: Group | null = null;
        if (typeof raw.groupSlug === "string" && SLUG.test(raw.groupSlug)) {
            const g = await api(`/markets/${raw.groupSlug}`);
            if (!isRec(g) || typeof g.title !== "string") throw new Error(`group ${raw.groupSlug} is not an object`);
            group = { title: str(g.title, 300).trim(), slug: raw.groupSlug, raw: g };
        }
        const market = await build(raw, group, new Date().toISOString());
        if (market.sourceId !== sourceId) throw new Error(`limitless returned market ${market.sourceId} for ${sourceId}`);
        return market;
    }

    return {
        name: PROVIDER,
        profile: LIMITLESS_PROFILE,
        evidenceRecord,
        fetchMarketDefinition: fetchDefinition,

        async discoverMarkets(cursor, limit, opts = {}) {
            if (opts.tag) throw new Error("Limitless discovery has no tag filter");
            const size = Math.min(PAGE_SIZE, Math.max(1, Math.trunc(limit) || 1));
            const page = cursor === null ? 1 : Number(cursor);
            if (!Number.isSafeInteger(page) || page < 1) throw new Error(`invalid Limitless cursor ${JSON.stringify(String(cursor).slice(0, 20))}`);
            const body = await api(`/markets/active?${new URLSearchParams({ page: String(page), limit: String(size), sortBy: "trending" })}`);
            if (!isRec(body) || !Array.isArray(body.data)) throw new Error("unexpected /markets/active response");
            const fetchedAt = new Date().toISOString();
            const entries = body.data.flatMap((m: unknown): { raw: unknown; group: Group | null }[] => {
                if (!isRec(m) || m.marketType !== "group") return [{ raw: m, group: null }];
                const group = { title: str(m.title, 300).trim(), slug: str(m.slug, 200), raw: m };
                return Array.isArray(m.markets) ? m.markets.map((c: unknown) => ({ raw: c, group })) : [];
            });
            const markets: SourceMarket[] = [];
            // Sequential: free Base log endpoints rate-limit bursts, and each lookup is cached afterwards.
            for (const e of entries) {
                try {
                    markets.push(await build(e.raw, e.group, fetchedAt));
                } catch {
                    // malformed, or the chain lookup failed: retried next pass
                }
            }
            return { markets, next: body.data.length === size ? String(page + 1) : null };
        },

        evaluateEligibility(market: SourceMarket, policy: EligibilityPolicy, now: Date): Eligibility {
            const no = (code: string, reason: string): Eligibility => ({ eligible: false, code, reason });
            if (!policy.profiles.includes(LIMITLESS_PROFILE)) return no("profile-disabled", `${LIMITLESS_PROFILE} is not enabled`);
            if (market.tags.includes(MIRROR_TAG)) return no("polymarket-mirror", "Limitless mirrors this market from Polymarket; it is imported from Polymarket directly");
            const bad = identityProblem(market, allow);
            if (bad) return no(bad.code, bad.reason);
            if (market.closed || market.archived) return no("closed", market.archived ? "hidden" : `status ${market.sourceStatus ?? "unknown"}`);
            const end = market.endDate ? Date.parse(market.endDate) : NaN;
            const t = now.getTime();
            if (!(end >= t + policy.minHorizonSeconds * 1000 && end <= t + policy.maxHorizonSeconds * 1000)) {
                return no("horizon", `endDate ${market.endDate ?? "missing"} outside [now+${policy.minHorizonSeconds}s, now+${policy.maxHorizonSeconds}s]`);
            }
            if (market.gameStartTime && Date.parse(market.gameStartTime) <= t) return no("started", `game started ${market.gameStartTime}`);
            if (market.referencePrices?.some((p) => Number(p.price) >= 0.98)) return no("decided", "a reference price is at or above 0.98");
            const wanted = policy.tags.map((tag) => tag.toLowerCase());
            if (wanted.length > 0 && !market.tags.some((tag) => wanted.includes(tag))) return no("tag-filter", "no allowed tag");
            return { eligible: true, profile: LIMITLESS_PROFILE };
        },

        async vetSource(market) {
            const no = (reason: string) => ({ ok: false as const, reason });
            const bad = identityProblem(market, allow);
            if (bad) return no(`${bad.code}: ${bad.reason}`);
            // The oracle is bound by the conditionId preimage; the chain must also hold that condition with two slots.
            const log: RpcCall[] = [];
            const data = `0x${SEL_OUTCOME_SLOT_COUNT}${market.protocol.conditionId.slice(2)}`;
            const answers = await settle(rpcUrls, (u) => rpc(log, u, "eth_call", [{ to: LIMITLESS_CTF, data }, "finalized"], uint256));
            if (answers.size < minProviders) {
                return no(`outcome slot count: ${answers.size}/${minProviders} providers answered; ${log.filter((c) => c.error).map((c) => `${c.provider}: ${c.error}`).join("; ")}`);
            }
            const counts = new Set([...answers.values()].map(String));
            if (counts.size > 1) return no(`outcome slot count differs across providers: ${[...answers].map(([u, n]) => `${label(u)}=${n}`).join(", ")}`);
            if (!counts.has("2")) return no(`condition has ${[...counts][0]} outcome slots on chain, not 2`);
            return { ok: true as const };
        },

        async fetchResolutionEvidence(market, opts = {}) {
            const observedAt = new Date().toISOString();
            const bad = identityProblem(market, allow);
            if (bad) return { status: "unsupported", detail: `${bad.code}: ${bad.reason}`, observedAt };
            const { conditionId, questionId, resolver } = market.protocol;
            const logs = new Map(rpcUrls.map((u) => [u, [] as RpcCall[]]));
            const call = <T>(u: string, method: string, params: unknown[], decode: (r: unknown) => T) => rpc(logs.get(u) ?? [], u, method, params, decode);
            const calls = () => [...logs.values()].flat();
            const done = (status: ResolutionStatus, detail: string, chain?: ResolutionEvidence["chain"], payout?: { numerators: bigint[]; denominator: bigint }): ResolutionEvidence => ({
                status,
                detail,
                ...(chain ? { chain } : {}),
                reads: { profile: LIMITLESS_PROFILE, ctf: LIMITLESS_CTF, conditionId, questionId, resolver, apiStatus: market.sourceStatus, payout, calls: calls() },
                observedAt,
            });
            const quorum = <T>(m: Map<string, T>, what: string): [T, ...T[]] => {
                if (m.size < minProviders) {
                    const errors = calls().filter((c) => c.error).map((c) => `${c.provider} ${c.method}: ${c.error}`);
                    throw new Error(`${what}: ${m.size}/${minProviders} providers answered; ${errors.join("; ")}`);
                }
                return [...m.values()] as [T, ...T[]];
            };

            const heads = await settle(rpcUrls, async (u) => ({
                chainId: await call(u, "eth_chainId", [], quantity),
                number: (await call(u, "eth_getBlockByNumber", ["finalized", false], header)).number,
            }));
            const offChain = [...heads].filter(([, h]) => h.chainId !== BigInt(BASE_CHAIN_ID)).map(([u]) => label(u));
            if (offChain.length > 0) return done("inconsistent", `not on chain ${BASE_CHAIN_ID}: ${offChain.join(", ")}`);
            const finalized = quorum(heads, "finalized head").map((h) => h.number).reduce((a, b) => (b < a ? b : a));
            if (opts.atBlock !== undefined && opts.atBlock > finalized) {
                return done("inconsistent", `block ${opts.atBlock} is not finalized on every provider yet (finalized ${finalized})`);
            }
            const number = opts.atBlock ?? finalized;
            const tag = `0x${number.toString(16)}`;

            const hashes = await settle([...heads.keys()], (u) =>
                call(u, "eth_getBlockByNumber", [tag, false], (r) => {
                    const b = header(r);
                    if (b.number !== number) throw new Error(`asked for block ${number}, got ${b.number}`);
                    return b.hash;
                }),
            );
            if (new Set(hashes.values()).size > 1) {
                return done("inconsistent", `block ${number} hash differs: ${[...hashes].map(([u, h]) => `${label(u)}=${h}`).join(", ")}`);
            }
            const [blockHash] = quorum(hashes, `block ${number} hash`);
            const chain = { chainId: BASE_CHAIN_ID, blockNumber: number.toString(), blockHash, providers: [...hashes.keys()].map(label) };

            const cond = conditionId.slice(2);
            const states = await settle([...hashes.keys()], async (u) => {
                const read = (data: string) => call(u, "eth_call", [{ to: LIMITLESS_CTF, data }, tag], uint256);
                const den = await read(`0x${SEL_PAYOUT_DENOMINATOR}${cond}`);
                const n0 = await read(`0x${SEL_PAYOUT_NUMERATORS}${cond}${word(0n)}`);
                const n1 = await read(`0x${SEL_PAYOUT_NUMERATORS}${cond}${word(1n)}`);
                return [den, n0, n1] as const;
            });
            if (new Set([...states.values()].map((s) => s.join("/"))).size > 1) {
                return done("inconsistent", `CTF payouts differ across providers at block ${number}`, chain);
            }
            const [[denominator, n0, n1]] = quorum(states, "CTF payout reads");
            chain.providers = [...states.keys()].map(label);
            const payout = { numerators: [n0, n1], denominator };
            const at = `at finalized block ${number} (${blockHash}) on ${chain.providers.length} providers`;
            if (denominator === 0n) {
                // The chain wins: an API that already says RESOLVED is reported, never followed.
                const s = market.sourceStatus;
                return done(s === "RESOLVED" ? "inconsistent" : "unresolved", `payoutDenominator is 0 ${at}; API status=${s ?? "n/a"}`, chain, payout);
            }
            const vector = canonicalVector(n0, n1, denominator);
            if (!vector) return done("unsupported", `payout [${n0},${n1}]/${denominator} is not all-yes, all-no or 50-50 ${at}`, chain, payout);
            const winner = n0 === n1 ? "50-50" : market.outcomes[n0 > n1 ? 0 : 1];
            return { ...done("final", `payout [${n0},${n1}]/${denominator} (${winner}) ${at}`, chain, payout), vector };
        },

        async screenResolved(markets) {
            const conds = [...new Set(markets.filter((m) => !identityProblem(m, allow)).map((m) => m.protocol.conditionId))];
            if (conds.length === 0) return [];
            const batch = conds.map((c, id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: LIMITLESS_CTF, data: `0x${SEL_PAYOUT_DENOMINATOR}${c.slice(2)}` }, "finalized"] }));
            const errors: string[] = [];
            const answers = await settle(rpcUrls, async (u) => {
                try {
                    const body = await post(u, batch);
                    if (!Array.isArray(body)) throw new Error("JSON-RPC batch not supported");
                    const byId = new Map(body.filter(isRec).map((r) => [r.id, r]));
                    return conds.map((_, id) => {
                        const r = byId.get(id);
                        if (!r || r.error !== undefined) throw new Error(`batch item ${id}: ${r ? JSON.stringify(r.error).slice(0, 120) : "missing"}`);
                        return uint256(r.result) !== 0n;
                    });
                } catch (e) {
                    errors.push(`${label(u)}: ${errMsg(e)}`);
                    throw e;
                }
            });
            if (answers.size < minProviders) throw new Error(`resolution screen: ${answers.size}/${minProviders} providers answered; ${errors.join("; ")}`);
            return conds.filter((_, i) => [...answers.values()].filter((resolved) => resolved[i]).length >= minProviders);
        },

        verifyFinalResolution(market, evidence, profile) {
            const fail = (reason: string) => ({ ok: false as const, reason });
            if (profile !== LIMITLESS_PROFILE) return fail(`unsupported profile ${profile}`);
            const bad = identityProblem(market, allow);
            if (bad) return fail(`${bad.code}: ${bad.reason}`);
            if (evidence.status !== "final") return fail(`status is ${evidence.status}`);
            if (!evidence.vector || !isSupportedVector(evidence.vector)) return fail("vector is not [1,0]/1, [0,1]/1 or [1,1]/2");
            const c = evidence.chain;
            if (!c || c.chainId !== BASE_CHAIN_ID) return fail(`evidence is not from chain ${BASE_CHAIN_ID}`);
            if (!/^[1-9]\d*$/.test(c.blockNumber) || !BYTES32.test(c.blockHash)) return fail("block number/hash missing or malformed");
            const providers = new Set(c.providers).size;
            if (providers < minProviders) return fail(`${providers} providers < ${minProviders}`);
            if (evidence.reads?.conditionId !== market.protocol.conditionId) return fail("evidence was read for a different condition");
            const raw = evidence.reads?.payout as { numerators: bigint[]; denominator: bigint } | undefined;
            const expected = raw?.numerators.length === 2 ? canonicalVector(raw.numerators[0]!, raw.numerators[1]!, raw.denominator) : null;
            if (!expected || canonicalJson(expected) !== canonicalJson(evidence.vector)) return fail("vector does not match the chain payout read");
            return { ok: true };
        },
    };
}
