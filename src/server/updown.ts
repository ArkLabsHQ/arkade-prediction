import { randomBytes } from "node:crypto";
import { definitionHash, type MarketDefinition } from "../core/definition.js";
import { now, one, run } from "./db.js";
import type { Deps } from "./markets.js";
import type { Workflows } from "./workflows.js";

/** Polymarket's crypto Up/Down events, mirrored as markets settled on RedStone's signed rounds. */
const SLUG = /^([a-z]+)-updown-(5m|15m|1h|4h)-(\d{10})$/;
const WINDOW_MS: Record<string, number> = { "5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };
// Activation (genesis + vault) must land before the start round.
const MIN_LEAD_MS = 90_000;

export interface UpDownMirror {
    sourceId: string;
    slug: string;
    question: string;
    image: string | null;
    feed: string;
    window: string;
    startAtMs: number;
    endAtMs: number;
    referencePrices: { outcome: string; price: string }[] | null;
    resolutionSource: string;
}

/** Reads one gamma event; undefined unless it is a well-formed Up/Down event on 10 s round boundaries. */
export function parseUpDownEvent(raw: unknown): UpDownMirror | undefined {
    if (typeof raw !== "object" || raw === null) return undefined;
    const e = raw as { slug?: unknown; markets?: unknown[] };
    const m = (Array.isArray(e.markets) ? e.markets[0] : undefined) as Record<string, unknown> | undefined;
    const hit = typeof e.slug === "string" ? SLUG.exec(e.slug) : null;
    if (!hit || !m || typeof m.id !== "string" || typeof m.question !== "string" || typeof m.endDate !== "string") return undefined;
    const [, asset, window, startUnix] = hit;
    const startAtMs = Number(startUnix) * 1000;
    const endAtMs = Date.parse(m.endDate);
    if (endAtMs - startAtMs !== WINDOW_MS[window!] || startAtMs % 10_000 !== 0) return undefined;
    const outcomes = typeof m.outcomes === "string" ? (JSON.parse(m.outcomes) as unknown) : m.outcomes;
    const prices = typeof m.outcomePrices === "string" ? (JSON.parse(m.outcomePrices) as unknown) : m.outcomePrices;
    if (JSON.stringify(outcomes) !== JSON.stringify(["Up", "Down"])) return undefined;
    const image = typeof m.image === "string" && m.image.startsWith("https://polymarket-upload.s3.us-east-2.amazonaws.com/") ? m.image : null;
    return {
        sourceId: m.id, slug: e.slug as string, question: m.question.slice(0, 300), image, feed: asset!.toUpperCase(), window: window!, startAtMs, endAtMs,
        referencePrices: Array.isArray(prices) && prices.length === 2 ? [{ outcome: "Up", price: String(prices[0]) }, { outcome: "Down", price: String(prices[1]) }] : null,
        resolutionSource: typeof m.resolutionSource === "string" ? m.resolutionSource.slice(0, 200) : "",
    };
}

/**
 * Upcoming events by slug: they are listed about a day ahead and thousands a day, so listing by recency never
 * reaches the next few windows, but each slug is {asset}-updown-{window}-{start on a window boundary}.
 */
export function upcomingSlugs(windows: string[], assets: string[], leadSeconds: number, at = Date.now()): string[] {
    const slugs: string[] = [];
    for (const window of windows) {
        const step = WINDOW_MS[window];
        if (!step) continue;
        for (let t = Math.ceil((at + MIN_LEAD_MS) / step) * step; t <= at + leadSeconds * 1000; t += step) {
            for (const asset of assets) slugs.push(`${asset.toLowerCase()}-updown-${window}-${t / 1000}`);
        }
    }
    return slugs;
}

export async function discoverUpDown(gammaUrl: string, slugs: string[], fetchImpl: typeof fetch = fetch): Promise<UpDownMirror[]> {
    const out: UpDownMirror[] = [];
    for (let i = 0; i < slugs.length; i += 40) {
        const q = new URLSearchParams(slugs.slice(i, i + 40).map((s): [string, string] => ["slug", s]));
        const r = await fetchImpl(`${gammaUrl.replace(/\/+$/, "")}/events?${q}`, { signal: AbortSignal.timeout(15_000) });
        if (!r.ok) throw new Error(`gamma /events answered ${r.status}`);
        out.push(...((await r.json()) as unknown[]).map(parseUpDownEvent).filter((x): x is UpDownMirror => !!x));
    }
    return out;
}

export function upDownDefinition(u: UpDownMirror, timeoutSeconds: number): MarketDefinition {
    const at = (ms: number) => new Date(ms).toISOString();
    return {
        question: u.question,
        rules: `Up if RedStone's median signed ${u.feed}/USD price for the round at ${at(u.endAtMs)} is at or above its median for the round at ${at(u.startAtMs)}; otherwise Down. ` +
            `The vault verifies RedStone's signatures itself. This mirrors Polymarket ${u.slug}, which settles on ${u.resolutionSource || "Chainlink"}; the two sources can differ, ` +
            `so the outcomes can too. If either round is not captured, the market settles 50/50 at the timeout.`,
        outcomes: ["Up", "Down"],
        category: "crypto up/down",
        closeAtUnix: String(Math.floor(u.endAtMs / 1000)),
        timeoutAtUnix: String(Math.floor(u.endAtMs / 1000) + timeoutSeconds),
        source: { provider: "polymarket", sourceId: u.sourceId, slug: u.slug, settlement: { oracle: "redstone-primary-prod", feed: u.feed, startAtMs: u.startAtMs, endAtMs: u.endAtMs } },
    };
}

/** Creates up to the cap of mirrors whose start is far enough ahead to activate in time. */
export function importUpDown(d: Deps & { wf: Workflows }, mirrors: UpDownMirror[], at = Date.now()): string[] {
    const { cfg, db } = d;
    const windows = new Set(cfg.UPDOWN_WINDOWS);
    const assets = new Set(cfg.UPDOWN_ASSETS.map((a) => a.toUpperCase()));
    const created: string[] = [];
    const sorted = [...mirrors].sort((a, b) => a.startAtMs - b.startAtMs);
    for (const u of sorted) {
        const active = one<{ n: number }>(db, "SELECT COUNT(*) n FROM markets WHERE oracle_policy = 'redstone' AND status IN ('activating','open','closed')")!.n;
        if (active >= cfg.UPDOWN_MAX_ACTIVE) break;
        if (!windows.has(u.window) || !assets.has(u.feed)) continue;
        if (u.startAtMs < at + MIN_LEAD_MS || u.startAtMs > at + cfg.UPDOWN_LEAD_SECONDS * 1000) continue;
        if (one(db, "SELECT 1 FROM markets WHERE source_provider = 'polymarket' AND source_id = ?", u.sourceId)) continue;
        const def = upDownDefinition(u, cfg.UPDOWN_TIMEOUT_SECONDS);
        const id = randomBytes(16).toString("hex");
        const t = now();
        const snapshot = {
            provider: "polymarket", sourceId: u.sourceId, slug: u.slug, url: `https://polymarket.com/event/${encodeURIComponent(u.slug)}`, question: u.question,
            resolutionSource: u.resolutionSource, referencePrices: u.referencePrices, image: u.image, event: null, fetchedAt: t,
            updown: { feed: u.feed, startAtMs: u.startAtMs, endAtMs: u.endAtMs }, binding: def.source,
        };
        run(db, `INSERT INTO markets(id, kind, status, question, rules, outcomes, category, close_at, timeout_at, source_provider, source_id,
                 source_version, source_snapshot, profile, oracle_policy, oracle_keys, oracle_threshold, oracle_epoch, definition_hash, created_at, updated_at)
                 VALUES (?, 'polymarket', 'activating', ?, ?, ?, ?, ?, ?, 'polymarket', ?, 'updown', ?, 'redstone-updown', 'redstone', '[]', 3, 1, ?, ?, ?)`,
            id, def.question, def.rules, JSON.stringify(def.outcomes), def.category, Number(def.closeAtUnix), Number(def.timeoutAtUnix),
            u.sourceId, JSON.stringify(snapshot), definitionHash(def), t, t);
        d.wf.enqueue(`activate:${id}`, "activate", id, {});
        d.bus.publish("market", id, { status: "activating", source: u.sourceId });
        created.push(id);
    }
    return created;
}
