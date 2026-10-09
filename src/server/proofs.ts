import type { ProofJobJson, ProofStage } from "../shared/api.js";
import type { Config } from "./config.js";
import { all, now, one, run, type Db } from "./db.js";
import type { EventBus } from "./events.js";
import { CTF_ADDRESS } from "./sources/polymarket/index.js";

export type Rpc = (method: string, params: unknown[]) => Promise<unknown>;
export interface ProofDeps {
    cfg: Pick<Config, "POLYGON_ARCHIVE_RPC_URLS" | "ETHEREUM_RPC_URLS">;
    db: Db;
    bus: EventBus;
    log: (m: string, e?: Record<string, unknown>) => void;
    rpc?: { polygon: Rpc; ethereum: Rpc };
}

export const ROOT_CHAIN = "0x86e4dc95c7fbdbf52e33d563bbdb00823894c287";
const CONDITION_RESOLUTION = "0xb44d84d3289691f71497564b85d4233648d9dbae8cbdbb4329f301c3a0185894";
const PAYOUT_DENOMINATOR = "0xdd34de67";
const CURRENT_HEADER_BLOCK = "0xec7e4855";
const HEADER_BLOCKS = "0x41539d4a";
const CHECKPOINT_STEP = 10_000n;
const INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;
const JOBS_PER_TICK = 3;
// Providers' heads differ by a few blocks; searching below the slowest keeps every probe answerable.
const HEAD_MARGIN = 16;
const ACTIVE: ProofStage[] = ["waiting-source", "waiting-checkpoint", "waiting-l1-finality"];

interface JobRow {
    id: number; market_id: string; question: string; stage: ProofStage; detail: string; polygon_block: number | null; tx_hash: string | null;
    log_index: number | null; header_block_id: number | null; checkpoint_root: string | null; checkpoint_l1_block: number | null;
    attempts: number; next_at: number; started_at: string; updated_at: string; condition_id: string;
}

/** JSON-RPC over several providers in turn. Errors name hosts only: provider URLs often carry API keys. */
export function jsonRpc(urls: string[], timeoutMs = 15_000): Rpc {
    let first = 0;
    return async (method, params) => {
        const errors: string[] = [];
        for (let i = 0; i < urls.length; i++) {
            const k = (first + i) % urls.length;
            const host = URL.canParse(urls[k]!) ? new URL(urls[k]!).host : `rpc#${k + 1}`;
            try {
                const res = await fetch(urls[k]!, {
                    method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
                    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
                });
                const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: { message?: unknown } };
                if (!res.ok || body.error !== undefined || body.result == null) {
                    errors.push(`${host}: ${res.ok ? String(body.error?.message ?? "empty result").slice(0, 120) : `HTTP ${res.status}`}`);
                    continue;
                }
                first = k;
                return body.result;
            } catch (e) {
                errors.push(`${host}: ${e instanceof Error && e.name === "TimeoutError" ? "timeout" : "unreachable"}`);
            }
        }
        throw new Error(`${method} failed (${errors.join("; ")})`);
    };
}

const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const pad32 = (n: bigint) => n.toString(16).padStart(64, "0");
function words(r: unknown, n: number): bigint[] {
    if (typeof r !== "string" || !new RegExp(`^0x[0-9a-fA-F]{${64 * n},}$`).test(r)) throw new Error(`unexpected eth_call return ${String(r).slice(0, 80)}`);
    return Array.from({ length: n }, (_, i) => BigInt(`0x${r.slice(2 + 64 * i, 66 + 64 * i)}`));
}
function block(r: unknown): { number: number; timestamp: bigint } {
    const b = r as { number?: string; timestamp?: string };
    if (!/^0x[0-9a-f]+$/i.test(b?.number ?? "") || !/^0x[0-9a-f]+$/i.test(b?.timestamp ?? "")) throw new Error("malformed block");
    return { number: Number(b.number), timestamp: BigInt(b.timestamp!) };
}

/** The Polygon block where `payoutDenominator(condition)` turned non-zero, and its ConditionResolution log. */
async function findResolution(polygon: Rpc, condition: string): Promise<{ block: number; tx: string; logIndex: number } | null> {
    const denominator = async (b: number) => words(await polygon("eth_call", [{ to: CTF_ADDRESS, data: PAYOUT_DENOMINATOR + condition.slice(2) }, hex(b)]), 1)[0]!;
    const head = Number(await polygon("eth_blockNumber", [])) - HEAD_MARGIN;
    if ((await denominator(head)) === 0n) return null;
    let hi = head, span = 1 << 21, lo = Math.max(0, head - span);
    while (lo > 0 && (await denominator(lo)) > 0n) [hi, span, lo] = [lo, span * 2, Math.max(0, lo - span * 2)];
    while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        if ((await denominator(mid)) > 0n) hi = mid;
        else lo = mid;
    }
    const log = await resolutionLog(polygon, condition, hi);
    return { block: hi, ...log };
}

