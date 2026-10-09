import { isAttestorKeyHex } from "../core/attestation.js";
import { hex } from "@scure/base";
import { AuditError, auditGenesis as auditMarketGenesis } from "../core/audit.js";
import { bindingOf, definitionHash, type MarketDefinition } from "../core/definition.js";
import { marketContracts, oracleSlots, type VaultTerms } from "../core/market.js";
import {
    MAX_TIMEOUT_AFTER_CLOSE_SECONDS,
    termsFromJson,
    termsToJson,
    type CertificateJson,
    type CreateMarketRequest,
    type MarketJson,
    type MarketTermsJson,
    type MarketStatus,
    type OraclePolicy,
} from "../shared/api.js";
import type { Config } from "./config.js";
import { all, now, one, run, type Db } from "./db.js";
import type { EventBus } from "./events.js";
import type { NetworkHandle } from "./network.js";

export interface Deps {
    cfg: Config;
    db: Db;
    net: NetworkHandle;
    bus: EventBus;
    devOracleKey?: string;
}

export class HttpError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message);
    }
}

export interface MarketRow {
    id: string;
    kind: "polymarket" | "custom";
    status: MarketStatus;
    question: string;
    rules: string;
    outcomes: string;
    category: string | null;
    close_at: number;
    timeout_at: number;
    source_provider: string | null;
    source_id: string | null;
    source_version: string | null;
    source_snapshot: string | null;
    profile: string | null;
    oracle_policy: OraclePolicy;
    oracle_keys: string;
    oracle_threshold: number;
    oracle_epoch: number;
    definition_hash: string;
    terms: string | null;
    base_sats: string | null;
    genesis_txid: string | null;
    vault_txid: string | null;
    resolution_status: string;
    resolution_detail: string;
    unavailable_reason: string | null;
    vault_phase: "open" | "resolved" | null;
    vault_outcome: "yes" | "no" | "invalid" | null;
    vault_value: string | null;
    vault_outpoint: string | null;
    vault_expires_at: string | null;
    created_at: string;
    updated_at: string;
}

export const getMarket = (db: Db, id: string) => one<MarketRow>(db, "SELECT * FROM markets WHERE id = ?", id);
/** Undefined for markets without terms and for the retired single-attestor template (migration 2 fails those). */
export function marketTerms(row: MarketRow): VaultTerms | undefined {
    if (!row.terms) return undefined;
    const json = JSON.parse(row.terms) as MarketTermsJson;
    return Array.isArray(json.oracleKeys) ? termsFromJson(json) : undefined;
}

const bounded = (s: unknown, max: number, field: string): string => {
    if (typeof s !== "string" || s.trim().length === 0 || s.length > max) throw new HttpError(400, "invalid-field", `${field} must be 1..${max} characters`);
    return s.trim();
};

/** The core genesis audit (src/core/audit.ts) with its refusals mapped to HTTP errors. */
export async function auditGenesis(net: NetworkHandle, terms: VaultTerms, genesisTxid: string, vaultTxid: string): Promise<{ seed: bigint; baseSats: bigint }> {
    try {
        return await auditMarketGenesis(net, terms, genesisTxid, vaultTxid);
    } catch (e) {
        if (e instanceof AuditError) throw new HttpError(e.code === "tx-not-found" ? 404 : 400, e.code, e.message);
        throw e;
    }
}

