import { randomBytes } from "node:crypto";
import { hex } from "@scure/base";
import { definitionHash } from "../core/definition.js";
import { oracleSlots } from "../core/market.js";
import { all, now, one, run, setMeta, tx } from "./db.js";
import type { Deps } from "./markets.js";
import { importedDefinition } from "./sources/definition.js";
import type { MarketSourceProvider, ProviderName, SourceMarket } from "./sources/types.js";
import type { Workflows } from "./workflows.js";
import { sectionOf } from "../shared/sections.js";

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

type ImportDeps = Deps & { wf: Workflows; providers: MarketSourceProvider[]; timeoutDays: number; attestorProfiles?: () => Promise<Map<string, number>> };

export async function importOnce(d: ImportDeps, upcoming: SourceMarket[] = []): Promise<ImportResult> {
    const { db } = d;
    const result: ImportResult = { pages: 0, seen: 0, eligible: 0, activated: [], ineligibleByCode: {} };
    const errors: string[] = [];
    for (const provider of d.providers) {
        try {
            await importFrom(d, provider, upcoming.filter((m) => m.provider === provider.name), result);
        } catch (err) {
            errors.push(`${provider.name}: ${String(err).slice(0, 200)}`);
        }
    }
    setMeta(db, "import.lastRun", now());
    setMeta(db, "import.lastError", errors.length ? `${now()} ${errors.join("; ")}` : "");
    if (errors.length === d.providers.length && errors.length > 0) throw new Error(errors.join("; "));
    return result;
}

async function importFrom(d: ImportDeps, provider: MarketSourceProvider, upcoming: SourceMarket[], result: ImportResult): Promise<void> {
    const { cfg, db } = d;
    const tags = provider.name === "polymarket" ? cfg.IMPORT_TAGS : [];
    const policy = {
        profiles: [provider.profile], tags,
        maxHorizonSeconds: cfg.IMPORT_MAX_HORIZON_SECONDS, minHorizonSeconds: cfg.IMPORT_MIN_HORIZON_SECONDS,
    };
    const seen = new Set<string>();
    const record = (m: SourceMarket) => {
        const verdict = provider.evaluateEligibility(m, policy, new Date());
        upsertSource(d, m, verdict.eligible ? { eligible: true, profile: verdict.profile } : { eligible: false, code: verdict.code, reason: verdict.reason });
        return verdict;
    };
    const refuse = (m: SourceMarket, code: string, reason: string) => {
        upsertSource(d, m, { eligible: false, code, reason });
        result.ineligibleByCode[code] = (result.ineligibleByCode[code] ?? 0) + 1;
    };
    const consider = async (m: SourceMarket) => {
        result.seen++;
        seen.add(m.sourceId);
        const verdict = record(m);
        if (!verdict.eligible) {
            result.ineligibleByCode[verdict.code] = (result.ineligibleByCode[verdict.code] ?? 0) + 1;
            return;
        }
        result.eligible++;
        const id = await activate(d, provider, m, verdict.profile, refuse);
        if (id) result.activated.push(id);
    };
    // Markets named ahead of time (crypto Up/Down) go first: by volume they would rank too low before they start.
    for (const m of upcoming) await consider(m);
    // Discovery is ordered by 24h volume, so every pass starts from the busiest markets; one pass per tag when set.
    for (const tag of tags.length ? tags : [undefined]) {
        let cursor: string | null = null;
        for (let page = 0; page < cfg.IMPORT_MAX_PAGES; page++) {
            const { markets, next } = await provider.discoverMarkets(cursor, Math.min(cfg.IMPORT_PAGE_LIMIT, 100), tag ? { tag } : {});
            result.pages++;
            for (const m of markets) await consider(m);
            cursor = next;
            if (!next) break;
        }
    }
    // Funded markets outside the pages read still get fresh reference odds.
    const funded = all<{ source_id: string }>(db, "SELECT source_id FROM markets WHERE kind = 'polymarket' AND source_provider = ? AND oracle_policy != 'redstone' AND status IN ('open','halted','closed','resolving') AND source_id NOT LIKE '%#%'", provider.name);
    for (const { source_id } of funded) {
        if (seen.has(source_id)) continue;
        const m = await provider.fetchMarketDefinition(source_id).catch(() => null);
        if (m) record(m);
    }
}

export function upsertSource(d: Deps, m: SourceMarket, v: { eligible: boolean; code?: string; reason?: string; profile?: string }): void {
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
        // Display fields only, and only while the definition is the one the market was funded on.
        // Gamma's single-market endpoint omits events, so a missing image or event keeps the last one seen.
        run(d.db, `UPDATE markets SET source_snapshot = json_set(source_snapshot, '$.referencePrices', json(?), '$.fetchedAt', ?,
                   '$.image', COALESCE(?, json_extract(source_snapshot, '$.image')), '$.event', COALESCE(json(?), json(json_extract(source_snapshot, '$.event'))))
                   WHERE source_provider = ? AND source_id = ? AND source_version = ?`,
            JSON.stringify(m.referencePrices), m.fetchedAt, m.image, m.event ? JSON.stringify(m.event) : null, m.provider, m.sourceId, m.versionHash);
    });
}