async function resolutionLog(polygon: Rpc, condition: string, b: number): Promise<{ tx: string; logIndex: number }> {
    const logs = (await polygon("eth_getLogs", [{ address: CTF_ADDRESS, topics: [CONDITION_RESOLUTION, condition], fromBlock: hex(b), toBlock: hex(b) }])) as { transactionHash: string; logIndex: string }[];
    if (!Array.isArray(logs) || logs.length !== 1) throw new Error(`expected one ConditionResolution log in Polygon block ${b}, got ${Array.isArray(logs) ? logs.length : "none"}`);
    return { tx: logs[0]!.transactionHash, logIndex: Number(logs[0]!.logIndex) };
}

async function headerBlock(ethereum: Rpc, id: bigint, tag: string = "latest") {
    const [root, start, end, createdAt] = words(await ethereum("eth_call", [{ to: ROOT_CHAIN, data: HEADER_BLOCKS + pad32(id) }, tag]), 4);
    return { id, root: `0x${pad32(root!)}`, start: start!, end: end!, createdAt: createdAt! };
}

/** RootChain stores `createdAt = block.timestamp`; slots are 12 s, so a few hops from an estimate land on it. */
async function blockAtTimestamp(ethereum: Rpc, ts: bigint): Promise<number> {
    const latest = block(await ethereum("eth_getBlockByNumber", ["latest", false]));
    let n = latest.number - Number((latest.timestamp - ts) / 12n);
    for (let i = 0; i < 12; i++) {
        const b = block(await ethereum("eth_getBlockByNumber", [hex(n), false]));
        if (b.timestamp === ts) return n;
        const d = Number((ts - b.timestamp) / 12n);
        n += d === 0 ? Math.sign(Number(ts - b.timestamp)) : d;
    }
    throw new Error(`no Ethereum block found at timestamp ${ts}`);
}

type Patch = Partial<Pick<JobRow, "stage" | "detail" | "polygon_block" | "tx_hash" | "log_index" | "header_block_id" | "checkpoint_root" | "checkpoint_l1_block">>;

/** One step from the job's current stage, reading only what that stage needs. */
async function step(rpc: { polygon: Rpc; ethereum: Rpc }, j: JobRow): Promise<Patch> {
    if (j.stage === "waiting-source") {
        const r = await findResolution(rpc.polygon, j.condition_id);
        if (!r) return { detail: "Polymarket has not recorded the result on Polygon yet." };
        return { stage: "waiting-checkpoint", polygon_block: r.block, tx_hash: r.tx, log_index: r.logIndex, detail: `Result recorded in Polygon block ${r.block}.` };
    }
    if (j.stage === "waiting-checkpoint") {
        const target = BigInt(j.polygon_block!);
        const current = words(await rpc.ethereum("eth_call", [{ to: ROOT_CHAIN, data: CURRENT_HEADER_BLOCK }, "latest"]), 1)[0]!;
        const last = await headerBlock(rpc.ethereum, current);
        if (last.end < target) return { detail: `Waiting for a Polygon checkpoint on Ethereum to reach block ${target} (latest reaches ${last.end}).` };
        let lo = 1n, hi = current / CHECKPOINT_STEP;
        while (lo < hi) {
            const mid = (lo + hi) / 2n;
            if ((await headerBlock(rpc.ethereum, mid * CHECKPOINT_STEP)).end < target) lo = mid + 1n;
            else hi = mid;
        }
        const cp = await headerBlock(rpc.ethereum, lo * CHECKPOINT_STEP);
        if (!(cp.start <= target && target <= cp.end)) throw new Error(`checkpoint ${cp.id} [${cp.start}, ${cp.end}] does not cover Polygon block ${target}`);
        // Polygon blocks are final well before a checkpoint lands; re-reading the log catches a reorg we recorded early.
        const log = await resolutionLog(rpc.polygon, j.condition_id, j.polygon_block!);
        if (log.tx !== j.tx_hash) return { stage: "waiting-source", polygon_block: null, tx_hash: null, log_index: null, detail: "Polygon result moved; searching again." };
        const l1 = await blockAtTimestamp(rpc.ethereum, cp.createdAt);
        return { stage: "waiting-l1-finality", header_block_id: Number(cp.id), checkpoint_root: cp.root, checkpoint_l1_block: l1, detail: `Checkpoint ${cp.id} posted in Ethereum block ${l1}.` };
    }
    // waiting-l1-finality
    const finalized = block(await rpc.ethereum("eth_getBlockByNumber", ["finalized", false]));
    if (finalized.number < j.checkpoint_l1_block!) return { detail: `Waiting for Ethereum to finalize block ${j.checkpoint_l1_block} (finalized up to ${finalized.number}).` };
    const cp = await headerBlock(rpc.ethereum, BigInt(j.header_block_id!), hex(finalized.number));
    const posted = block(await rpc.ethereum("eth_getBlockByNumber", [hex(j.checkpoint_l1_block!), false]));
    if (cp.root !== j.checkpoint_root || posted.timestamp !== cp.createdAt) {
        return { stage: "waiting-checkpoint", header_block_id: null, checkpoint_root: null, checkpoint_l1_block: null, detail: "Checkpoint changed before Ethereum finality; locating it again." };
    }
    return { stage: "witness-ready", detail: "Everything a proof needs is final on Ethereum." };
}