export async function registerCustomMarket(d: Deps, req: CreateMarketRequest): Promise<MarketRow> {
    if (!/^[0-9a-f]{32}$/.test(req.marketId)) throw new HttpError(400, "market-id", "marketId must be 16 random bytes (hex)");
    if (getMarket(d.db, req.marketId)) throw new HttpError(409, "exists", "market already registered");
    const definition: MarketDefinition = {
        question: bounded(req.question, 300, "question"),
        rules: bounded(req.rules, 10_000, "rules"),
        outcomes: [bounded(req.outcomes?.[0], 40, "outcome 1"), bounded(req.outcomes?.[1], 40, "outcome 2")],
        category: req.category ? bounded(req.category, 40, "category") : null,
        closeAtUnix: String(BigInt(req.closeAtUnix)),
        timeoutAtUnix: String(BigInt(req.timeoutAtUnix)),
        source: null,
    };
    const nowS = BigInt(Math.floor(Date.now() / 1000));
    const closeAt = BigInt(definition.closeAtUnix);
    const timeoutAt = BigInt(definition.timeoutAtUnix);
    if (closeAt < nowS + 60n || closeAt > nowS + BigInt(d.cfg.IMPORT_MAX_HORIZON_SECONDS)) throw new HttpError(400, "close-time", "close time outside the allowed horizon");
    // A timeout of 0 compiles to a timeout leaf that never succeeds: one-sided holders could never redeem.
    if (timeoutAt <= closeAt || timeoutAt > closeAt + BigInt(MAX_TIMEOUT_AFTER_CLOSE_SECONDS)) {
        throw new HttpError(400, "timeout", "timeout must be after close and at most 365 days after it");
    }
    const policy = req.oracle?.policy;
    if (policy !== "external-key" && policy !== "dev-oracle") throw new HttpError(400, "oracle-policy", "unsupported oracle policy");
    const keys = Array.isArray(req.oracle.keys) ? req.oracle.keys : [];
    if (!keys.every((k) => typeof k === "string" && isAttestorKeyHex(k))) throw new HttpError(400, "oracle-key", "oracle keys must be x-only (64 hex) or 0x10/0x11 ECDSA (68 hex)");
    if (policy === "dev-oracle" && (d.cfg.APM_NETWORK !== "regtest" || keys.some((k) => k !== d.devOracleKey))) throw new HttpError(400, "oracle-policy", "dev oracle is regtest-only and must use the server dev key");
    let slots: string[];
    try {
        slots = oracleSlots(keys.map((k) => hex.decode(k)), req.oracle.threshold).map((k) => hex.encode(k));
    } catch (err) {
        throw new HttpError(400, "oracle-set", (err as Error).message);
    }

    const terms = termsFromJson(req.terms);
    const expected = bindingOf({
        network: d.cfg.APM_NETWORK, arkSigner: d.net.ark.serverKey, emulatorSigner: d.net.ark.emulatorKey!,
        marketId: req.marketId, definition, unitSats: terms.unitSats, assets: terms.assets,
        oracleKeys: slots, oracleThreshold: req.oracle.threshold, oracleEpoch: 1,
    });
    if (hex.encode(expected) !== hex.encode(terms.binding)) throw new HttpError(400, "binding", "terms.binding does not commit to this definition");
    if (terms.oracleKeys.map((k) => hex.encode(k)).join() !== slots.join() || terms.oracleThreshold !== req.oracle.threshold) {
        throw new HttpError(400, "oracle-key", "terms attestor set differs from the oracle policy");
    }
    if (terms.closeAt !== closeAt || terms.timeoutAt !== timeoutAt) throw new HttpError(400, "timing", "terms timing differs from the definition");
    if (terms.exitDelaySeconds < d.net.exitDelaySeconds) throw new HttpError(400, "exit-delay", "exit delay below the operator minimum");
    if (terms.unitSats < 100n || terms.unitSats > 1_000_000n || terms.unitSats % 2n !== 0n) throw new HttpError(400, "unit", "unit must be an even number of sats in [100, 1000000]");
    if (terms.capSats > terms.unitSats * BigInt(d.cfg.MARKET_CAP_SETS) + 1_000_000n) throw new HttpError(400, "cap", "open-interest cap above the server limit");

    const { baseSats } = await auditGenesis(d.net, terms, req.genesisTxid, req.vaultTxid);
    const t = now();
    run(d.db, `INSERT INTO markets(id, kind, status, question, rules, outcomes, category, close_at, timeout_at, oracle_policy, oracle_keys,
               oracle_threshold, oracle_epoch, definition_hash, terms, base_sats, genesis_txid, vault_txid, created_at, updated_at)
               VALUES (?, 'custom', 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`,
        req.marketId, definition.question, definition.rules, JSON.stringify(definition.outcomes), definition.category,
        Number(closeAt), Number(timeoutAt), policy, JSON.stringify(slots), req.oracle.threshold, definitionHash(definition),
        JSON.stringify(termsToJson(terms)), String(baseSats), req.genesisTxid, req.vaultTxid, t, t);
    d.bus.publish("market", req.marketId, { status: "open" });
    return getMarket(d.db, req.marketId)!;
}

