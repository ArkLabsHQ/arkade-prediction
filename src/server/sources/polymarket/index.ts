import { canonicalJson, sha256Hex } from "../../../core/encoding.js";
import { ADDRESS, BYTES32, createCtfReader, deriveConditionId, hexOf, isRec, isSupportedVector, str } from "../ctf.js";
import type {
    Eligibility,
    EligibilityPolicy,
    MarketSourceProvider,
    ResolutionEvidence,
    ResolutionStatus,
    SourceMarket,
} from "../types.js";

export { deriveConditionId };

export const PROFILE = "polymarket-ctf-v1-binary";
export const CTF_ADDRESS = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";

/**
 * What an attestation commits to as evidence: chain facts at one finalized block, and nothing that depends on
 * which providers or when the reader asked, so independent attestors reading that block sign the same digest.
 */
export function evidenceRecord(market: SourceMarket, evidence: ResolutionEvidence) {
    if (evidence.status !== "final" || !evidence.chain || !evidence.vector) throw new Error("evidence is not a final resolution");
    return {
        profile: PROFILE, chainId: evidence.chain.chainId, ctf: CTF_ADDRESS, sourceId: market.sourceId,
        conditionId: market.protocol.conditionId, questionId: market.protocol.questionId, resolver: market.protocol.resolver,
        block: { number: evidence.chain.blockNumber, hash: evidence.chain.blockHash },
        payout: { numerators: evidence.vector.numerators.map(String), denominator: evidence.vector.denominator.toString() },
    };
}
export const POLYGON_CHAIN_ID = 137;
/** Polymarket's NegRiskAdapter: the CTF oracle of every neg-risk condition (conditionId = keccak(adapter, questionID, 2)). */
export const NEG_RISK_ADAPTER = "0xd91e80cf2e7be2e162c6513ced06f1dd0da35296";
/**
 * `initialize` is permissionless, but `questionID = keccak(ancillaryData || ",initializer:<msg.sender>")` binds the
 * caller, and `questions(questionID).creator` is it. Polymarket's own, read on Polygon 2026-10-09.
 */
export const DEFAULT_CREATORS = [
    "0xac9930b2ae455a671b62de86876a7e8587825294",
    "0x91430cad2d3975766499717fa0d66a78d814e5c5",
    "0xf43d55f3a8b7484ed4b6931f93cb6f9ef5dd369d",
];
/** `prepareMarket` likewise: its caller is the oracle, bound into `marketId = keccak(oracle, fee, metadata) & ~0xff`. */
export const DEFAULT_NEG_RISK_ORACLES = [
    "0x661992aebf6becf7ba5abb66f6b0bf62aa7a2e93",
    "0x71523d0f655b41e805cec45b17163f528b59b820",
];
const DEFAULT_GAMMA_URL = "https://gamma-api.polymarket.com";
const SEL_QUESTIONS = "95addb90";
const SEL_GET_ORACLE = "dafaf94a";
/** QuestionData: `creator` is head word 10, and `ancillaryData`'s offset at word 11 pins that 12-field layout. */
const CREATOR_WORD = 10;
const ANCILLARY_OFFSET = 384n;

const SOURCE_ID = /^\d{1,20}$/;
const PRICE = /^(0(\.\d{1,64})?|1(\.0{1,64})?)$/;

export interface PolymarketProviderOptions {
    gammaUrl?: string;
    rpcUrls: string[];
    resolverAllowlist: string[];
    creatorAllowlist?: string[];
    negRiskOracleAllowlist?: string[];
    fetch?: typeof fetch;
    timeoutMs?: number;
    minProviders?: number;
}

type Problem = { code: string; reason: string };

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

const IMAGE_HOST = "polymarket-upload.s3.us-east-2.amazonaws.com";