const SELECT = `SELECT p.*, m.question, json_extract(m.source_snapshot, '$.protocol.conditionId') condition_id FROM proof_jobs p JOIN markets m ON m.id = p.market_id`;

/** Starts jobs for closed Polymarket mirrors and advances a few due ones. Never throws. */
export async function proofTick(d: ProofDeps): Promise<void> {
    try {
        const rpc = d.rpc ?? (d.rpc = { polygon: jsonRpc(d.cfg.POLYGON_ARCHIVE_RPC_URLS), ethereum: jsonRpc(d.cfg.ETHEREUM_RPC_URLS) });
        const t = now();
        for (const m of all<{ id: string; c: string | null }>(d.db,
            `SELECT id, json_extract(source_snapshot, '$.protocol.conditionId') c FROM markets
             WHERE kind = 'polymarket' AND source_provider = 'polymarket' AND oracle_policy = 'platform-attestor'
             AND status IN ('closed','resolving','resolved') AND NOT EXISTS (SELECT 1 FROM proof_jobs p WHERE p.market_id = markets.id)`)) {
            if (!/^0x[0-9a-f]{64}$/.test(m.c ?? "")) continue;
            run(d.db, "INSERT INTO proof_jobs(market_id, stage, started_at, updated_at) VALUES (?, 'waiting-source', ?, ?)", m.id, t, t);
            d.bus.publish("proof", m.id, { stage: "waiting-source" });
        }
        const due = all<JobRow>(d.db, `${SELECT} WHERE p.stage IN (${ACTIVE.map(() => "?").join(",")}) AND p.next_at <= ? ORDER BY p.next_at LIMIT ?`, ...ACTIVE, Date.now(), JOBS_PER_TICK);
        for (const j of due) await advance(d, rpc, j);
    } catch (err) {
        d.log("proof tick failed", { error: String(err).slice(0, 300) });
    }
}

async function advance(d: ProofDeps, rpc: { polygon: Rpc; ethereum: Rpc }, job: JobRow): Promise<void> {
    let j = job;
    try {
        // Stages that are already satisfied fall through in one visit; three hops reach witness-ready.
        for (let hop = 0; hop < 3 && ACTIVE.includes(j.stage); hop++) {
            const patch = await step(rpc, j);
            const next = { ...j, ...patch };
            save(d.db, next, 0, Date.now() + INTERVAL_MS);
            if (next.stage !== j.stage) d.bus.publish("proof", j.market_id, { stage: next.stage, detail: next.detail });
            if (next.stage === j.stage) return;
            j = next;
        }
    } catch (err) {
        const attempts = j.attempts + 1;
        // detail is public; the error can name RPC hosts, and some providers put the API key in the hostname.
        save(d.db, { ...j, detail: "Retrying after a read error from a chain data provider." }, attempts, Date.now() + Math.min(MAX_BACKOFF_MS, INTERVAL_MS * 2 ** attempts));
        d.log("proof step failed", { market: j.market_id, stage: j.stage, error: String(err).slice(0, 300) });
    }
}

function save(db: Db, j: JobRow, attempts: number, nextAt: number): void {
    run(db, `UPDATE proof_jobs SET stage = ?, detail = ?, polygon_block = ?, tx_hash = ?, log_index = ?, header_block_id = ?, checkpoint_root = ?,
             checkpoint_l1_block = ?, attempts = ?, next_at = ?, updated_at = ? WHERE id = ?`,
        j.stage, j.detail.slice(0, 500), j.polygon_block, j.tx_hash, j.log_index, j.header_block_id, j.checkpoint_root, j.checkpoint_l1_block, attempts, nextAt, now(), j.id);
    j.attempts = attempts;
}

const toJson = (j: JobRow): ProofJobJson => ({
    marketId: j.market_id, question: j.question, stage: j.stage, detail: j.detail, polygonBlock: j.polygon_block, txHash: j.tx_hash,
    logIndex: j.log_index, headerBlockId: j.header_block_id, checkpointRoot: j.checkpoint_root, checkpointL1Block: j.checkpoint_l1_block,
    attempts: j.attempts, startedAt: j.started_at, updatedAt: j.updated_at,
});

export function proofJob(db: Db, marketId: string): ProofJobJson | null {
    const j = one<JobRow>(db, `${SELECT} WHERE p.market_id = ?`, marketId);
    return j ? toJson(j) : null;
}

export const listProofJobs = (db: Db, limit: number): ProofJobJson[] =>
    all<JobRow>(db, `${SELECT} WHERE m.status != 'hidden' ORDER BY p.started_at DESC, p.id DESC LIMIT ?`, limit).map(toJson);
