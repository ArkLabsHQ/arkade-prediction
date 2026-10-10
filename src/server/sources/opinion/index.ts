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

export const OPINION_PROFILE = "opinion-ctf-bnb-binary";
export const BNB_CHAIN_ID = 56;
export const OPINION_CTF = "0xad1a38cec043e70e83a3ec30443db285ed10d774";
/**
 * Opinion's CTF oracle adapters (v1.3.0, one owner and guardian), read on BNB 2026-10-10: `resolve` reverts
 * `UnauthorizedCaller` for anyone but Opinion's implementation, and the adapter has no way to create a question.
 * 0xaca2…491e, a Chainlink price resolver with an operator override, is left out.
 */
export const DEFAULT_ORACLES = ["0x2e5466c11531fbd91b44cb196e3e0debfec8ee31", "0x12521af17f36d533de35347ce4e959cbbfd07034"];
// ponytail: cast until "opinion" joins ProviderName in types.ts.
const PROVIDER: ProviderName = "opinion";
const DEFAULT_API_URL = "https://openapi.opinion.trade/openapi";
const VERSION = "ctf";
const PAGE_SIZE = 20;
const SEL_PAYOUT_DENOMINATOR = "dd34de67";
const SEL_PAYOUT_NUMERATORS = "0504c814";
const SEL_OUTCOME_SLOT_COUNT = "d42dc0c2";
/** The API allows 5 requests a second (x-ratelimit-limit-second); 429s wait out its one-second window. */
const MIN_INTERVAL_MS = 250;
const RATE_LIMIT_BACKOFF_MS = 1000;
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 250;
const HEADERS = { accept: "application/json", "user-agent": "arkade-prediction/0.1" };
const STATUS = { activated: 2, resolving: 3, resolved: 4, deleted: 6 };

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SOURCE_ID = /^(\d{1,12})(?:-(\d{1,12}))?$/;
const AMOUNT = /^\d{1,15}(\.\d{1,30})?$/;
const IMAGE_HOST = "images.opinion.trade";

export interface OpinionProviderOptions {
    apiUrl?: string;
    rpcUrls: string[];
    resolverAllowlist: string[];
    fetch?: typeof fetch;
    timeoutMs?: number;
    minProviders?: number;
    minIntervalMs?: number;
}

type Rec = Record<string, unknown>;
type Problem = { code: string; reason: string };
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
const slugOf = (v: unknown) => str(v, 64).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const idOf = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? String(v) : null);

/** The API writes ids without 0x. */
function bytes32Of(v: unknown): string | null {
    const s = typeof v === "string" ? v.toLowerCase().replace(/^0x/, "") : "";
    return BYTES32.test(`0x${s}`) ? `0x${s}` : null;
}

function isoSeconds(v: unknown): string | null {
    return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? new Date(v * 1000).toISOString() : null;
}

/** Opinion writes "YES"/"NO"; sports markets name the two sides instead. */
function labelOf(v: unknown): string {
    const s = str(v, 100).trim();
    return /^yes$/i.test(s) ? "Yes" : /^no$/i.test(s) ? "No" : s;
}

function imageOf(v: unknown): string | null {
    if (typeof v !== "string" || v.length > 500 || !URL.canParse(v)) return null;
    const u = new URL(v);
    return u.protocol === "https:" && u.host === IMAGE_HOST ? u.href : null;
}