/** Creates the market row once per source id and enqueues operator genesis, within the activation cap. */
async function activate(
    d: Deps & { wf: Workflows; timeoutDays: number; attestorProfiles?: () => Promise<Map<string, number>> },
    provider: MarketSourceProvider,
    m: SourceMarket,
    profile: string,
    refuse: (m: SourceMarket, code: string, reason: string) => void,
): Promise<string | undefined> {
    // Checked again after every await below: another import pass may have filled the slot meanwhile.
    const room = () => {
        if (one(d.db, "SELECT 1 FROM markets WHERE source_provider = ? AND source_id = ?", m.provider, m.sourceId)) return false;
        const live = all<{ source_provider: string; source_snapshot: string; question: string }>(d.db,
            "SELECT source_provider, source_snapshot, question FROM markets WHERE kind = 'polymarket' AND oracle_policy != 'redstone' AND status IN ('activating','open','halted','closed','resolving')");
        if (live.filter((r) => r.source_provider === m.provider).length >= d.cfg.IMPORT_MAX_ACTIVE || !d.cfg.ORACLE_PUBKEYS[0]) return false;
        if (d.cfg.IMPORT_MAX_PER_SECTION <= 0) return true;
        const section = sectionOf(m.tags, m.question);
        return live.filter((r) => sectionOf((JSON.parse(r.source_snapshot) as SourceMarket).tags ?? [], r.question) === section).length < d.cfg.IMPORT_MAX_PER_SECTION;
    };
    if (!room()) return undefined;
    // A market no attestor quorum can certify would lock its collateral until the timeout.
    if (d.attestorProfiles) {
        const serving = (await d.attestorProfiles()).get(profile) ?? 0;
        if (serving < d.cfg.ORACLE_THRESHOLD) {
            refuse(m, "no-attestor", `${serving} of the configured attestors serve ${profile}; ${d.cfg.ORACLE_THRESHOLD} needed`);
            return undefined;
        }
    }
    // Last gate before the operator funds anything: the chain, not the source API, says who may report the result.
    const vetted = await provider.vetSource?.(m);
    if (vetted && !vetted.ok) {
        refuse(m, "unvetted-source", vetted.reason);
        return undefined;
    }
    if (!room()) return undefined;
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
export async function replayHistorical(d: ImportDeps, sourceId: string, providerName: ProviderName = "polymarket"): Promise<string> {
    if (d.cfg.APM_NETWORK !== "regtest") throw new Error("historical replay is regtest-only");
    const provider = d.providers.find((p) => p.name === providerName);
    if (!provider) throw new Error(`historical replay needs the ${providerName} provider enabled`);
    const m = await provider.fetchMarketDefinition(sourceId);
    const verdict = provider.evaluateEligibility(m, { profiles: [provider.profile], tags: [], maxHorizonSeconds: 1e10, minHorizonSeconds: -1e10 }, new Date());
    if (!verdict.eligible && verdict.code !== "closed") throw new Error(`source market not replayable: ${verdict.code} ${verdict.reason}`);
    const vetted = await provider.vetSource?.(m);
    if (vetted && !vetted.ok) throw new Error(`source market not replayable: ${vetted.reason}`);
    if (!d.cfg.ORACLE_PUBKEYS[0]) throw new Error("ORACLE_PUBKEYS is empty");
    const closeAt = Math.floor(Date.now() / 1000) + 120;
    const replay: SourceMarket = { ...m, endDate: new Date(closeAt * 1000).toISOString() };
    const def = { ...importedDefinition(replay, provider.profile, 1), category: "historical replay" };
    const id = randomBytes(16).toString("hex");
    const t = now();
    run(d.db, `INSERT INTO markets(id, kind, status, question, rules, outcomes, category, close_at, timeout_at, source_provider, source_id,
               source_version, source_snapshot, profile, oracle_policy, oracle_keys, oracle_threshold, oracle_epoch, definition_hash, created_at, updated_at)
               VALUES (?, 'polymarket', 'activating', ?, ?, ?, 'historical replay', ?, ?, ?, ?, ?, ?, ?, 'platform-attestor', ?, ?, ?, ?, ?, ?)`,
        id, def.question, def.rules, JSON.stringify(def.outcomes), Number(def.closeAtUnix), Number(def.timeoutAtUnix),
        m.provider, `${m.sourceId}#replay-${id.slice(0, 8)}`, m.versionHash, JSON.stringify({ ...m, binding: def.source }), provider.profile,
        JSON.stringify(attestorSlots(d.cfg)), d.cfg.ORACLE_THRESHOLD, d.cfg.ORACLE_EPOCH, definitionHash(def), t, t);
    d.wf.enqueue(`activate:${id}`, "activate", id, {});
    return id;
}