export function listMarkets(db: Db, f: { status?: string; kind?: string; q?: string; limit: number; cursor?: string }): MarketRow[] {
    const like = f.q ? `%${f.q.replace(/[%_]/g, "")}%` : null;
    return all<MarketRow>(db,
        `SELECT * FROM markets WHERE status != 'hidden' AND (? IS NULL OR status = ?) AND (? IS NULL OR kind = ?)
         AND (? IS NULL OR question LIKE ?) AND (? IS NULL OR created_at < ?) ORDER BY created_at DESC LIMIT ?`,
        f.status ?? null, f.status ?? null, f.kind ?? null, f.kind ?? null, like, like, f.cursor ?? null, f.cursor ?? null, f.limit);
}

function bookOf(db: Db, marketId: string) {
    const best = (outcome: string, side: string, agg: "MIN" | "MAX") =>
        one<{ p: number | null }>(db, `SELECT ${agg}(CAST(json_extract(terms, '$.priceSats') AS INTEGER)) p FROM offers WHERE market_id = ? AND outcome = ? AND side = ? AND status = 'open' AND json_extract(terms, '$.legacy') IS NULL`, marketId, outcome, side)?.p ?? null;
    const side = (o: string) => ({ bid: best(o, "buy", "MAX")?.toString() ?? null, ask: best(o, "sell", "MIN")?.toString() ?? null });
    return { yes: side("yes"), no: side("no") };
}

export function marketJson(db: Db, row: MarketRow): MarketJson {
    const cert = one<{ outcome: CertificateJson["outcome"]; numerators: string; denominator: string; evidence_digest: string; signature: string; signer: string; source_block: string | null; issued_at: string }>(
        db, "SELECT * FROM certificates WHERE market_id = ? ORDER BY issued_at LIMIT 1", row.id);
    const stats = one<{ n: number; vol: number | null }>(db, "SELECT COUNT(*) n, SUM(CAST(qty AS INTEGER) * CAST(price_sats AS INTEGER)) vol FROM trades WHERE market_id = ?", row.id)!;
    const terms = row.terms ? JSON.parse(row.terms) : null;
    const unit = terms ? BigInt(terms.unitSats) : 1n;
    const value = row.vault_value ? BigInt(row.vault_value) : null;
    const snapshot = row.source_snapshot ? JSON.parse(row.source_snapshot) : null;
    return {
        id: row.id,
        kind: row.kind,
        status: row.status,
        question: row.question,
        rules: row.rules,
        outcomes: JSON.parse(row.outcomes),
        category: row.category,
        closeAt: new Date(row.close_at * 1000).toISOString(),
        createdAt: row.created_at,
        source: snapshot && {
            provider: "polymarket", sourceId: snapshot.sourceId, url: snapshot.url, slug: snapshot.slug,
            protocol: snapshot.protocol?.version ?? "unknown", conditionId: snapshot.protocol?.conditionId,
            questionId: snapshot.protocol?.questionId, resolver: snapshot.protocol?.resolver ?? null,
            resolutionSource: snapshot.resolutionSource ?? "",
            referencePrices: snapshot.referencePrices?.map((p: { outcome: string; price: string }) => ({ ...p, asOf: snapshot.fetchedAt })) ?? null,
            sourceStatus: snapshot.sourceStatus ?? null,
            image: snapshot.image ?? null,
            event: snapshot.event ?? null,
            clarifications: all<{ observed_at: string; version_hash: string }>(db,
                "SELECT observed_at, version_hash FROM source_versions WHERE provider = ? AND source_id = ? AND version_hash != ? ORDER BY observed_at",
                row.source_provider, row.source_id, row.source_version).map((v) => ({ observedAt: v.observed_at, note: `source definition changed (version ${v.version_hash.slice(0, 12)}); funded terms unchanged` })),
            binding: snapshot.binding ?? null,
        },
        oracle: {
            policy: row.oracle_policy, keys: JSON.parse(row.oracle_keys), threshold: row.oracle_threshold, epoch: row.oracle_epoch,
            label: { "platform-attestor": "Platform attestor (verifies the source on-chain)", "external-key": "Creator-designated oracle key", "dev-oracle": "Development oracle (regtest only)", redstone: "RedStone signed prices, checked by the vault itself" }[row.oracle_policy],
        },
        terms,
        genesisTxid: row.genesis_txid,
        vaultTxid: row.vault_txid,
        vault: { phase: row.vault_phase ?? "open", outcome: row.vault_outcome, valueSats: row.vault_value, outpoint: row.vault_outpoint, expiresAt: row.vault_expires_at },
        resolution: {
            status: row.resolution_status, detail: row.resolution_detail,
            certificate: cert ? {
                outcome: cert.outcome, numerators: JSON.parse(cert.numerators), denominator: cert.denominator, evidenceDigest: cert.evidence_digest,
                signature: cert.signature, signer: cert.signer, sourceBlock: cert.source_block ? JSON.parse(cert.source_block) : null, issuedAt: cert.issued_at,
            } : null,
        },
        book: bookOf(db, row.id),
        stats: {
            openInterestSets: value !== null && row.base_sats && row.vault_phase !== "resolved" ? ((value - BigInt(row.base_sats)) / unit).toString() : "0",
            collateralSats: row.vault_value ?? "0",
            volumeSats: String(stats.vol ?? 0),
            trades: stats.n,
        },
    };
}

