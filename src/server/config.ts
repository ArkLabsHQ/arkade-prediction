import { readFileSync } from "node:fs";
import { attestorPublicKey, isAttestorKeyHex } from "../core/attestation.js";
import { hex } from "@scure/base";
import { defaultEndpoints } from "../core/endpoints.js";
import { oracleSlots } from "../core/market.js";
import { DEFAULT_CREATORS, DEFAULT_NEG_RISK_ORACLES } from "./sources/polymarket/index.js";
import { join } from "node:path";
import { z } from "zod";

export const EMBEDDED_ATTESTOR_PORT = 37410;
export const EMBEDDED_ATTESTOR_URL = `http://127.0.0.1:${EMBEDDED_ATTESTOR_PORT}`;

/** `NAME_FILE` wins over `NAME` so secrets can be mounted instead of passed as env values. */
function secret(env: NodeJS.ProcessEnv, name: string): string | undefined {
    const file = env[`${name}_FILE`];
    if (file) return readFileSync(file, "utf8").trim();
    return env[name]?.trim() || undefined;
}

const csv = z
    .string()
    .default("")
    .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean));
const bool = z
    .enum(["true", "false", "1", "0"])
    .default("false")
    .transform((v) => v === "true" || v === "1");
const int = (def: number) => z.coerce.number().int().nonnegative().default(def);
// fetch() refuses user:password URLs with an error that quotes them, and the resolver publishes that error.
const noCredentials = z.url().refine((u) => !URL.canParse(u) || (!new URL(u).username && !new URL(u).password), "must not embed credentials");
const hexKey = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));

