import { randomBytes } from "node:crypto";
import { hex } from "@scure/base";
import { definitionHash } from "../core/definition.js";
import { oracleSlots } from "../core/market.js";
import { getMeta, now, one, run, setMeta, tx } from "./db.js";
import type { Deps } from "./markets.js";
import { importedDefinition } from "./sources/definition.js";
import type { MarketSourceProvider, SourceMarket } from "./sources/types.js";
import type { Workflows } from "./workflows.js";

export interface ImportResult {
    pages: number;
    seen: number;
    eligible: number;
    activated: string[];
    ineligibleByCode: Record<string, number>;
}

/**
 * Discovery is separate from activation: every page is persisted with its eligibility verdict, and only
 * eligible markets up to IMPORT_MAX_ACTIVE are activated (operator genesis via the activate workflow).
 */
const attestorSlots = (cfg: Deps["cfg"]) => oracleSlots(cfg.ORACLE_PUBKEYS.map((k) => hex.decode(k)), cfg.ORACLE_THRESHOLD).map((k) => hex.encode(k));

export async function importOnce(d: Deps & { wf: Workflows; provider: MarketSourceProvider; timeoutDays: number }): Promise<ImportResult> {
    const { cfg, db } = d;
    const result: ImportResult = { pages: 0, seen: 0, eligible: 0, activated: [], ineligibleByCode: {} };
    let cursor = getMeta(db, "import.cursor") ?? null;
    try {
        for (let page = 0; page < cfg.IMPORT_MAX_PAGES; page++) {
            const { markets, next } = await d.provider.discoverMarkets(cursor, Math.min(cfg.IMPORT_PAGE_LIMIT, 100));
            result.pages++;
            for (const m of markets) {
                result.seen++;
                const verdict = d.provider.evaluateEligibility(m, {
                    profiles: ["polymarket-ctf-v1-binary"], tags: cfg.IMPORT_TAGS,
                    maxHorizonSeconds: cfg.IMPORT_MAX_HORIZON_SECONDS, minHorizonSeconds: cfg.IMPORT_MIN_HORIZON_SECONDS,
                }, new Date());
                upsertSource(d, m, verdict.eligible ? { eligible: true, profile: verdict.profile } : { eligible: false, code: verdict.code, reason: verdict.reason });
                if (!verdict.eligible) {
                    result.ineligibleByCode[verdict.code] = (result.ineligibleByCode[verdict.code] ?? 0) + 1;
                    continue;
                }
                result.eligible++;
                const id = activate(d, m, verdict.profile);
                if (id) result.activated.push(id);
            }
            cursor = next;
            setMeta(db, "import.cursor", cursor ?? "");
            if (!next) break;
        }
        setMeta(db, "import.lastRun", now());
        setMeta(db, "import.lastError", "");
    } catch (err) {
        setMeta(db, "import.lastError", `${now()} ${String(err).slice(0, 300)}`);
        throw err;
    }
    return result;
}

function upsertSource(d: Deps, m: SourceMarket, v: { eligible: boolean; code?: string; reason?: string; profile?: string }): void {
    const snapshot = JSON.stringify(m);
    tx(d.db, () => {
        run(d.db, `INSERT INTO source_markets(provider, source_id, version_hash, snapshot, eligible, code, reason, profile, end_date, first_seen, last_seen)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT(provider, source_id) DO UPDATE SET version_hash = excluded.version_hash, snapshot = excluded.snapshot,
                   eligible = excluded.eligible, code = excluded.code, reason = excluded.reason, profile = excluded.profile,
                   end_date = excluded.end_date, last_seen = excluded.last_seen`,
            m.provider, m.sourceId, m.versionHash, snapshot, v.eligible ? 1 : 0, v.code ?? null, v.reason ?? null, v.profile ?? null, m.endDate, now(), now());
        run(d.db, "INSERT OR IGNORE INTO source_versions(provider, source_id, version_hash, snapshot, observed_at) VALUES (?, ?, ?, ?, ?)",
            m.provider, m.sourceId, m.versionHash, snapshot, now());
    });
}

