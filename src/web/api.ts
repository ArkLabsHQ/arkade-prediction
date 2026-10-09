import { useEffect, useRef, useSyncExternalStore } from "react";
import type { MarketEvent } from "../shared/api.js";

export class ApiError extends Error {
    constructor(message: string, readonly status: number, readonly code: string) {
        super(message);
    }
}

export async function api<T>(path: string, opts: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    let res: Response;
    try {
        res = await fetch(path, {
            method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
            headers,
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        });
    } catch {
        throw new ApiError("Server unavailable", 0, "unavailable");
    }
    const text = await res.text();
    let json: unknown = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        // Non-JSON body: a proxy or gateway answered instead of the API.
    }
    if (!res.ok) {
        if (json === null && res.status >= 500) throw new ApiError(`Server unavailable (HTTP ${res.status})`, 0, "unavailable");
        const e = (json ?? {}) as { error?: unknown; code?: unknown };
        throw new ApiError(typeof e.error === "string" ? e.error : `HTTP ${res.status}`, res.status, typeof e.code === "string" ? e.code : "http");
    }
    return json as T;
}

export const enc = encodeURIComponent;

/** Offers touched by a fill or cancel: ask the server to re-read them from the indexer. */
export async function refreshOffers(ids: Iterable<string>): Promise<void> {
    await Promise.allSettled([...new Set(ids)].map((id) => api(`/api/offers/${enc(id)}/refresh`, { method: "POST" })));
}

// --- live updates -----------------------------------------------------------------------------

export type LiveChange = Set<string> | "all";
type LiveFn = (change: LiveChange) => void;
export type LiveState = "connecting" | "live" | "down";

const subscribers = new Set<{ current: LiveFn }>();
const stateSubscribers = new Set<() => void>();
const EVENT_TYPES: MarketEvent["type"][] = ["market", "offer", "trade", "resolution", "workflow", "health", "proof"];
let liveState: LiveState = "connecting";
let started = false;
let wasDown = false;
let pending: LiveChange | null = null;

function setState(s: LiveState) {
    liveState = s;
    stateSubscribers.forEach((f) => f());
}

function queue(id: string | "all") {
    const first = pending === null;
    pending = id === "all" || pending === "all" ? "all" : (pending ?? new Set<string>()).add(id);
    if (!first) return;
    setTimeout(() => {
        const change = pending;
        pending = null;
        if (change) subscribers.forEach((s) => s.current(change));
    }, 250);
}

function connect() {
    const es = new EventSource("/api/events");
    es.onopen = () => {
        if (wasDown) queue("all");
        wasDown = false;
        setState("live");
    };
    es.onerror = () => {
        wasDown = true;
        setState("down");
        // Browsers give up for good on a non-SSE answer (e.g. the API is down behind a proxy).
        if (es.readyState === EventSource.CLOSED) setTimeout(connect, 5000);
    };
    const onEvent = (ev: MessageEvent<string>) => {
        try {
            const e = JSON.parse(ev.data) as Partial<MarketEvent>;
            if (typeof e.marketId === "string") queue(e.marketId);
        } catch {
            // Malformed frame: the next event or reconnect resynchronises.
        }
    };
    for (const t of EVENT_TYPES) es.addEventListener(t, onEvent);
    es.onmessage = onEvent;
}

export function startLive() {
    if (started || typeof EventSource === "undefined") return;
    started = true;
    connect();
}

/** Calls `fn` with the market ids that changed (coalesced), or "all" after a reconnect. */
export function useLive(fn: LiveFn) {
    const ref = useRef(fn);
    useEffect(() => {
        ref.current = fn;
    });
    useEffect(() => {
        subscribers.add(ref);
        return () => {
            subscribers.delete(ref);
        };
    }, []);
}

export function useLiveState(): LiveState {
    return useSyncExternalStore(
        (cb) => {
            stateSubscribers.add(cb);
            return () => {
                stateSubscribers.delete(cb);
            };
        },
        () => liveState,
    );
}