const schema = z.object({
    APM_NETWORK: z.enum(["regtest", "mutinynet"]),
    // A label stored in the data volume so it cannot be reused by another deployment by mistake.
    APM_DEPLOYMENT_ID: z.string().min(1).max(64).optional(),
    HOST: z.string().default("0.0.0.0"),
    PORT: int(37400),
    // Operator API and console, unauthenticated: expose it only behind an access-controlled edge.
    ADMIN_PORT: int(37401),
    ARK_SERVER_URL: z.url().optional(),
    EMULATOR_URL: z.url().optional(),
    ESPLORA_URL: z.url().optional(),
    EXPLORER_URL: z.url().optional(),
    PUBLIC_ARK_SERVER_URL: z.url().optional(),
    PUBLIC_EMULATOR_URL: z.url().optional(),
    PUBLIC_ESPLORA_URL: z.url().optional(),
    ARK_SIGNER_PUBKEY: hexKey(33).optional(),
    EMULATOR_PUBKEY: hexKey(33).optional(),
    DATA_DIR: z.string().default("/data"),
    ORACLE_URL: noCredentials.optional(),
    ORACLE_URLS: csv.refine((urls) => urls.every((u) => URL.canParse(u) && !new URL(u).username && !new URL(u).password), "attestor URLs must be URLs without credentials"),
    ORACLE_PUBKEYS: csv.refine((keys) => keys.every(isAttestorKeyHex), "attestor keys are x-only (64 hex) or 0x10/0x11 ECDSA (68 hex)"),
    ORACLE_KEY_SCHEME: z.enum(["schnorr", "ecdsa-secp256k1", "ecdsa-p256"]).default("schnorr"),
    ORACLE_THRESHOLD: int(1),
    ORACLE_EPOCH: int(1),
    POLYMARKET_ENABLED: bool,
    POLYMARKET_GAMMA_URL: z.url().default("https://gamma-api.polymarket.com"),
    POLYGON_RPC_URLS: csv,
    // Proof tracking (observation only): historical eth_call needs archive providers, which publicnode is not.
    ZK_TRACKING_ENABLED: bool,
    POLYGON_ARCHIVE_RPC_URLS: csv.default(["https://polygon.gateway.tenderly.co", "https://polygon.drpc.org"]),
    ETHEREUM_RPC_URLS: csv.default(["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"]),
    POLYMARKET_RESOLVERS: csv,
    // Who may report a mirrored condition; the resolver allowlist above does not authenticate one (DECISIONS #46).
    POLYMARKET_CREATORS: csv.default(DEFAULT_CREATORS),
    POLYMARKET_NEGRISK_ORACLES: csv.default(DEFAULT_NEG_RISK_ORACLES),
    KALSHI_ENABLED: bool,
    KALSHI_API_URL: z.url().default("https://api.elections.kalshi.com/trade-api/v2"),
    MANIFOLD_ENABLED: bool,
    MANIFOLD_API_URL: z.url().default("https://api.manifold.markets/v0"),
    // Polymarket tag slugs: each gets its own discovery pass, and imports must carry one of them.
    IMPORT_TAGS: csv,
    // Per provider.
    IMPORT_MAX_ACTIVE: int(5),
    // Per browse section (Sports, Crypto, ...) across providers; 0 = no cap.
    IMPORT_MAX_PER_SECTION: int(0),
    // Polymarket crypto Up/Down mirrors settled on RedStone's signed rounds (off unless enabled).
    UPDOWN_ENABLED: bool,
    // polymarket: mirror through the CTF path and settle on Polymarket's own on-chain result (via our attestor);
    // redstone: settle in-covenant on RedStone's signed rounds.
    UPDOWN_SETTLEMENT: z.enum(["polymarket", "redstone"]).default("redstone"),
    UPDOWN_MAX_ACTIVE: int(4),
    UPDOWN_WINDOWS: csv.default(["15m", "4h"]),
    UPDOWN_ASSETS: csv.default(["BTC", "ETH", "SOL", "XRP", "DOGE", "BNB"]),
    UPDOWN_LEAD_SECONDS: int(7200),
    UPDOWN_TIMEOUT_SECONDS: int(3600),
    IMPORT_MIN_HORIZON_SECONDS: int(3600),
    IMPORT_MAX_HORIZON_SECONDS: int(30 * 86400),
    IMPORT_INTERVAL_SECONDS: int(600),
    IMPORT_PAGE_LIMIT: int(100),
    IMPORT_MAX_PAGES: int(5),
    RESOLUTION_INTERVAL_SECONDS: int(120),
    IMPORT_TIMEOUT_DAYS: int(60),
    MARKET_UNIT_SATS: int(1000),
    MARKET_BASE_SATS: int(1000),
    MARKET_CAP_SETS: int(1000),
    KEEPER_INTERVAL_SECONDS: int(15),
    RENEW_THRESHOLD_SECONDS: int(3600),
    LP_BOOTSTRAP_SETS: int(0),
    LP_ASK_YES_SATS: int(0),
    LP_ASK_NO_SATS: int(0),
    DEV_ENDPOINTS: bool,
    WORKERS: z.enum(["all", "none"]).default("all"),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Config = Omit<z.infer<typeof schema>, "APM_DEPLOYMENT_ID" | "ARK_SERVER_URL" | "EMULATOR_URL" | "ESPLORA_URL"> & {
    APM_DEPLOYMENT_ID: string;
    ARK_SERVER_URL: string;
    EMULATOR_URL: string;
    ESPLORA_URL: string;
    OPERATOR_MNEMONIC: string | undefined;
    LP_MNEMONIC: string | undefined;
    DEV_ORACLE_SECRET: string | undefined;
    ORACLE_SECRET_KEY: string | undefined;
    DB_PATH: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    // Compose passes unset optional variables as empty strings.
    const parsed = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")));
    if (!parsed.success) {
        const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
        throw new Error(`invalid configuration: ${issues}`);
    }
    const c = parsed.data;
    if (c.APM_NETWORK !== "regtest") {
        if (c.DEV_ENDPOINTS) throw new Error("DEV_ENDPOINTS is only allowed on regtest");
    }
    if (c.MARKET_UNIT_SATS % 2 !== 0) throw new Error("MARKET_UNIT_SATS must be even");
    if (c.MARKET_UNIT_SATS < 330) throw new Error("MARKET_UNIT_SATS must be at least 330 so one set is a valid bet");
    // ORACLE_SECRET_KEY on the app runs a local attestor beside it (see embeddedAttestor.ts): one container.
    const attestorSecret = secret(env, "ORACLE_SECRET_KEY");
    if (c.POLYMARKET_ENABLED && c.POLYGON_RPC_URLS.length < 2) throw new Error("POLYGON_RPC_URLS needs at least two providers");
    // The embedded attestor serves Polymarket only with two RPCs; with no source at all it would exit in a loop.
    if (attestorSecret && c.POLYGON_RPC_URLS.length < 2 && !c.KALSHI_ENABLED && !c.MANIFOLD_ENABLED) {
        throw new Error("ORACLE_SECRET_KEY runs an attestor that needs a source: POLYGON_RPC_URLS (two providers), KALSHI_ENABLED or MANIFOLD_ENABLED");
    }
    if (attestorSecret !== undefined && !/^[0-9a-f]{64}$/.test(attestorSecret)) throw new Error(`ORACLE_SECRET_KEY must be 64 lowercase hex characters; ${hexProblem(attestorSecret)}`);
    const embeddedKey = attestorSecret && hex.encode(attestorPublicKey(c.ORACLE_KEY_SCHEME, hex.decode(attestorSecret)));
    const oraclePubkeys = c.ORACLE_PUBKEYS.length > 0 ? c.ORACLE_PUBKEYS : embeddedKey ? [embeddedKey] : [];
    if (oraclePubkeys.length > 0) oracleSlots(oraclePubkeys.map((k) => hex.decode(k)), c.ORACLE_THRESHOLD);
    const defaults = defaultEndpoints(c.APM_NETWORK);
    const endpoint = (name: string, value: string | undefined) => {
        if (!value) throw new Error(`${name} is required on ${c.APM_NETWORK} (no published default)`);
        return value;
    };
    return {
        ...c,
        APM_DEPLOYMENT_ID: c.APM_DEPLOYMENT_ID ?? `apm-${c.APM_NETWORK}`,
        ARK_SERVER_URL: endpoint("ARK_SERVER_URL", c.ARK_SERVER_URL ?? defaults.arkServer),
        EMULATOR_URL: endpoint("EMULATOR_URL", c.EMULATOR_URL ?? defaults.emulator),
        ESPLORA_URL: endpoint("ESPLORA_URL", c.ESPLORA_URL ?? defaults.esplora),
        ORACLE_URLS: [...new Set([...c.ORACLE_URLS, ...(c.ORACLE_URL ? [c.ORACLE_URL] : []), ...(attestorSecret ? [EMBEDDED_ATTESTOR_URL] : [])])],
        ORACLE_PUBKEYS: oraclePubkeys,
        ORACLE_SECRET_KEY: attestorSecret,
        OPERATOR_MNEMONIC: secret(env, "OPERATOR_MNEMONIC"),
        LP_MNEMONIC: secret(env, "LP_MNEMONIC"),
        DEV_ORACLE_SECRET: c.APM_NETWORK === "regtest" ? secret(env, "DEV_ORACLE_SECRET") : undefined,
        DB_PATH: join(c.DATA_DIR, "apm.sqlite"),
    };
}

/** Config fields safe to log or expose. URL settings keep only scheme://host: keys hide in userinfo, path and query. */
/** Describes a malformed hex secret without echoing it. */
function hexProblem(v: string): string {
    if (/[<>]/.test(v)) return "it looks like a placeholder, not a key";
    if (/^[0-9a-fA-F]+$/.test(v)) return /[A-F]/.test(v) ? "it has uppercase letters" : `it has ${v.length} characters`;
    return `it has ${v.length} characters, some not hex (quotes or spaces?)`;
}

export function redacted(c: Config): Record<string, unknown> {
    const { OPERATOR_MNEMONIC, LP_MNEMONIC, DEV_ORACLE_SECRET, ORACLE_SECRET_KEY, ...rest } = c;
    const origin = (u: string) => (URL.canParse(u) ? `${new URL(u).protocol}//${new URL(u).host}` : "[invalid url]");
    const urls = Object.entries(rest)
        .filter(([k, v]) => /_URLS?$/.test(k) && v !== undefined)
        .map(([k, v]) => [k, Array.isArray(v) ? v.map(String).map(origin) : origin(String(v))]);
    return { ...rest, ...Object.fromEntries(urls), OPERATOR_MNEMONIC: !!OPERATOR_MNEMONIC, LP_MNEMONIC: !!LP_MNEMONIC, DEV_ORACLE_SECRET: !!DEV_ORACLE_SECRET, ORACLE_SECRET_KEY: !!ORACLE_SECRET_KEY };
}