/** Finds the live vault coin (open or resolved) and caches its state on the market row. */
export async function reconcileVault(d: Deps, row: MarketRow): Promise<void> {
    const terms = marketTerms(row);
    if (!terms) return;
    const { vault, resolved } = marketContracts(d.net.ark, terms);
    const candidates: [string, "open" | "resolved", "yes" | "no" | "invalid" | null][] = [
        [hex.encode(vault.pkScript), "open", null],
        [hex.encode(resolved.yes.pkScript), "resolved", "yes"],
        [hex.encode(resolved.no.pkScript), "resolved", "no"],
        [hex.encode(resolved.invalid.pkScript), "resolved", "invalid"],
    ];
    const { vtxos } = await d.net.indexer.getVtxos({ scripts: candidates.map((c) => c[0]), spendableOnly: true });
    // Stray coins paid to a vault script are ignored: the vault is the coin carrying CTRL.
    const live = vtxos.filter((v) => !v.isSpent && v.assets?.some((a) => a.assetId === terms.assets.ctrl));
    if (live.length === 0) return;
    const coin = live.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
    const [, phase, outcome] = candidates.find((c) => c[0] === coin.script)!;
    const nowS = Date.now() / 1000;
    // Before close, an early source result or a certificate means the outcome is known: trading halts.
    const status: MarketStatus = phase === "resolved" ? "resolved"
        : nowS >= row.close_at ? (row.resolution_status === "certified" ? "resolving" : "closed")
        : row.resolution_status === "source-final" || row.resolution_status === "certified" ? "halted" : "open";
    const changed = row.vault_outpoint !== `${coin.txid}:${coin.vout}` || row.status !== status;
    run(d.db, "UPDATE markets SET vault_phase = ?, vault_outcome = ?, vault_value = ?, vault_outpoint = ?, vault_expires_at = ?, status = CASE WHEN status IN ('hidden','failed','activating') THEN status ELSE ? END, resolution_status = CASE WHEN ? = 'resolved' THEN 'resolved' ELSE resolution_status END, updated_at = ? WHERE id = ?",
        phase, outcome, String(coin.value), `${coin.txid}:${coin.vout}`, coin.expiresAt?.toISOString() ?? null, status, phase, now(), row.id);
    if (changed) d.bus.publish("market", row.id, { status, vault: { phase, outcome, value: coin.value } });
}
