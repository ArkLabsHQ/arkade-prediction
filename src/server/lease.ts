import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { one, run, tx, type Db } from "./db.js";

/**
 * Single money-moving writer per database. A second process (rolling deploy, accidental replica) cannot
 * acquire the lease until the holder releases it or misses heartbeats for `ttlMs`; every fenced write
 * re-checks the token, so a writer that lost its lease cannot keep mutating workflow state.
 */
export class WriterLease {
    readonly owner = `${hostname()}:${process.pid}:${randomBytes(4).toString("hex")}`;
    token: number | undefined;

    constructor(private readonly db: Db, private readonly ttlMs = 30_000) {}

    tryAcquire(nowMs = Date.now()): boolean {
        return tx(this.db, () => {
            const cur = one<{ owner: string; token: number; heartbeat_at: number }>(this.db, "SELECT owner, token, heartbeat_at FROM writer_lease WHERE id = 1");
            if (cur && cur.owner !== this.owner && cur.heartbeat_at > nowMs - this.ttlMs) return false;
            const token = (cur?.token ?? 0) + 1;
            run(this.db, "INSERT INTO writer_lease(id, owner, token, heartbeat_at) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, token = excluded.token, heartbeat_at = excluded.heartbeat_at", this.owner, token, nowMs);
            this.token = token;
            return true;
        });
    }

    heartbeat(nowMs = Date.now()): boolean {
        if (this.token === undefined) return false;
        const r = run(this.db, "UPDATE writer_lease SET heartbeat_at = ? WHERE id = 1 AND owner = ? AND token = ?", nowMs, this.owner, this.token);
        if (Number(r.changes) !== 1) this.token = undefined;
        return this.token !== undefined;
    }

    /** Own timer, because a tick longer than the ttl would let a second writer take over mid-submission. */
    keepAlive(): () => void {
        const timer = setInterval(() => {
            if (this.token !== undefined) this.heartbeat();
        }, Math.ceil(this.ttlMs / 6));
        timer.unref?.();
        return () => clearInterval(timer);
    }

    get held(): boolean {
        return this.token !== undefined;
    }

    assertHeld(): number {
        if (this.token === undefined) throw new Error("writer lease not held");
        const cur = one<{ token: number }>(this.db, "SELECT token FROM writer_lease WHERE id = 1 AND owner = ?", this.owner);
        if (cur?.token !== this.token) {
            this.token = undefined;
            throw new Error("writer lease lost");
        }
        return this.token;
    }

    /** Graceful shutdown: expire our heartbeat so the next instance takes over immediately. */
    release(): void {
        if (this.token === undefined) return;
        run(this.db, "UPDATE writer_lease SET heartbeat_at = 0 WHERE id = 1 AND owner = ? AND token = ?", this.owner, this.token);
        this.token = undefined;
    }
}