/** Creates the market row once per source id and enqueues operator genesis, within the activation cap. */
function activate(d: Deps & { wf: Workflows; timeoutDays: number }, m: SourceMarket, profile: string): string | undefined {
    if (one(d.db, "SELECT 1 FROM markets WHERE source_provider = ? AND source_id = ?", m.provider, m.sourceId)) return undefined;
    const active = one<{ n: number }>(d.db, "SELECT COUNT(*) n FROM markets WHERE kind = 'polymarket' AND status IN ('activating','open','halted','closed','resolving')")!.n;
    if (active >= d.cfg.IMPORT_MAX_ACTIVE || !d.cfg.ORACLE_PUBKEYS[0]) return undefined;
    const def = importedDefinition(m, profile, d.timeoutDays);
    const id = randomBytes(16).toString("hex");
    const t = now();
    run(d.db, `INSERT INTO markets(id, kind, status, question, rules, outcomes, category, close_at, timeout_at, source_provider, source_id,
               source_version, source_snapshot, profile, oracle_policy, oracle_keys, oracle_threshold, oracle_epoch, definition_hash, created_at, updated_at)
               VALUES (?, 'polymarket', 'activating', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'platform-attestor', ?, ?, ?, ?, ?, ?)`,
        id, def.question, def.rules, JSON.stringify(def.outcomes), def.category, Number(def.closeAtUnix), Number(def.timeoutAtUnix),
        m.provider, m.sourceId, m.versionHash, JSON.stringify({ ...m, binding: def.source }), profile,
        JSON.stringify(attestorSlots(d.cfg)), d.cfg.ORACLE_THRESHOLD, d.cfg.ORACLE_EPOCH, definitionHash(def), t, t);
    d.wf.enqueue(`activate:${id}`, "activate", id, {});
    d.bus.publish("market", id, { status: "activating", source: m.sourceId });
    return id;
}

/**
 * Regtest demo only: imports an already-resolved source market so its real final on-chain result can settle a
 * local market end to end. Identity checks still apply; the label is the category, as the attestor checks the question.
 */
export async function replayHistorical(d: Deps & { wf: Workflows; provider: MarketSourceProvider; timeoutDays: number }, sourceId: string): Promise<string> {
    if (d.cfg.APM_NETWORK !== "regtest") throw new Error("historical replay is regtest-only");
    const m = await d.provider.fetchMarketDefinition(sourceId);
    const verdict = d.provider.evaluateEligibility(m, { profiles: ["polymarket-ctf-v1-binary"], tags: [], maxHorizonSeconds: 1e10, minHorizonSeconds: -1e10 }, new Date());
    if (!verdict.eligible && verdict.code !== "closed") throw new Error(`source market not replayable: ${verdict.code} ${verdict.reason}`);
    if (!d.cfg.ORACLE_PUBKEYS[0]) throw new Error("ORACLE_PUBKEYS is empty");
    const closeAt = Math.floor(Date.now() / 1000) + 120;
    const replay: SourceMarket = { ...m, endDate: new Date(closeAt * 1000).toISOString() };
    const def = { ...importedDefinition(replay, "polymarket-ctf-v1-binary", 1), category: "historical replay" };
    const id = randomBytes(16).toString("hex");
    const t = now();
    run(d.db, `INSERT INTO markets(id, kind, status, question, rules, outcomes, category, close_at, timeout_at, source_provider, source_id,
               source_version, source_snapshot, profile, oracle_policy, oracle_keys, oracle_threshold, oracle_epoch, definition_hash, created_at, updated_at)
               VALUES (?, 'polymarket', 'activating', ?, ?, ?, 'historical replay', ?, ?, ?, ?, ?, ?, ?, 'platform-attestor', ?, ?, ?, ?, ?, ?)`,
        id, def.question, def.rules, JSON.stringify(def.outcomes), Number(def.closeAtUnix), Number(def.timeoutAtUnix),
        m.provider, `${m.sourceId}#replay-${id.slice(0, 8)}`, m.versionHash, JSON.stringify({ ...m, binding: def.source }), "polymarket-ctf-v1-binary",
        JSON.stringify(attestorSlots(d.cfg)), d.cfg.ORACLE_THRESHOLD, d.cfg.ORACLE_EPOCH, definitionHash(def), t, t);
    d.wf.enqueue(`activate:${id}`, "activate", id, {});
    return id;
}
