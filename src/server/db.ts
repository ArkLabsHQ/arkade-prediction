import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

const MIGRATIONS: string[] = [
    `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
     CREATE TABLE writer_lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, token INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL);
     CREATE TABLE source_markets (
        provider TEXT NOT NULL, source_id TEXT NOT NULL, version_hash TEXT NOT NULL, snapshot TEXT NOT NULL,
        eligible INTEGER NOT NULL, code TEXT, reason TEXT, profile TEXT, end_date TEXT,
        first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, PRIMARY KEY (provider, source_id));
     CREATE TABLE source_versions (
        provider TEXT NOT NULL, source_id TEXT NOT NULL, version_hash TEXT NOT NULL, snapshot TEXT NOT NULL,
        observed_at TEXT NOT NULL, PRIMARY KEY (provider, source_id, version_hash));
     CREATE TABLE markets (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('polymarket','custom')), status TEXT NOT NULL,
        question TEXT NOT NULL, rules TEXT NOT NULL, outcomes TEXT NOT NULL, category TEXT,
        close_at INTEGER NOT NULL, timeout_at INTEGER NOT NULL,
        source_provider TEXT, source_id TEXT, source_version TEXT, source_snapshot TEXT, profile TEXT,
        oracle_policy TEXT NOT NULL, oracle_keys TEXT NOT NULL, oracle_threshold INTEGER NOT NULL, oracle_epoch INTEGER NOT NULL,
        definition_hash TEXT NOT NULL, terms TEXT, base_sats TEXT, genesis_txid TEXT, vault_txid TEXT,
        resolution_status TEXT NOT NULL DEFAULT 'pending', resolution_detail TEXT NOT NULL DEFAULT '',
        unavailable_reason TEXT, vault_phase TEXT, vault_outcome TEXT, vault_value TEXT, vault_outpoint TEXT,
        vault_expires_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE (source_provider, source_id));
     CREATE INDEX markets_status ON markets(status);
     CREATE TABLE certificates (
        market_id TEXT NOT NULL REFERENCES markets(id), outcome TEXT NOT NULL, numerators TEXT NOT NULL,
        denominator TEXT NOT NULL, evidence_digest TEXT NOT NULL, evidence TEXT, signature TEXT NOT NULL,
        signer TEXT NOT NULL, source_block TEXT, issued_at TEXT NOT NULL, PRIMARY KEY (market_id, signature));
     CREATE TABLE offers (
        id TEXT PRIMARY KEY, market_id TEXT NOT NULL REFERENCES markets(id), outcome TEXT NOT NULL, side TEXT NOT NULL,
        terms TEXT NOT NULL, script TEXT NOT NULL, maker_script TEXT NOT NULL, coin TEXT, status TEXT NOT NULL,
        remaining TEXT NOT NULL, funding_txid TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE INDEX offers_market ON offers(market_id, status);
     CREATE INDEX offers_maker ON offers(maker_script);
     CREATE INDEX offers_script ON offers(script);
     CREATE TABLE trades (
        txid TEXT NOT NULL, offer_id TEXT NOT NULL, market_id TEXT NOT NULL, outcome TEXT NOT NULL, kind TEXT NOT NULL,
        maker_side TEXT NOT NULL, qty TEXT NOT NULL, price_sats TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (txid, offer_id));
     CREATE INDEX trades_market ON trades(market_id, at);
     CREATE TABLE workflows (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, market_id TEXT, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        payload TEXT NOT NULL, txid TEXT, error TEXT, next_at INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE INDEX workflows_due ON workflows(state, next_at);
     CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, market_id TEXT, at TEXT NOT NULL, data TEXT NOT NULL);`,
    `CREATE TABLE boxes (
        script TEXT PRIMARY KEY, market_id TEXT NOT NULL REFERENCES markets(id), owner TEXT NOT NULL, owner_script TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'watching', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
     CREATE INDEX boxes_market ON boxes(market_id, status);
     CREATE INDEX boxes_owner ON boxes(owner_script);`,
    // Vaults built with the retired single-attestor template cannot be driven by this build.
    `UPDATE markets SET status = 'failed', resolution_detail = 'built with the retired single-attestor vault template; settle it with the previous release'
     WHERE terms IS NOT NULL AND json_extract(terms, '$.oracleKeys') IS NULL AND status != 'hidden';`,
];

export type Db = DatabaseSync;
export type Row = Record<string, SQLInputValue>;

export function openDb(path: string): Db {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    // Money-moving workflow rows must survive power loss: WAL + FULL fsync, bounded lock waits.
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    const version = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
    for (let v = version; v < MIGRATIONS.length; v++) {
        tx(db, () => {
            db.exec(MIGRATIONS[v]!);
            db.exec(`PRAGMA user_version = ${v + 1}`);
        });
    }
    return db;
}

/** BEGIN IMMEDIATE takes the write lock up front so read-then-write sequences cannot interleave. */
export function tx<T>(db: Db, fn: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
        const out = fn();
        db.exec("COMMIT");
        return out;
    } catch (err) {
        db.exec("ROLLBACK");
        throw err;
    }
}

export const all = <T>(db: Db, sql: string, ...args: SQLInputValue[]) => db.prepare(sql).all(...args) as T[];
export const one = <T>(db: Db, sql: string, ...args: SQLInputValue[]) => db.prepare(sql).get(...args) as T | undefined;
export const run = (db: Db, sql: string, ...args: SQLInputValue[]) => db.prepare(sql).run(...args);
export const now = () => new Date().toISOString();

export function getMeta(db: Db, key: string): string | undefined {
    return one<{ value: string }>(db, "SELECT value FROM meta WHERE key = ?", key)?.value;
}

export function setMeta(db: Db, key: string, value: string): void {
    run(db, "INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

/** Consistent online backup (VACUUM INTO copies a snapshot including WAL contents). */
export function backup(db: Db, target: string): void {
    run(db, "VACUUM INTO ?", target);
}
