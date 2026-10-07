import { useSyncExternalStore } from "react";
import type { Outcome, PostOfferRequest } from "../shared/api.js";

export type ActionKind = "buy" | "sell" | "mint" | "merge" | "post" | "cancel" | "redeem" | "withdraw" | "genesis" | "vault" | "resolve";

/**
 * signing: built, not yet handed to Arkade. submitting: txid known, submission in flight.
 * accepted: Arkade answered with the txid. confirmed: the indexer serves the tx.
 * uncertain: submission errored after the txid was fixed, so it may still have landed.
 * unregistered: an order is funded but the server has not indexed it yet.
 */
export type LogStatus = "signing" | "submitting" | "accepted" | "confirmed" | "uncertain" | "failed" | "unregistered" | "dismissed";

export interface LogEntry {
    id: string;
    at: string;
    kind: ActionKind;
    label: string;
    marketId: string | null;
    status: LogStatus;
    outcome?: Outcome | "invalid";
    txid?: string;
    qty?: string;
    /** Sats paid (buy, mint, buy order lock) or received (sell, merge, redeem). */
    sats?: string;
    error?: string;
    post?: PostOfferRequest;
}

export const PENDING: LogStatus[] = ["signing", "submitting", "accepted", "uncertain", "unregistered"];

const keyOf = (script: string) => `apm.log.${script}`;
const listeners = new Set<() => void>();
const cache = new Map<string, LogEntry[]>();

export function readLog(script: string): LogEntry[] {
    let entries = cache.get(script);
    if (!entries) {
        try {
            entries = JSON.parse(localStorage.getItem(keyOf(script)) ?? "[]") as LogEntry[];
        } catch {
            entries = [];
        }
        cache.set(script, entries);
    }
    return entries;
}

function write(script: string, entries: LogEntry[]) {
    // ponytail: unbounded per-wallet log; trim old confirmed entries if localStorage quota ever bites.
    cache.set(script, entries);
    localStorage.setItem(keyOf(script), JSON.stringify(entries));
    listeners.forEach((l) => l());
}

export function addLog(script: string, e: Omit<LogEntry, "id" | "at">): string {
    const id = crypto.randomUUID();
    write(script, [{ ...e, id, at: new Date().toISOString() }, ...readLog(script)]);
    return id;
}

export function updateLog(script: string, id: string, patch: Partial<LogEntry>): void {
    write(script, readLog(script).map((e) => (e.id === id ? { ...e, ...patch } : e)));
}

const EMPTY: LogEntry[] = [];

export function useLog(script: string | undefined): LogEntry[] {
    return useSyncExternalStore(
        (cb) => {
            listeners.add(cb);
            return () => {
                listeners.delete(cb);
            };
        },
        () => (script ? readLog(script) : EMPTY),
    );
}
