import type { MarketEvent } from "../shared/api.js";
import { all, now, run, type Db } from "./db.js";

type Listener = (e: MarketEvent) => void;

/** Persisted event log; SSE clients replay from Last-Event-ID, so a reconnect never misses a wake-up. */
export class EventBus {
    private readonly listeners = new Set<Listener>();

    constructor(private readonly db: Db) {}

    publish(type: MarketEvent["type"], marketId: string | null, data: unknown): MarketEvent {
        const at = now();
        const json = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
        const r = run(this.db, "INSERT INTO events(type, market_id, at, data) VALUES (?, ?, ?, ?)", type, marketId, at, json);
        const event: MarketEvent = { id: Number(r.lastInsertRowid), type, marketId, at, data: JSON.parse(json) };
        for (const l of this.listeners) l(event);
        return event;
    }

    since(afterId: number, limit = 500): MarketEvent[] {
        return all<{ id: number; type: MarketEvent["type"]; market_id: string | null; at: string; data: string }>(
            this.db,
            "SELECT id, type, market_id, at, data FROM events WHERE id > ? ORDER BY id LIMIT ?",
            afterId,
            limit,
        ).map((r) => ({ id: r.id, type: r.type, marketId: r.market_id, at: r.at, data: JSON.parse(r.data) }));
    }

    subscribe(l: Listener): () => void {
        this.listeners.add(l);
        return () => this.listeners.delete(l);
    }

    /** ponytail: unbounded log trimmed by count; switch to time-based retention if clients reconnect after long gaps. */
    trim(keep = 50_000): void {
        run(this.db, "DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?", keep);
    }
}
