import { latestPackages, type RedStonePackage } from "../core/redstone.js";
import { all, now, one, run, type Db } from "./db.js";

export const GATEWAYS = [
    "https://oracle-gateway-1.a.redstone.finance/v2/data-packages/latest/redstone-primary-prod",
    "https://oracle-gateway-2.a.redstone.finance/v2/data-packages/latest/redstone-primary-prod",
];
// A round is served as "latest" for roughly 10-20 s; poll from just before it until well after.
const LEAD_MS = 5_000;
const TAIL_MS = 180_000;

export interface NeededRound {
    feed: string;
    roundMs: number;
}

/** Rounds of up/down mirrors (Polymarket markets settled on RedStone) that are live now and not captured yet. */
export function neededRounds(db: Db, at = Date.now()): NeededRound[] {
    const rows = all<{ snapshot: string }>(db, "SELECT source_snapshot snapshot FROM markets WHERE oracle_policy = 'redstone' AND status IN ('activating','open','closed')");
    const out = new Map<string, NeededRound>();
    for (const r of rows) {
        const u = JSON.parse(r.snapshot).updown as { feed: string; startAtMs: number; endAtMs: number } | undefined;
        if (!u) continue;
        for (const roundMs of [u.startAtMs, u.endAtMs]) {
            if (at < roundMs - LEAD_MS || at > roundMs + TAIL_MS) continue;
            if (one(db, "SELECT 1 FROM price_rounds WHERE feed = ? AND round_ms = ?", u.feed, roundMs)) continue;
            out.set(`${u.feed}:${roundMs}`, { feed: u.feed, roundMs });
        }
    }
    return [...out.values()];
}

/** Packages stored for a round, or undefined if it was never captured. */
export function storedRound(db: Db, feed: string, roundMs: number): RedStonePackage[] | undefined {
    const row = one<{ packages: string }>(db, "SELECT packages FROM price_rounds WHERE feed = ? AND round_ms = ?", feed, roundMs);
    return row ? (JSON.parse(row.packages) as RedStonePackage[]) : undefined;
}

/** Polls both gateways once and keeps any needed round served now, once at least `quorum` signers are in it. */
export async function captureTick(db: Db, quorum: number, fetchImpl: typeof fetch = fetch, at = Date.now()): Promise<number> {
    const needed = neededRounds(db, at);
    if (needed.length === 0) return 0;
    let stored = 0;
    for (const gateway of GATEWAYS) {
        for (const n of needed) {
            if (storedRound(db, n.feed, n.roundMs)) continue;
            const pkgs = await latestPackages(n.feed, fetchImpl, gateway).catch(() => [] as RedStonePackage[]);
            const inRound = pkgs.filter((p) => p.timestampMilliseconds === n.roundMs);
            if (new Set(inRound.map((p) => p.signerAddress.toLowerCase())).size < quorum) continue;
            run(db, "INSERT OR IGNORE INTO price_rounds(feed, round_ms, packages, captured_at) VALUES (?, ?, ?, ?)", n.feed, n.roundMs, JSON.stringify(inRound), now());
            stored++;
        }
    }
    return stored;
}
