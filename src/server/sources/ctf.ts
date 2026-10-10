import { keccak_256 } from "@noble/hashes/sha3.js";
import { hex } from "@scure/base";
import { concatBytes } from "../../core/encoding.js";
import { BINARY_VECTORS } from "../../core/payout.js";
import type { ResolutionEvidence } from "./types.js";

const SEL_PAYOUT_DENOMINATOR = "dd34de67";
const SEL_PAYOUT_NUMERATORS = "0504c814";
const SEL_OUTCOME_SLOT_COUNT = "d42dc0c2";
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 250;
const HEADERS = { accept: "application/json", "user-agent": "arkade-prediction/0.1" };

export const BYTES32 = /^0x[0-9a-f]{64}$/;
export const ADDRESS = /^0x[0-9a-f]{40}$/;

export type Rec = Record<string, unknown>;
export type Chain = NonNullable<ResolutionEvidence["chain"]>;
export interface RpcCall {
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

export const isRec = (v: unknown): v is Rec => typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const word = (n: bigint) => n.toString(16).padStart(64, "0");
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export function hexOf(v: unknown, re: RegExp): string | null {
    const s = typeof v === "string" ? v.toLowerCase() : "";
    return re.test(s) ? s : null;
}

/** keccak256(abi.encodePacked(address oracle, bytes32 questionId, uint256 2)), CTHelpers.getConditionId. */
export function deriveConditionId(oracle: string, questionId: string): string {
    const packed = concatBytes(hex.decode(oracle.slice(2)), hex.decode(questionId.slice(2)), hex.decode(word(2n)));
    return `0x${hex.encode(keccak_256(packed))}`;
}

export function isSupportedVector(v: { numerators: readonly bigint[]; denominator: bigint }): boolean {
    return (
        v.numerators.length === 2 &&
        Object.values(BINARY_VECTORS).some((r) => r.denominator === v.denominator && r.numerators.every((n, i) => n === v.numerators[i]))
    );
}

export function quantity(r: unknown): bigint {
    if (typeof r !== "string" || !/^0x[0-9a-f]{1,64}$/i.test(r)) throw new Error(`not a hex quantity: ${String(r).slice(0, 80)}`);
    return BigInt(r);
}

/** Strict uint256 return word: "0x" or a short value is a failed read, never zero. */
export function uint256(r: unknown): bigint {
    if (typeof r !== "string" || !/^0x[0-9a-f]{64}$/i.test(r)) throw new Error(`not a uint256 word: ${String(r).slice(0, 80)}`);
    return BigInt(r);
}

export function header(r: unknown): { number: bigint; hash: string } {
    const hash = isRec(r) ? hexOf(r.hash, BYTES32) : null;
    if (!isRec(r) || !hash) throw new Error("malformed block");
    return { number: quantity(r.number), hash };
}

/** Runs fn per provider in parallel; failed providers are dropped, order follows `urls`. */
export async function settle<T>(urls: string[], fn: (url: string) => Promise<T>): Promise<Map<string, T>> {
    const out = await Promise.all(urls.map((u) => fn(u).then((v): [string, T] => [u, v], () => null)));
    return new Map(out.filter((x) => x !== null));
}

export interface CtfReaderOptions {
    rpcUrls: string[];
    chainId: number;
    ctf: string;
    minProviders: number;
    timeoutMs: number;
    fetch: typeof fetch;
    /** Opinion: a 429 waits RATE_LIMIT_BACKOFF_MS * 2^attempt, unjittered, instead of the normal backoff. */
    rateLimitBackoffMs?: number;
    /** Limitless: truncates a JSON-RPC error body to this many characters. */
    rpcErrorMax?: number;
    /** Limitless: a block decoder that also requires a valid timestamp. */
    header?: (r: unknown) => { number: bigint; hash: string };
}

export type Agreement<T> = { ok: true; value: T } | { ok: false; reason: string };
export type PayoutRead =
    | { ok: false; detail: string; chain?: Chain; calls: RpcCall[] }
    | { ok: true; chain: Chain; payout: { numerators: [bigint, bigint]; denominator: bigint }; at: string; calls: RpcCall[] };

/** Quorum reads of a Gnosis CTF over several JSON-RPC providers; every disagreement or shortfall fails closed. */
export function createCtfReader(o: CtfReaderOptions) {
    const rpcUrls = [...new Set(o.rpcUrls)];
    const { chainId, ctf, minProviders } = o;
    const decodeHeader = o.header ?? header;
    // RPC URLs often embed API keys: logs, details and evidence name a provider only by "host#n". fetch() quotes
    // unparsable and user:password URLs in its errors, so those are refused here.
    const labels = new Map(
        rpcUrls.map((u, i) => {
            const url = URL.canParse(u) ? new URL(u) : null;
            if (!url || url.username || url.password) throw new Error(`RPC URL #${i + 1} must be a valid URL without user:password`);
            return [u, `${url.host}#${i + 1}`] as const;
        }),
    );
    const label = (u: string) => labels.get(u) ?? "rpc";

    async function getJson(url: string, init: RequestInit = { headers: HEADERS }, what = url): Promise<unknown> {
        const res = await o.fetch(url, { ...init, signal: AbortSignal.timeout(o.timeoutMs) });
        if (!res.ok) throw new HttpError(res.status, what);
        return res.json();
    }

    async function retry<T>(fn: () => Promise<T>): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await fn();
            } catch (e) {
                const limited = o.rateLimitBackoffMs !== undefined && e instanceof HttpError && e.status === 429;
                const permanent = e instanceof HttpError && e.status < 500 && e.status !== 429;
                if (permanent || attempt >= MAX_RETRIES) throw e;
                await sleep(limited ? o.rateLimitBackoffMs! * 2 ** attempt : RETRY_BASE_MS * 2 ** attempt * (0.5 + Math.random()));
            }
        }
    }

    const post = (provider: string, body: unknown) =>
        getJson(provider, { method: "POST", headers: { ...HEADERS, "content-type": "application/json" }, body: JSON.stringify(body) }, label(provider));

    async function rpc<T>(log: RpcCall[], provider: string, method: string, params: unknown[], decode: (r: unknown) => T): Promise<T> {
        try {
            const [raw, value] = await retry(async () => {
                const body = await post(provider, { jsonrpc: "2.0", id: 1, method, params });
                if (!isRec(body) || body.id !== 1) throw new Error("malformed JSON-RPC response");
                if (body.error !== undefined) throw new Error(`JSON-RPC error ${JSON.stringify(body.error).slice(0, o.rpcErrorMax)}`);
                return [body.result, decode(body.result)] as const;
            });
            // Block bodies are trimmed to identity fields; full tx lists would bloat the evidence digest input.
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

    /**
     * One eth_call at each provider's own finalized head, which must agree: for immutable facts, a lagging provider
     * disagrees and fails closed rather than letting the quorum settle on a stale answer.
     */
    async function agree<T>(what: string, to: string, data: string, decode: (r: unknown) => T): Promise<Agreement<T>> {
        const log: RpcCall[] = [];
        const answers = await settle(rpcUrls, (u) => rpc(log, u, "eth_call", [{ to, data }, "finalized"], decode));
        if (answers.size < minProviders) {
            const errors = log.filter((c) => c.error).map((c) => `${c.provider}: ${c.error}`);
            return { ok: false, reason: `${what}: ${answers.size}/${minProviders} providers answered; ${errors.join("; ")}` };
        }
        const reported = new Set(answers.values());
        if (reported.size > 1) return { ok: false, reason: `${what} differs across providers: ${[...answers].map(([u, a]) => `${label(u)}=${a}`).join(", ")}` };
        return { ok: true, value: [...reported][0]! };
    }

    const outcomeSlotCount = (conditionId: string) => agree("outcome slot count", ctf, `0x${SEL_OUTCOME_SLOT_COUNT}${conditionId.slice(2)}`, uint256);

    /** payoutDenominator and both numerators at one block every provider has finalized; throws below quorum. */
    async function readPayout(conditionId: string, atBlock?: bigint): Promise<PayoutRead> {
        const logs = new Map(rpcUrls.map((u) => [u, [] as RpcCall[]]));
        const call = <T>(u: string, method: string, params: unknown[], decode: (r: unknown) => T) => rpc(logs.get(u) ?? [], u, method, params, decode);
        const calls = () => [...logs.values()].flat();
        const fail = (detail: string, chain?: Chain): PayoutRead => ({ ok: false, detail, ...(chain ? { chain } : {}), calls: calls() });
        const quorum = <T>(m: Map<string, T>, what: string): [T, ...T[]] => {
            if (m.size < minProviders) {
                const errors = calls().filter((c) => c.error).map((c) => `${c.provider} ${c.method}: ${c.error}`);
                throw new Error(`${what}: ${m.size}/${minProviders} providers answered; ${errors.join("; ")}`);
            }
            return [...m.values()] as [T, ...T[]];
        };

        const heads = await settle(rpcUrls, async (u) => ({
            chainId: await call(u, "eth_chainId", [], quantity),
            number: (await call(u, "eth_getBlockByNumber", ["finalized", false], decodeHeader)).number,
        }));
        const offChain = [...heads].filter(([, h]) => h.chainId !== BigInt(chainId)).map(([u]) => label(u));
        if (offChain.length > 0) return fail(`not on chain ${chainId}: ${offChain.join(", ")}`);
        const finalized = quorum(heads, "finalized head").map((h) => h.number).reduce((a, b) => (b < a ? b : a));
        if (atBlock !== undefined && atBlock > finalized) {
            return fail(`block ${atBlock} is not finalized on every provider yet (finalized ${finalized})`);
        }
        const number = atBlock ?? finalized;
        const tag = `0x${number.toString(16)}`;

        const hashes = await settle([...heads.keys()], (u) =>
            call(u, "eth_getBlockByNumber", [tag, false], (r) => {
                const b = decodeHeader(r);
                if (b.number !== number) throw new Error(`asked for block ${number}, got ${b.number}`);
                return b.hash;
            }),
        );
        if (new Set(hashes.values()).size > 1) {
            return fail(`block ${number} hash differs: ${[...hashes].map(([u, h]) => `${label(u)}=${h}`).join(", ")}`);
        }
        const [blockHash] = quorum(hashes, `block ${number} hash`);
        const chain = { chainId, blockNumber: number.toString(), blockHash, providers: [...hashes.keys()].map(label) };

        const cond = conditionId.slice(2);
        const states = await settle([...hashes.keys()], async (u) => {
            const read = (data: string) => call(u, "eth_call", [{ to: ctf, data }, tag], uint256);
            const den = await read(`0x${SEL_PAYOUT_DENOMINATOR}${cond}`);
            const n0 = await read(`0x${SEL_PAYOUT_NUMERATORS}${cond}${word(0n)}`);
            const n1 = await read(`0x${SEL_PAYOUT_NUMERATORS}${cond}${word(1n)}`);
            return [den, n0, n1] as const;
        });
        if (new Set([...states.values()].map((s) => s.join("/"))).size > 1) {
            return fail(`CTF payouts differ across providers at block ${number}`, chain);
        }
        const [[denominator, n0, n1]] = quorum(states, "CTF payout reads");
        chain.providers = [...states.keys()].map(label);
        const at = `at finalized block ${number} (${blockHash}) on ${chain.providers.length} providers`;
        return { ok: true, chain, payout: { numerators: [n0, n1], denominator }, at, calls: calls() };
    }

    /** The conditions at least minProviders report resolved (payoutDenominator != 0) at their finalized head. */
    async function screenResolved(conditionIds: string[]): Promise<string[]> {
        const conds = [...new Set(conditionIds)];
        if (conds.length === 0) return [];
        const batch = conds.map((c, id) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: ctf, data: `0x${SEL_PAYOUT_DENOMINATOR}${c.slice(2)}` }, "finalized"] }));
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
    }

    return { rpcUrls, label, getJson, retry, anyRpc, agree, outcomeSlotCount, readPayout, screenResolved };
}