function imageOf(v: unknown): string | null {
    if (typeof v !== "string" || v.length > 500 || !URL.canParse(v)) return null;
    const u = new URL(v);
    return u.protocol === "https:" && u.host === IMAGE_HOST ? u.href : null;
}

function eventOf(v: unknown): { title: string; slug: string } | null {
    const e = Array.isArray(v) ? v[0] : null;
    return isRec(e) && typeof e.title === "string" && e.title.trim() ? { title: str(e.title, 200), slug: str(e.slug, 200) } : null;
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
            // Only set when true, so the versionHash of every non-neg-risk market stays what it was.
            ...(raw.negRisk === true && raw.negRiskOther === false ? { negRiskAdapter: true as const } : {}),
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
    // Gamma writes kickoff as "2026-10-09 00:15:00+00"; made strict ISO before parsing.
    // Sports list a kickoff; crypto Up/Down markets list the start of their price window instead.
    const kickoff = typeof raw.gameStartTime === "string" ? isoDate(raw.gameStartTime.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")) : isoDate(raw.eventStartTime);
    const volume24h = typeof raw.volume24hr === "number" && Number.isFinite(raw.volume24hr) && raw.volume24hr >= 0 ? raw.volume24hr : null;
    return { ...core, referencePrices, image: imageOf(raw.image), event: eventOf(raw.events), volume24h, gameStartTime: kickoff, versionHash: sha256Hex(canonicalJson(core)), fetchedAt };
}

/**
 * The condition's CTF oracle: the NegRiskAdapter, gamma's `resolvedBy`, or — when gamma omits it, as on crypto
 * Up/Down markets — the allowlisted address its conditionId derives from.
 */
function oracleOf(p: SourceMarket["protocol"], allow: ReadonlySet<string>): string | null {
    if (p.negRisk) return NEG_RISK_ADAPTER;
    return p.resolver ?? [...allow].find((a) => BYTES32.test(p.questionId) && deriveConditionId(a, p.questionId) === p.conditionId) ?? null;
}

/** `questionId & ~0xff`, NegRiskIdLib.getMarketId. */
function marketIdOf(questionId: string): string {
    return `0x${(BigInt(questionId) & ~0xffn).toString(16).padStart(64, "0")}`;
}

/** A non-zero address in the low 20 bytes of word `i`; anything else is a failed or misread call, never zero. */
function addressAt(r: unknown, i: number): string {
    const s = typeof r === "string" && /^0x([0-9a-f]{64})+$/i.test(r) ? r.slice(2).toLowerCase() : "";
    const w = s.slice(i * 64, i * 64 + 64);
    const a = w.length === 64 && w.startsWith("0".repeat(24)) ? hexOf(`0x${w.slice(24)}`, ADDRESS) : null;
    if (!a || BigInt(`0x${w}`) === 0n) throw new Error(`word ${i} is not an address: ${String(r).slice(0, 80)}`);
    return a;
}

function questionCreator(r: unknown): string {
    const s = typeof r === "string" && /^0x([0-9a-f]{64})+$/i.test(r) ? r.slice(2) : "";
    if (s.length < 13 * 64 || BigInt(`0x${s.slice(11 * 64, 12 * 64)}`) !== ANCILLARY_OFFSET) {
        throw new Error(`not a QuestionData struct: ${String(r).slice(0, 80)}`);
    }
    return addressAt(r, CREATOR_WORD);
}

function identityProblem(m: SourceMarket, allow: ReadonlySet<string>): Problem | null {
    const p = m.protocol;
    if (p.version !== "v1" || p.chainId !== POLYGON_CHAIN_ID || p.settlementContract !== CTF_ADDRESS) {
        return { code: "unsupported-version", reason: `version "${p.version}" on chain ${p.chainId} is not legacy CTF v1 on Polygon` };
    }
    // "Other" placeholders change meaning as named outcomes are added, and missing flags are unknown: both refused.
    if (p.negRisk && !p.negRiskAdapter) return { code: "neg-risk", reason: "negRiskOther set or neg-risk flags missing" };
    if (p.negRisk && !allow.has(NEG_RISK_ADAPTER)) return { code: "neg-risk", reason: `NegRiskAdapter ${NEG_RISK_ADAPTER} is not allowlisted` };
    const [a, b] = m.outcomes;
    if (m.outcomes.length !== 2 || !a || !b || a === b) {
        return { code: "not-binary", reason: `outcomes ${JSON.stringify(m.outcomes).slice(0, 200)}` };
    }
    const oracle = oracleOf(p, allow);
    if (!p.negRisk && (!oracle || !allow.has(oracle))) {
        return { code: "unknown-resolver", reason: `resolver ${oracle ?? "missing"} is not allowlisted` };
    }
    if (!BYTES32.test(p.questionId) || deriveConditionId(oracle!, p.questionId) !== p.conditionId) {
        return { code: "condition-mismatch", reason: `conditionId != keccak256(${p.negRisk ? "NegRiskAdapter" : "resolver"}, questionId, 2)` };
    }
    return null;
}

export function createPolymarketProvider(opts: PolymarketProviderOptions): MarketSourceProvider {
    const gammaUrl = (opts.gammaUrl ?? DEFAULT_GAMMA_URL).replace(/\/+$/, "");
    const minProviders = opts.minProviders ?? 2;
    const timeoutMs = opts.timeoutMs ?? 10_000;
    const doFetch = opts.fetch ?? fetch;
    const allow = new Set(opts.resolverAllowlist.map((a) => a.toLowerCase()));
    const creators = new Set((opts.creatorAllowlist ?? DEFAULT_CREATORS).map((a) => a.toLowerCase()));
    const negRiskOracles = new Set((opts.negRiskOracleAllowlist ?? DEFAULT_NEG_RISK_ORACLES).map((a) => a.toLowerCase()));
    if (!Number.isInteger(minProviders) || minProviders < 2) throw new Error("minProviders must be an integer >= 2");
    for (const a of allow) if (!ADDRESS.test(a)) throw new Error(`invalid resolver address ${a}`);
    for (const a of [...creators, ...negRiskOracles]) if (!ADDRESS.test(a)) throw new Error(`invalid reporter address ${a}`);
    const ctf = createCtfReader({ rpcUrls: opts.rpcUrls, chainId: POLYGON_CHAIN_ID, ctf: CTF_ADDRESS, minProviders, timeoutMs, fetch: doFetch });
    const { getJson, retry: withRetry } = ctf;

    const tagIds = new Map<string, string>();
    async function tagId(slug: string): Promise<string> {
        if (!/^[a-z0-9-]{1,60}$/.test(slug)) throw new Error(`invalid Polymarket tag ${JSON.stringify(slug.slice(0, 40))}`);
        let id = tagIds.get(slug);
        if (!id) {
            const body = await withRetry(() => getJson(`${gammaUrl}/tags/slug/${slug}`));
            if (!isRec(body) || !/^[0-9]{1,12}$/.test(String(body.id))) throw new Error(`unknown Polymarket tag ${slug}`);
            tagIds.set(slug, (id = String(body.id)));
        }
        return id;
    }

    return {
        name: "polymarket",
        profile: PROFILE,
        evidenceRecord,

        async discoverMarkets(cursor, limit, opts = {}) {
            const size = Math.min(100, Math.max(1, Math.trunc(limit) || 1));
            const q = new URLSearchParams({ closed: "false", include_tag: "true", order: "volume24hr", ascending: "false", limit: String(size) });
            // The keyset endpoint ignores tags, so a tag pass pages /markets by offset instead.
            if (opts.tag) {
                const offset = Number(cursor ?? 0);
                q.set("tag_id", await tagId(opts.tag));
                q.set("offset", String(offset));
                const body = await withRetry(() => getJson(`${gammaUrl}/markets?${q}`));
                if (!Array.isArray(body)) throw new Error("unexpected /markets response");
                const fetchedAt = new Date().toISOString();
                const markets = body.flatMap((m: unknown) => {
                    try {
                        return [normalize(m, fetchedAt)];
                    } catch {
                        return [];
                    }
                });
                return { markets, next: body.length === size ? String(offset + size) : null };
            }
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

        async fetchMarketsBySlug(slugs) {
            const out: SourceMarket[] = [];
            for (let i = 0; i < slugs.length; i += 40) {
                const q = new URLSearchParams([["include_tag", "true"], ...slugs.slice(i, i + 40).map((s): [string, string] => ["slug", s])]);
                const body = await withRetry(() => getJson(`${gammaUrl}/markets?${q}`));
                if (!Array.isArray(body)) throw new Error("unexpected /markets response");
                const fetchedAt = new Date().toISOString();
                for (const m of body) {
                    try {
                        out.push(normalize(m, fetchedAt));
                    } catch {
                        // a malformed entry is skipped, as in discovery
                    }
                }
            }
            return out;
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
            // Imported markets hold an active slot until close: skip ones already underway or effectively decided.
            if (market.gameStartTime && Date.parse(market.gameStartTime) <= t) return no("started", `game started ${market.gameStartTime}`);
            if (market.referencePrices?.some((p) => Number(p.price) >= 0.98)) return no("decided", "a reference price is at or above 0.98");
            const wanted = policy.tags.map((tag) => tag.toLowerCase());
            if (wanted.length > 0 && !market.tags.some((tag) => wanted.includes(tag))) return no("tag-filter", "no allowed tag");
            return { eligible: true, profile: PROFILE };
        },

        async vetSource(market) {
            const no = (reason: string) => ({ ok: false as const, reason });
            const bad = identityProblem(market, allow);
            if (bad) return no(`${bad.code}: ${bad.reason}`);
            const { questionId, negRisk } = market.protocol;
            const [what, to, data, decode, allowed] = negRisk
                ? ["neg-risk oracle", NEG_RISK_ADAPTER, `0x${SEL_GET_ORACLE}${marketIdOf(questionId).slice(2)}`, (r: unknown) => addressAt(r, 0), negRiskOracles] as const
                : ["question creator", oracleOf(market.protocol, allow)!, `0x${SEL_QUESTIONS}${questionId.slice(2)}`, questionCreator, creators] as const;
            const reporter = await ctf.agree(what, to, data, decode);
            if (!reporter.ok) return no(reporter.reason);
            if (!allowed.has(reporter.value)) return no(`${what} ${reporter.value} is not allowlisted`);
            return { ok: true as const };
        },

        async fetchResolutionEvidence(market, opts = {}) {
            const observedAt = new Date().toISOString();
            const bad = identityProblem(market, allow);
            if (bad) return { status: "unsupported", detail: `${bad.code}: ${bad.reason}`, observedAt };
            const { conditionId, questionId, resolver } = market.protocol;
            const read = await ctf.readPayout(conditionId, opts.atBlock);
            const done = (
                status: ResolutionStatus,
                detail: string,
                chain?: ResolutionEvidence["chain"],
                payout?: { numerators: bigint[]; denominator: bigint },
            ): ResolutionEvidence => ({
                status,
                detail,
                ...(chain ? { chain } : {}),
                reads: { profile: PROFILE, ctf: CTF_ADDRESS, conditionId, questionId, resolver, gammaStatus: market.sourceStatus, payout, calls: read.calls },
                observedAt,
            });
            if (!read.ok) return done("inconsistent", read.detail, read.chain);
            const { chain, payout, at } = read;
            const [n0, n1] = payout.numerators;
            const { denominator } = payout;
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

        async screenResolved(markets) {
            return ctf.screenResolved(markets.filter((m) => !identityProblem(m, allow)).map((m) => m.protocol.conditionId));
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
