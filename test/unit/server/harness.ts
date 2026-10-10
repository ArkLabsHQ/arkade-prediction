import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hex } from "@scure/base";
import { assetIdOf } from "../../../src/core/assets.js";
import { run, openDb, now, type Db } from "../../../src/server/db.js";
import { EventBus } from "../../../src/server/events.js";
import { Keeper, type KeeperDeps } from "../../../src/server/keeper.js";
import { WriterLease } from "../../../src/server/lease.js";
import { Workflows } from "../../../src/server/workflows.js";
import type { OfferTermsJson } from "../../../src/shared/api.js";

export const GENESIS = "ab".repeat(32);
export const ASSETS = { ctrl: assetIdOf(GENESIS, 0), yes: assetIdOf(GENESIS, 1), no: assetIdOf(GENESIS, 2) };
export const MAKER = "11".repeat(32);
export const P2TR = (tag: string) => `5120${tag.repeat(32).slice(0, 64)}`;

export interface Fakes {
    virtualTxs: string[];
    vtxos: Record<string, unknown>[];
}

export interface Harness {
    db: Db;
    path: string;
    wf: Workflows;
    lease: WriterLease;
    keeper: Keeper;
    fakes: Fakes;
    deps: KeeperDeps;
}

export function tempDb(): { db: Db; path: string } {
    const path = join(mkdtempSync(join(tmpdir(), "apm-wf-")), "apm.sqlite");
    return { db: openDb(path), path };
}

export function harness(overrides: Partial<KeeperDeps> = {}): Harness {
    const { db, path } = tempDb();
    const lease = new WriterLease(db);
    lease.tryAcquire();
    const wf = new Workflows(db, lease);
    const bus = new EventBus(db);
    const fakes: Fakes = { virtualTxs: [], vtxos: [] };
    const indexer = {
        getVirtualTxs: async () => ({ txs: fakes.virtualTxs }),
        getVtxos: async (q: { outpoints?: { txid: string; vout: number }[] } = {}) => ({
            vtxos: q.outpoints ? fakes.vtxos.filter((v) => q.outpoints!.some((o) => o.txid === v.txid && o.vout === v.vout)) : fakes.vtxos,
        }),
    };
    const deps = {
        cfg: { APM_NETWORK: "regtest", RENEW_THRESHOLD_SECONDS: 3600, MARKET_UNIT_SATS: 1000, LP_BOOTSTRAP_SETS: 0, LP_SKEW_BPS: 0, LP_MAX_SETS_PER_MARKET: 0 },
        db, bus, wf, lease, keeperScript: new Uint8Array(34),
        net: { indexer, ctx: {}, exitDelaySeconds: 512n },
        log: () => {},
        ...overrides,
    } as unknown as KeeperDeps;
    return { db, path, wf, lease, keeper: new Keeper(deps), fakes, deps };
}

/** Reaches the keeper's private planners the way the review probes do. */
export const inner = (k: Keeper) =>
    k as unknown as { plan(): Promise<void>; handle(wf: unknown): Promise<string | undefined> };

export function marketTermsJson(o: { closeAt: number; timeoutAt: number; unit?: string; cap?: string }) {
    return {
        assets: ASSETS,
        unitSats: o.unit ?? "1000",
        capSats: o.cap ?? "1001000",
        oracleKeys: ["22".repeat(32), "22".repeat(32), "22".repeat(32)],
        oracleThreshold: 1,
        binding: "33".repeat(32),
        closeAtUnix: String(o.closeAt),
        timeoutAtUnix: String(o.timeoutAt),
        exitDelaySeconds: "512",
    };
}

export function insertMarket(db: Db, o: {
    id: string;
    status?: string;
    closeAt?: number;
    timeoutAt?: number;
    phase?: string | null;
    vaultValue?: string | null;
    terms?: ReturnType<typeof marketTermsJson> | null;
    cap?: string;
}): void {
    const closeAt = o.closeAt ?? Math.floor(Date.now() / 1000) + 86_400;
    const timeoutAt = o.timeoutAt ?? closeAt + 86_400;
    const terms = o.terms === null ? null : JSON.stringify(o.terms ?? marketTermsJson({ closeAt, timeoutAt, cap: o.cap }));
    const t = now();
    run(db, `INSERT INTO markets(id, kind, status, question, rules, outcomes, close_at, timeout_at, oracle_policy,
             oracle_keys, oracle_threshold, oracle_epoch, definition_hash, terms, base_sats, vault_phase, vault_value,
             created_at, updated_at)
             VALUES (?, 'custom', ?, 'q', 'r', '["Yes","No"]', ?, ?, 'external-key', ?, 1, 1, 'dh', ?, '1000', ?, ?, ?, ?)`,
        o.id, o.status ?? "open", closeAt, timeoutAt, JSON.stringify(["22".repeat(32)]), terms,
        o.phase === undefined ? "open" : o.phase, o.vaultValue === undefined ? "1000" : o.vaultValue, t, t);
}

export function offerTerms(o: Partial<OfferTermsJson> & { outcome: "yes" | "no"; priceSats: string }): OfferTermsJson {
    return {
        side: "buy", maker: MAKER, makerScript: P2TR("aa"), assetId: ASSETS[o.outcome],
        priceSats: o.priceSats, minFill: o.minFill ?? "1", expiresAtUnix: o.expiresAtUnix ?? "0",
        reserveSats: o.reserveSats ?? "330", exitDelaySeconds: "512",
        ...(o.side ? { side: o.side } : {}),
        ...(o.makerScript ? { makerScript: o.makerScript } : {}),
    };
}

/** A funded buy offer whose coin holds exactly `remaining` units of budget plus the reserve. */
export function insertBuyOffer(db: Db, o: {
    id: string;
    marketId: string;
    outcome: "yes" | "no";
    priceSats: bigint;
    remaining: bigint;
    minFill?: bigint;
    makerScript?: string;
    status?: string;
}): void {
    const reserve = 330n;
    const value = reserve + o.remaining * o.priceSats;
    const terms = offerTerms({
        outcome: o.outcome, priceSats: String(o.priceSats), minFill: String(o.minFill ?? 1n),
        reserveSats: String(reserve), makerScript: o.makerScript,
    });
    const coin = { txid: o.id, vout: 0, valueSats: String(value), assets: [], expiresAt: null };
    const t = now();
    run(db, `INSERT INTO offers(id, market_id, outcome, side, terms, script, maker_script, coin, status, remaining,
             funding_txid, created_at, updated_at) VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        `${o.id}:0`, o.marketId, o.outcome, JSON.stringify(terms), hex.encode(new Uint8Array(34)) + o.id,
        terms.makerScript, JSON.stringify(coin), o.status ?? "open", String(o.remaining), o.id, t, t);
}