/** `raw` is a binary market's detail; `parent`, when set, the categorical market it is a child of. */
function normalize(raw: Rec, parent: Rec | null, allow: ReadonlySet<string>, fetchedAt: string): SourceMarket {
    const id = idOf(raw.marketId);
    const parentId = parent ? idOf(parent.marketId) : null;
    if (!id || (parent && !parentId)) throw new Error("opinion market has no valid id");
    if (raw.marketType !== 0) throw new Error(`opinion market ${id} is not binary`);
    const title = str(raw.marketTitle, 400).trim();
    const parentTitle = parent ? str(parent.marketTitle, 400).trim() : "";
    const question = parent ? `${parentTitle} (${title})` : title;
    if (!title || (parent && !parentTitle)) throw new Error(`opinion market ${id} has no title`);
    const conditionId = bytes32Of(raw.conditionId) ?? "";
    const questionId = bytes32Of(raw.questionId) ?? "";
    const status = typeof raw.status === "number" ? raw.status : 0;
    const resolution = isRec(raw.resolution) ? str(raw.resolution.phase, 32) : "";
    const core = {
        provider: PROVIDER,
        sourceId: parent ? `${parentId}-${id}` : id,
        slug: str(raw.slug, 200),
        url: parent ? `https://app.opinion.trade/detail?topicId=${parentId}&type=multi` : `https://app.opinion.trade/detail?topicId=${id}`,
        question: question.slice(0, 500),
        // Children carry no rules or close time of their own.
        description: str(raw.rules, 20_000) || str(parent?.rules, 20_000),
        resolutionSource: "",
        outcomes: [labelOf(raw.yesLabel), labelOf(raw.noLabel)],
        endDate: isoSeconds(raw.cutoffAt) ?? isoSeconds(parent?.cutoffAt),
        tags: [...new Set((Array.isArray(raw.labels) ? raw.labels : Array.isArray(parent?.labels) ? parent.labels : []).slice(0, 10).map(slugOf).filter(Boolean))],
        active: status === STATUS.activated,
        closed: status !== STATUS.activated && status !== 1,
        archived: status === STATUS.deleted,
        sourceStatus: `${str(raw.statusEnum, 32).toLowerCase()}${resolution ? `:${resolution}` : ""}` || null,
        protocol: {
            version: VERSION,
            chainId: Number(raw.chainId) || 0,
            negRisk: false,
            // The adapter is never named by the API: it is the allowlisted address the conditionId derives from.
            resolver: [...allow].find((a) => conditionId && questionId && deriveConditionId(a, questionId) === conditionId) ?? null,
            conditionId,
            questionId,
            settlementContract: OPINION_CTF,
        },
    };
    const volume24h = typeof raw.volume24h === "string" && AMOUNT.test(raw.volume24h) ? Number(raw.volume24h) : null;
    const event = parent ? { title: parentTitle.slice(0, 200), slug: str(parent.slug, 200) } : null;
    return { ...core, referencePrices: null, image: imageOf(raw.thumbnailUrl), event, volume24h, gameStartTime: null, versionHash: sha256Hex(canonicalJson(core)), fetchedAt };
}

function identityProblem(m: SourceMarket, allow: ReadonlySet<string>): Problem | null {
    const p = m.protocol;
    if (m.provider !== PROVIDER || p.version !== VERSION || p.chainId !== BNB_CHAIN_ID || p.negRisk || p.settlementContract !== OPINION_CTF) {
        return { code: "unsupported-version", reason: `${m.provider} ${p.version} on chain ${p.chainId} is not Opinion's CTF on BNB Chain` };
    }
    const [a, b] = m.outcomes;
    if (!SOURCE_ID.test(m.sourceId) || m.outcomes.length !== 2 || !a || !b || a === b) {
        return { code: "not-binary", reason: `outcomes ${JSON.stringify(m.outcomes).slice(0, 200)}` };
    }
    if (!BYTES32.test(p.conditionId) || !BYTES32.test(p.questionId)) return { code: "no-condition", reason: "conditionId or questionId missing" };
    if (!p.resolver || !allow.has(p.resolver)) return { code: "unknown-resolver", reason: `conditionId derives from no allowlisted oracle (resolver ${p.resolver ?? "missing"})` };
    if (deriveConditionId(p.resolver, p.questionId) !== p.conditionId) {
        return { code: "condition-mismatch", reason: "conditionId != keccak256(resolver, questionId, 2)" };
    }
    return null;
}

function isSupportedVector(v: { numerators: readonly bigint[]; denominator: bigint }): boolean {
    return (
        v.numerators.length === 2 &&
        Object.values(BINARY_VECTORS).some((r) => r.denominator === v.denominator && r.numerators.every((n, i) => n === v.numerators[i]))
    );
}

