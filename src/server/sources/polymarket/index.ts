import { keccak_256 } from "@noble/hashes/sha3.js";
import { hex } from "@scure/base";
import { canonicalJson, concatBytes, sha256Hex } from "../../../core/encoding.js";
import { BINARY_VECTORS } from "../../../core/payout.js";
import type {
    Eligibility,
    EligibilityPolicy,
    MarketSourceProvider,
    ResolutionEvidence,
    ResolutionStatus,
    SourceMarket,
} from "../types.js";

export const PROFILE = "polymarket-ctf-v1-binary";
export const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
export const POLYGON_CHAIN_ID = 137;
const DEFAULT_GAMMA_URL = "https://gamma-api.polymarket.com";
const SEL_PAYOUT_DENOMINATOR = "dd34de67";
const SEL_PAYOUT_NUMERATORS = "0504c814";
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 250;
const HEADERS = { accept: "application/json", "user-agent": "arkade-prediction/0.1" };

const BYTES32 = /^0x[0-9a-f]{64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SOURCE_ID = /^\d{1,20}$/;
const PRICE = /^(0(\.\d{1,64})?|1(\.0{1,64})?)$/;

export interface PolymarketProviderOptions {
    gammaUrl?: string;
    rpcUrls: string[];
    resolverAllowlist: string[];
    fetch?: typeof fetch;
    timeoutMs?: number;
    minProviders?: number;
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

function hexOf(v: unknown, re: RegExp): string | null {
    const s = typeof v === "string" ? v.toLowerCase() : "";
    return re.test(s) ? s : null;
}

/** keccak256(abi.encodePacked(address oracle, bytes32 questionId, uint256 2)), CTHelpers.getConditionId. */
export function deriveConditionId(oracle: string, questionId: string): string {
    const packed = concatBytes(hex.decode(oracle.slice(2)), hex.decode(questionId.slice(2)), hex.decode(word(2n)));
    return `0x${hex.encode(keccak_256(packed))}`;
}

function stringArray(v: unknown, maxLen: number): string[] | null {
    let arr: unknown = v;
    if (typeof v === "string") {
        try {
            arr = JSON.parse(v);
        } catch {
            return null;
        }
    }
    if (!Array.isArray(arr) || arr.length > 64 || !arr.every((x) => typeof x === "string")) return null;
    return arr.map((x: string) => x.slice(0, maxLen));
}

function tagsOf(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    const slugs = v.map((t) => (isRec(t) && typeof t.slug === "string" ? t.slug.trim().toLowerCase().slice(0, 64) : ""));
    return [...new Set(slugs.filter(Boolean))].sort().slice(0, 20);
}

function isoDate(v: unknown): string | null {
    const t = typeof v === "string" ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function normalize(raw: unknown, fetchedAt: string): SourceMarket {
    if (!isRec(raw)) throw new Error("gamma market is not an object");
    const sourceId = typeof raw.id === "number" ? String(raw.id) : raw.id;
    if (typeof sourceId !== "string" || !SOURCE_ID.test(sourceId)) throw new Error("gamma market has no valid id");
    const slug = str(raw.slug, 200);
    const outcomes = stringArray(raw.outcomes, 100) ?? [];
    const prices = stringArray(raw.outcomePrices, 70);
    const core = {
        provider: "polymarket" as const,
        sourceId,
        slug,
        // /markets/{id} carries no event slug; /market/<slug> redirects to the canonical event page.
        url: slug ? `https://polymarket.com/market/${encodeURIComponent(slug)}` : "",
        question: str(raw.question, 500),
        description: str(raw.description, 20_000),
        resolutionSource: str(raw.resolutionSource, 1_000),
        outcomes,
        endDate: isoDate(raw.endDate),
        tags: tagsOf(raw.tags),
        active: raw.active === true,
        closed: raw.closed !== false,
        archived: raw.archived !== false,
        sourceStatus: typeof raw.umaResolutionStatus === "string" ? raw.umaResolutionStatus.slice(0, 32) : null,
        protocol: {
            version: str(raw.version, 16),
            chainId: POLYGON_CHAIN_ID,
            // A missing flag (2022 markets) is unknown, not false.
            negRisk: !(raw.negRisk === false && raw.negRiskOther !== true),
            resolver: hexOf(raw.resolvedBy, ADDRESS),
            conditionId: hexOf(raw.conditionId, BYTES32) ?? "",
            questionId: hexOf(raw.questionID, BYTES32) ?? "",
            settlementContract: CTF_ADDRESS,
        },
    };
    const referencePrices =
        prices && outcomes.length > 0 && prices.length === outcomes.length && prices.every((p) => PRICE.test(p))
            ? outcomes.map((outcome, i) => ({ outcome, price: prices[i] ?? "" }))
            : null;
    return { ...core, referencePrices, versionHash: sha256Hex(canonicalJson(core)), fetchedAt };
}

function identityProblem(m: SourceMarket, allow: ReadonlySet<string>): Problem | null {
    const p = m.protocol;
    if (p.version !== "v1" || p.chainId !== POLYGON_CHAIN_ID || p.settlementContract !== CTF_ADDRESS) {
        return { code: "unsupported-version", reason: `version "${p.version}" on chain ${p.chainId} is not legacy CTF v1 on Polygon` };
    }
    if (p.negRisk) return { code: "neg-risk", reason: "negRisk/negRiskOther set or missing" };
    const [a, b] = m.outcomes;
    if (m.outcomes.length !== 2 || !a || !b || a === b) {
        return { code: "not-binary", reason: `outcomes ${JSON.stringify(m.outcomes).slice(0, 200)}` };
    }
    if (!p.resolver || !allow.has(p.resolver)) {
        return { code: "unknown-resolver", reason: `resolver ${p.resolver ?? "missing"} is not allowlisted` };
    }
    if (!BYTES32.test(p.questionId) || deriveConditionId(p.resolver, p.questionId) !== p.conditionId) {
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
    const hash = isRec(r) ? hexOf(r.hash, BYTES32) : null;
    if (!isRec(r) || !hash) throw new Error("malformed block");
    return { number: quantity(r.number), hash };
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

/** Runs fn per provider in parallel; failed providers are dropped, order follows `urls`. */
async function settle<T>(urls: string[], fn: (url: string) => Promise<T>): Promise<Map<string, T>> {
    const out = await Promise.all(urls.map((u) => fn(u).then((v): [string, T] => [u, v], () => null)));
    return new Map(out.filter((x) => x !== null));
}

export function createPolymarketProvider(opts: PolymarketProviderOptions): MarketSourceProvider {
    const gammaUrl = (opts.gammaUrl ?? DEFAULT_GAMMA_URL).replace(/\/+$/, "");
    const rpcUrls = [...new Set(opts.rpcUrls)];
    const minProviders = opts.minProviders ?? 2;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const doFetch = opts.fetch ?? fetch;
    const allow = new Set(opts.resolverAllowlist.map((a) => a.toLowerCase()));
    if (!Number.isInteger(minProviders) || minProviders < 2) throw new Error("minProviders must be an integer >= 2");
    for (const a of allow) if (!ADDRESS.test(a)) throw new Error(`invalid resolver address ${a}`);

    async function getJson(url: string, init: RequestInit = { headers: HEADERS }): Promise<unknown> {
        const res = await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) throw new HttpError(res.status, url);
        return res.json();
    }

    async function rpc<T>(log: RpcCall[], provider: string, method: string, params: unknown[], decode: (r: unknown) => T): Promise<T> {
        try {
            const [raw, value] = await withRetry(async () => {
                const body = await getJson(provider, {
                    method: "POST",
                    headers: { ...HEADERS, "content-type": "application/json" },
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
                });
                if (!isRec(body) || body.id !== 1) throw new Error("malformed JSON-RPC response");
                if (body.error !== undefined) throw new Error(`JSON-RPC error ${JSON.stringify(body.error)}`);
                return [body.result, decode(body.result)] as const;
            });
            // Block bodies are trimmed to identity fields; full tx lists would bloat the evidence digest input.
            const result = isRec(raw) ? { number: raw.number, hash: raw.hash, parentHash: raw.parentHash, timestamp: raw.timestamp } : raw;
            log.push({ provider, method, params, result });
            return value;
        } catch (e) {
            log.push({ provider, method, params, error: errMsg(e) });
            throw e;
        }
    }

    return {
        name: "polymarket",

        async discoverMarkets(cursor, limit) {
            const q = new URLSearchParams({ closed: "false", include_tag: "true", limit: String(Math.min(100, Math.max(1, Math.trunc(limit) || 1))) });
            if (cursor) q.set("after_cursor", cursor);
            const body = await withRetry(() => getJson(`${gammaUrl}/markets/keyset?${q}`));
            if (!isRec(body) || !Array.isArray(body.markets)) throw new Error("unexpected /markets/keyset response");
            const fetchedAt = new Date().toISOString();
            const markets = body.markets.flatMap((m: unknown) => {
                try {
                    return [normalize(m, fetchedAt)];
                } catch {
                    return [];
                }
            });
            return { markets, next: typeof body.next_cursor === "string" && body.next_cursor ? body.next_cursor : null };
        },

        async fetchMarketDefinition(sourceId) {
            if (!SOURCE_ID.test(sourceId)) throw new Error(`invalid Polymarket market id ${JSON.stringify(sourceId.slice(0, 40))}`);
            const body = await withRetry(() => getJson(`${gammaUrl}/markets/${sourceId}?include_tag=true`));
            const market = normalize(body, new Date().toISOString());
            if (market.sourceId !== sourceId) throw new Error(`gamma returned market ${market.sourceId} for ${sourceId}`);
            return market;
        },

        evaluateEligibility(market: SourceMarket, policy: EligibilityPolicy, now: Date): Eligibility {
            const no = (code: string, reason: string): Eligibility => ({ eligible: false, code, reason });
            if (!policy.profiles.includes(PROFILE)) return no("profile-disabled", `${PROFILE} is not enabled`);
            const bad = identityProblem(market, allow);
            if (bad) return no(bad.code, bad.reason);
            if (market.closed || market.archived) return no("closed", market.archived ? "archived" : "closed");
            const end = market.endDate ? Date.parse(market.endDate) : NaN;
            const t = now.getTime();
            if (!(end >= t + policy.minHorizonSeconds * 1000 && end <= t + policy.maxHorizonSeconds * 1000)) {
                return no("horizon", `endDate ${market.endDate ?? "missing"} outside [now+${policy.minHorizonSeconds}s, now+${policy.maxHorizonSeconds}s]`);
            }
            const wanted = policy.tags.map((tag) => tag.toLowerCase());
            if (wanted.length > 0 && !market.tags.some((tag) => wanted.includes(tag))) return no("tag-filter", "no allowed tag");
            return { eligible: true, profile: PROFILE };
        },

        async fetchResolutionEvidence(market) {
            const observedAt = new Date().toISOString();
            const bad = identityProblem(market, allow);
            if (bad) return { status: "unsupported", detail: `${bad.code}: ${bad.reason}`, observedAt };
            const { conditionId, questionId, resolver } = market.protocol;
            const logs = new Map(rpcUrls.map((u) => [u, [] as RpcCall[]]));
            const call = <T>(u: string, method: string, params: unknown[], decode: (r: unknown) => T) =>
                rpc(logs.get(u) ?? [], u, method, params, decode);
            const calls = () => [...logs.values()].flat();
            const done = (
                status: ResolutionStatus,
                detail: string,
                chain?: ResolutionEvidence["chain"],
                payout?: { numerators: bigint[]; denominator: bigint },
            ): ResolutionEvidence => ({
                status,
                detail,
                ...(chain ? { chain } : {}),
                reads: { profile: PROFILE, ctf: CTF_ADDRESS, conditionId, questionId, resolver, gammaStatus: market.sourceStatus, payout, calls: calls() },
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
            const offChain = [...heads].filter(([, h]) => h.chainId !== BigInt(POLYGON_CHAIN_ID)).map(([u]) => u);
            if (offChain.length > 0) return done("inconsistent", `not on chain ${POLYGON_CHAIN_ID}: ${offChain.join(", ")}`);
            const number = quorum(heads, "finalized head")
                .map((h) => h.number)
                .reduce((a, b) => (b < a ? b : a));
            const tag = `0x${number.toString(16)}`;

            const hashes = await settle([...heads.keys()], (u) =>
                call(u, "eth_getBlockByNumber", [tag, false], (r) => {
                    const b = header(r);
                    if (b.number !== number) throw new Error(`asked for block ${number}, got ${b.number}`);
                    return b.hash;
                }),
            );
            if (new Set(hashes.values()).size > 1) {
                return done("inconsistent", `block ${number} hash differs: ${[...hashes].map(([u, h]) => `${u}=${h}`).join(", ")}`);
            }
            const [blockHash] = quorum(hashes, `block ${number} hash`);
            const chain = { chainId: POLYGON_CHAIN_ID, blockNumber: number.toString(), blockHash, providers: [...hashes.keys()] };

            const cond = conditionId.slice(2);
            const states = await settle(chain.providers, async (u) => {
                const read = (data: string) => call(u, "eth_call", [{ to: CTF_ADDRESS, data }, tag], uint256);
                const den = await read(`0x${SEL_PAYOUT_DENOMINATOR}${cond}`);
                const n0 = await read(`0x${SEL_PAYOUT_NUMERATORS}${cond}${word(0n)}`);
                const n1 = await read(`0x${SEL_PAYOUT_NUMERATORS}${cond}${word(1n)}`);
                return [den, n0, n1] as const;
            });
            if (new Set([...states.values()].map((s) => s.join("/"))).size > 1) {
                return done("inconsistent", `CTF payouts differ across providers at block ${number}`, chain);
            }
            const [[denominator, n0, n1]] = quorum(states, "CTF payout reads");
            chain.providers = [...states.keys()];
            const payout = { numerators: [n0, n1], denominator };
            const at = `at finalized block ${number} (${blockHash}) on ${chain.providers.length} providers`;
            if (denominator === 0n) {
                const s = market.sourceStatus;
                const status = s === "proposed" || s === "disputed" ? s : "unresolved";
                return done(status, `payoutDenominator is 0 ${at}; gamma umaResolutionStatus=${s ?? "n/a"}`, chain, payout);
            }
            if (!isSupportedVector(payout)) {
                return done("unsupported", `payout [${n0},${n1}]/${denominator} is not [1,0]/1, [0,1]/1 or [1,1]/2 ${at}`, chain, payout);
            }
            const winner = n0 === n1 ? "50-50" : market.outcomes[n0 > n1 ? 0 : 1];
            return { ...done("final", `payout [${n0},${n1}]/${denominator} (${winner}) ${at}`, chain, payout), vector: payout };
        },

        verifyFinalResolution(market, evidence, profile) {
            const fail = (reason: string) => ({ ok: false as const, reason });
            if (profile !== PROFILE) return fail(`unsupported profile ${profile}`);
            const bad = identityProblem(market, allow);
            if (bad) return fail(`${bad.code}: ${bad.reason}`);
            if (evidence.status !== "final") return fail(`status is ${evidence.status}`);
            if (!evidence.vector || !isSupportedVector(evidence.vector)) return fail("vector is not [1,0]/1, [0,1]/1 or [1,1]/2");
            const c = evidence.chain;
            if (!c || c.chainId !== POLYGON_CHAIN_ID) return fail(`evidence is not from chain ${POLYGON_CHAIN_ID}`);
            if (!/^[1-9]\d*$/.test(c.blockNumber) || !BYTES32.test(c.blockHash)) return fail("block number/hash missing or malformed");
            const providers = new Set(c.providers).size;
            if (providers < minProviders) return fail(`${providers} providers < ${minProviders}`);
            if (evidence.reads?.conditionId !== market.protocol.conditionId) return fail("evidence was read for a different condition");
            return { ok: true };
        },
    };
}
