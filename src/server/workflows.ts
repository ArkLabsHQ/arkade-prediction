import { all, now, one, run, type Db } from "./db.js";
import type { WriterLease } from "./lease.js";

export type WorkflowState = "pending" | "submitting" | "done" | "failed";

export interface Workflow<P = Record<string, unknown>> {
    id: string;
    kind: string;
    marketId: string | null;
    state: WorkflowState;
    attempts: number;
    payload: P;
    txid: string | null;
    error: string | null;
    nextAt: number;
}

const LEGAL: Record<WorkflowState, WorkflowState[]> = {
    pending: ["submitting", "done", "failed", "pending"],
    submitting: ["pending", "done", "failed", "submitting"],
    done: [],
    failed: ["pending"],
};

interface Row {
    id: string;
    kind: string;
    market_id: string | null;
    state: WorkflowState;
    attempts: number;
    payload: string;
    txid: string | null;
    error: string | null;
    next_at: number;
}

const toWorkflow = (r: Row): Workflow => ({
    id: r.id, kind: r.kind, marketId: r.market_id, state: r.state, attempts: r.attempts,
    payload: JSON.parse(r.payload), txid: r.txid, error: r.error, nextAt: r.next_at,
});

/**
 * Persistent workflow rows keyed by an idempotency id. Every transition is a conditional update on the
 * expected state AND the current writer-lease token, so a stale writer or a duplicate delivery is a no-op.
 */
export class Workflows {
    constructor(private readonly db: Db, private readonly lease: WriterLease) {}

    /** Inserts once per id; re-enqueueing an existing id returns the stored row unchanged. */
    enqueue(id: string, kind: string, marketId: string | null, payload: Record<string, unknown>): Workflow {
        const t = now();
        run(this.db, "INSERT OR IGNORE INTO workflows(id, kind, market_id, state, payload, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?, ?)",
            id, kind, marketId, JSON.stringify(payload), t, t);
        return this.get(id)!;
    }

    get(id: string): Workflow | undefined {
        const r = one<Row>(this.db, "SELECT * FROM workflows WHERE id = ?", id);
        return r && toWorkflow(r);
    }

    due(limit = 20, at = Date.now()): Workflow[] {
        return all<Row>(this.db, "SELECT * FROM workflows WHERE state IN ('pending','submitting') AND next_at <= ? ORDER BY created_at LIMIT ?", at, limit).map(toWorkflow);
    }

    list(filter: { state?: WorkflowState; marketId?: string; limit?: number } = {}): Workflow[] {
        return all<Row>(this.db,
            "SELECT * FROM workflows WHERE (? IS NULL OR state = ?) AND (? IS NULL OR market_id = ?) ORDER BY updated_at DESC LIMIT ?",
            filter.state ?? null, filter.state ?? null, filter.marketId ?? null, filter.marketId ?? null, filter.limit ?? 100).map(toWorkflow);
    }

    transition(wf: Workflow, to: WorkflowState, patch: { payload?: Record<string, unknown>; txid?: string | null; error?: string | null; nextAt?: number; attempt?: boolean } = {}): Workflow {
        if (!LEGAL[wf.state].includes(to)) throw new Error(`illegal workflow transition ${wf.state} -> ${to} (${wf.id})`);
        const token = this.lease.assertHeld();
        const payload = patch.payload ? { ...wf.payload, ...patch.payload } : wf.payload;
        const r = run(this.db,
            `UPDATE workflows SET state = ?, payload = ?, txid = ?, error = ?, next_at = ?, attempts = attempts + ?, updated_at = ?
             WHERE id = ? AND state = ? AND EXISTS (SELECT 1 FROM writer_lease WHERE id = 1 AND token = ?)`,
            to, JSON.stringify(payload), patch.txid === undefined ? wf.txid : patch.txid, patch.error === undefined ? wf.error : patch.error,
            patch.nextAt ?? wf.nextAt, patch.attempt ? 1 : 0, now(), wf.id, wf.state, token);
        if (Number(r.changes) !== 1) throw new Error(`workflow ${wf.id} changed concurrently`);
        return this.get(wf.id)!;
    }
}

/** Exponential backoff with full jitter, capped. */
export function backoffMs(attempts: number, baseMs = 2000, capMs = 5 * 60_000): number {
    return Math.floor(Math.random() * Math.min(capMs, baseMs * 2 ** Math.min(attempts, 10)));
}