function quantity(r: unknown): bigint {
    if (typeof r !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(r)) throw new Error(`not a hex quantity: ${String(r).slice(0, 80)}`);
    return BigInt(r);
}

/** Strict uint256 return word: "0x" or a short value is a failed read, never zero. */
function uint256(r: unknown): bigint {
    if (typeof r !== "string" || !/^0x[0-9a-f]{64}$/i.test(r)) throw new Error(`not a uint256 word: ${String(r).slice(0, 80)}`);
    return BigInt(r);
}

function header(r: unknown): { number: bigint; hash: string } {
    const hash = isRec(r) && typeof r.hash === "string" && BYTES32.test(r.hash.toLowerCase()) ? r.hash.toLowerCase() : null;
    if (!isRec(r) || !hash) throw new Error("malformed block");
    return { number: quantity(r.number), hash };
}

/** Chain facts at one finalized block only, so independent attestors reading that block sign the same digest. */
export function evidenceRecord(market: SourceMarket, evidence: ResolutionEvidence) {
    if (evidence.status !== "final" || !evidence.chain || !evidence.vector) throw new Error("evidence is not a final resolution");
    return {
        profile: OPINION_PROFILE, chainId: evidence.chain.chainId, ctf: OPINION_CTF, sourceId: market.sourceId,
        conditionId: market.protocol.conditionId, questionId: market.protocol.questionId, resolver: market.protocol.resolver,
        block: { number: evidence.chain.blockNumber, hash: evidence.chain.blockHash },
        payout: { numerators: evidence.vector.numerators.map(String), denominator: evidence.vector.denominator.toString() },
    };
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (e) {
            const limited = e instanceof HttpError && e.status === 429;
            const permanent = e instanceof HttpError && e.status < 500 && !limited;
            if (permanent || attempt >= MAX_RETRIES) throw e;
            await sleep(limited ? RATE_LIMIT_BACKOFF_MS * 2 ** attempt : RETRY_BASE_MS * 2 ** attempt * (0.5 + Math.random()));
        }
    }
}

/** Runs fn per provider in parallel; failed providers are dropped, order follows `urls`. */
async function settle<T>(urls: string[], fn: (url: string) => Promise<T>): Promise<Map<string, T>> {
    const out = await Promise.all(urls.map((u) => fn(u).then((v): [string, T] => [u, v], () => null)));
    return new Map(out.filter((x) => x !== null));
}

export function createOpinionProvider(opts: OpinionProviderOptions): MarketSourceProvider {
    const apiUrl = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, "");
    const rpcUrls = [...new Set(opts.rpcUrls)];
    const minProviders = opts.minProviders ?? 2;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const minIntervalMs = opts.minIntervalMs ?? MIN_INTERVAL_MS;
    const doFetch = opts.fetch ?? fetch;
    const allow = new Set(opts.resolverAllowlist.map((a) => a.toLowerCase()));
    if (!Number.isInteger(minProviders) || minProviders < 2) throw new Error("minProviders must be an integer >= 2");
    for (const a of allow) if (!ADDRESS.test(a)) throw new Error(`invalid resolver address ${a}`);
    // RPC URLs often embed API keys: logs, details and evidence name a provider only by "host#n".
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

    // Reserved synchronously, so concurrent callers queue at the API's rate instead of bursting into 429s.
    let nextSlot = 0;
    async function api(path: string): Promise<Rec> {
        const body = await withRetry(async () => {
            const now = Date.now();
            const at = Math.max(now, nextSlot);
            nextSlot = at + minIntervalMs;
            if (at > now) await sleep(at - now);
            return getJson(`${apiUrl}${path}`);
        });
        if (!isRec(body) || body.errno !== 0 || !isRec(body.result)) throw new Error(`opinion ${path}: ${isRec(body) ? str(body.errmsg, 120) || `errno ${body.errno}` : "malformed"}`);
        return body.result;
    }
    const detail = async (path: string) => {
        const data = (await api(path)).data;
        if (!isRec(data)) throw new Error(`opinion ${path}: no market`);
        return data;
    };

    async function definition(sourceId: string): Promise<{ market: SourceMarket; raw: Rec }> {
        const [, first, child] = SOURCE_ID.exec(sourceId) ?? [];
        if (!first) throw new Error(`invalid Opinion market id ${JSON.stringify(sourceId.slice(0, 40))}`);
        const parent = child ? await detail(`/market/categorical/${first}`) : null;
        const raw = await detail(`/market/${child ?? first}`);
        // The child's own record names no parent: membership comes from the parent's list, condition and all.
        const listed = parent && Array.isArray(parent.childMarkets) ? parent.childMarkets.find((c) => isRec(c) && idOf(c.marketId) === child) : null;
        if (parent && (!isRec(listed) || bytes32Of(listed.conditionId) !== bytes32Of(raw.conditionId))) throw new Error(`opinion market ${child} is not a child of ${first}`);
        const market = normalize(raw, parent, allow, new Date().toISOString());
        if (market.sourceId !== sourceId) throw new Error(`opinion returned market ${market.sourceId} for ${sourceId}`);
        return { market, raw };
    }

    const post = (provider: string, body: unknown) =>
        getJson(provider, { method: "POST", headers: { ...HEADERS, "content-type": "application/json" }, body: JSON.stringify(body) }, label(provider));

    async function rpc<T>(log: RpcCall[], provider: string, method: string, params: unknown[], decode: (r: unknown) => T): Promise<T> {
        try {
            const [raw, value] = await withRetry(async () => {
                const body = await post(provider, { jsonrpc: "2.0", id: 1, method, params });
                if (!isRec(body) || body.id !== 1) throw new Error("malformed JSON-RPC response");
                if (body.error !== undefined) throw new Error(`JSON-RPC error ${JSON.stringify(body.error)}`);
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

    return {
        name: PROVIDER,
        profile: OPINION_PROFILE,
        evidenceRecord,

        async discoverMarkets(cursor, limit, opts = {}) {
            const tag = opts.tag?.toLowerCase();
            if (tag !== undefined && !/^[a-z0-9-]{1,60}$/.test(tag)) throw new Error(`invalid Opinion label ${JSON.stringify(tag.slice(0, 40))}`);
            const page = Number(cursor ?? 1);
            if (!Number.isSafeInteger(page) || page < 1) throw new Error(`invalid Opinion cursor ${JSON.stringify(String(cursor).slice(0, 40))}`);
            const size = Math.min(PAGE_SIZE, Math.max(1, Math.trunc(limit) || 1));
            // marketType 2 lists binary and categorical markets together; sortBy 5 is 24h volume, descending.
            const q = new URLSearchParams({ status: "activated", marketType: "2", sortBy: "5", limit: String(size), page: String(page) });
            const body = await api(`/market?${q}`);
            if (!Array.isArray(body.list)) throw new Error("unexpected /market response");
            const fetchedAt = new Date().toISOString();
            const markets: SourceMarket[] = [];
            // The list leaves conditionId empty, and a child's 24h volume is only on its own record.
            for (const row of body.list) {
                try {
                    const id = isRec(row) ? idOf(row.marketId) : null;
                    if (!id || !isRec(row)) continue;
                    if (tag && !(Array.isArray(row.labels) && row.labels.map(slugOf).includes(tag))) continue;
                    if (row.marketType !== 1) {
                        markets.push(normalize(await detail(`/market/${id}`), null, allow, fetchedAt));
                        continue;
                    }
                    const parent = await detail(`/market/categorical/${id}`);
                    for (const c of Array.isArray(parent.childMarkets) ? parent.childMarkets : []) {
                        const cid = isRec(c) && c.status === STATUS.activated ? idOf(c.marketId) : null;
                        const raw = cid ? await detail(`/market/${cid}`).catch(() => null) : null;
                        if (raw && isRec(c) && bytes32Of(raw.conditionId) === bytes32Of(c.conditionId)) markets.push(normalize(raw, parent, allow, fetchedAt));
                    }
                } catch {
                    // a malformed entry is skipped, not fatal to the page
                }
            }
            const total = typeof body.total === "number" ? body.total : 0;
            return { markets: markets.sort((x, y) => (y.volume24h ?? 0) - (x.volume24h ?? 0)), next: body.list.length === size && page * size < total ? String(page + 1) : null };
        },

        async fetchMarketDefinition(sourceId) {
            return (await definition(sourceId)).market;
        },

        evaluateEligibility(market: SourceMarket, policy: EligibilityPolicy, now: Date): Eligibility {
            const no = (code: string, reason: string): Eligibility => ({ eligible: false, code, reason });
            if (!policy.profiles.includes(OPINION_PROFILE)) return no("profile-disabled", `${OPINION_PROFILE} is not enabled`);
            const bad = identityProblem(market, allow);
            if (bad) return no(bad.code, bad.reason);
            if (!market.active || market.closed || market.archived) return no("closed", `status ${market.sourceStatus ?? "missing"}`);
            const end = market.endDate ? Date.parse(market.endDate) : NaN;
            const t = now.getTime();
            if (!(end >= t + policy.minHorizonSeconds * 1000 && end <= t + policy.maxHorizonSeconds * 1000)) {
                return no("horizon", `endDate ${market.endDate ?? "missing"} outside [now+${policy.minHorizonSeconds}s, now+${policy.maxHorizonSeconds}s]`);
            }
            const wanted = policy.tags.map((tag) => tag.toLowerCase());
            if (wanted.length > 0 && !market.tags.some((tag) => wanted.includes(tag))) return no("tag-filter", "no allowed tag");
            return { eligible: true, profile: OPINION_PROFILE };
        },

        async vetSource(market) {
            const no = (reason: string) => ({ ok: false as const, reason });
            const bad = identityProblem(market, allow);
            if (bad) return no(`${bad.code}: ${bad.reason}`);
            // The derivation binds the oracle; the chain must also hold that condition, prepared with two slots.
            const log: RpcCall[] = [];
            const data = `0x${SEL_OUTCOME_SLOT_COUNT}${market.protocol.conditionId.slice(2)}`;
            const answers = await settle(rpcUrls, (u) => rpc(log, u, "eth_call", [{ to: OPINION_CTF, data }, "finalized"], uint256));
            if (answers.size < minProviders) {
                const errors = log.filter((c) => c.error).map((c) => `${c.provider}: ${c.error}`);
                return no(`outcome slot count: ${answers.size}/${minProviders} providers answered; ${errors.join("; ")}`);
            }
            const slots = new Set(answers.values());
            if (slots.size > 1) return no(`outcome slot count differs across providers: ${[...answers].map(([u, n]) => `${label(u)}=${n}`).join(", ")}`);
            const [n] = [...slots];
            if (n !== 2n) return no(`condition ${market.protocol.conditionId} has ${n} outcome slots on chain, not 2`);
            return { ok: true as const };
        },

        async fetchResolutionEvidence(market, opts = {}) {
            const observedAt = new Date().toISOString();
            const bad = identityProblem(market, allow);
            if (bad) return { status: "unsupported", detail: `${bad.code}: ${bad.reason}`, observedAt };
            const { conditionId, questionId, resolver } = market.protocol;
            // Cross-check only, never evidence: an unreachable API leaves the chain read to decide alone.
            const live = await definition(market.sourceId).catch(() => null);
            const apiStatus = live?.raw.status ?? null;
            const result = live && typeof live.raw.resultTokenId === "string" && live.raw.resultTokenId ? live.raw.resultTokenId : null;
            const apiResult = result === null ? null : result === live?.raw.yesTokenId ? 0 : result === live?.raw.noTokenId ? 1 : null;
            const logs = new Map(rpcUrls.map((u) => [u, [] as RpcCall[]]));
            const call = <T>(u: string, method: string, params: unknown[], decode: (r: unknown) => T) => rpc(logs.get(u) ?? [], u, method, params, decode);
            const calls = () => [...logs.values()].flat();
            const done = (status: ResolutionStatus, detail: string, chain?: ResolutionEvidence["chain"], payout?: { numerators: bigint[]; denominator: bigint }): ResolutionEvidence => ({
                status,
                detail,
                ...(chain ? { chain } : {}),
                reads: { profile: OPINION_PROFILE, ctf: OPINION_CTF, conditionId, questionId, resolver, apiStatus: live?.market.sourceStatus ?? market.sourceStatus, payout, calls: calls() },
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
            const offChain = [...heads].filter(([, h]) => h.chainId !== BigInt(BNB_CHAIN_ID)).map(([u]) => label(u));
            if (offChain.length > 0) return done("inconsistent", `not on chain ${BNB_CHAIN_ID}: ${offChain.join(", ")}`);
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
            const chain = { chainId: BNB_CHAIN_ID, blockNumber: number.toString(), blockHash, providers: [...hashes.keys()].map(label) };

            const cond = conditionId.slice(2);
            const states = await settle([...hashes.keys()], async (u) => {
                const read = (data: string) => call(u, "eth_call", [{ to: OPINION_CTF, data }, tag], uint256);
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
            const s = live?.market.sourceStatus ?? market.sourceStatus ?? "n/a";
            if (denominator === 0n) {
                if (apiStatus === STATUS.resolved) return done("inconsistent", `opinion reports ${s} but payoutDenominator is 0 ${at}`, chain, payout);
                // Opinion proposes a result, holds a dispute window, then reports to the CTF once.
                const status = /disput/.test(s) ? "disputed" : apiStatus === STATUS.resolving || /:/.test(s) ? "proposed" : "unresolved";
                return done(status, `payoutDenominator is 0 ${at}; opinion status=${s}`, chain, payout);
            }
            if (!isSupportedVector(payout)) {
                return done("unsupported", `payout [${n0},${n1}]/${denominator} is not [1,0]/1, [0,1]/1 or [1,1]/2 ${at}`, chain, payout);
            }
            if (n0 !== n1 && apiResult !== null && apiResult !== (n0 > n1 ? 0 : 1)) {
                return done("inconsistent", `payout [${n0},${n1}]/${denominator} ${at} but opinion's result token is ${market.outcomes[apiResult]}`, chain, payout);
            }
            const winner = n0 === n1 ? "50-50" : market.outcomes[n0 > n1 ? 0 : 1];
            return { ...done("final", `payout [${n0},${n1}]/${denominator} (${winner}) ${at}`, chain, payout), vector: payout };
        },

        async screenResolved(markets) {
            const conds = [...new Set(markets.filter((m) => !identityProblem(m, allow)).map((m) => m.protocol.conditionId))];
            if (conds.length === 0) return [];
            const batch = conds.map((c, id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: OPINION_CTF, data: `0x${SEL_PAYOUT_DENOMINATOR}${c.slice(2)}` }, "finalized"] }));
            const errors: string[] = [];
            // No retries: one request per provider per pass is the budget; the next pass retries.
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
            if (profile !== OPINION_PROFILE) return fail(`unsupported profile ${profile}`);
            const bad = identityProblem(market, allow);
            if (bad) return fail(`${bad.code}: ${bad.reason}`);
            if (evidence.status !== "final") return fail(`status is ${evidence.status}`);
            if (!evidence.vector || !isSupportedVector(evidence.vector)) return fail("vector is not [1,0]/1, [0,1]/1 or [1,1]/2");
            const c = evidence.chain;
            if (!c || c.chainId !== BNB_CHAIN_ID) return fail(`evidence is not from chain ${BNB_CHAIN_ID}`);
            if (!/^[1-9]\d*$/.test(c.blockNumber) || !BYTES32.test(c.blockHash)) return fail("block number/hash missing or malformed");
            const providers = new Set(c.providers).size;
            if (providers < minProviders) return fail(`${providers} providers < ${minProviders}`);
            if (evidence.reads?.conditionId !== market.protocol.conditionId) return fail("evidence was read for a different condition");
            return { ok: true };
        },
    };
}
