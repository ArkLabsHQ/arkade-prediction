import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

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
    APM_DEPLOYMENT_ID: z.string().min(1).max(64),
    PUBLIC_BASE_URL: z.url(),
    HOST: z.string().default("0.0.0.0"),
    PORT: int(37400),
    ARK_SERVER_URL: z.url(),
    EMULATOR_URL: z.url(),
    ESPLORA_URL: z.url(),
    EXPLORER_URL: z.url().optional(),
    PUBLIC_ARK_SERVER_URL: z.url().optional(),
    PUBLIC_EMULATOR_URL: z.url().optional(),
    PUBLIC_ESPLORA_URL: z.url().optional(),
    ARK_SIGNER_PUBKEY: hexKey(33).optional(),
    EMULATOR_PUBKEY: hexKey(33).optional(),
    DATA_DIR: z.string().default("/data"),
    ORACLE_URL: noCredentials.optional(),
    ORACLE_PUBKEYS: csv,
    ORACLE_EPOCH: int(1),
    POLYMARKET_ENABLED: bool,
    POLYMARKET_GAMMA_URL: z.url().default("https://gamma-api.polymarket.com"),
    POLYGON_RPC_URLS: csv,
    POLYMARKET_RESOLVERS: csv,
    IMPORT_TAGS: csv,
    IMPORT_MAX_ACTIVE: int(5),
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

export type Config = z.infer<typeof schema> & {
    OPERATOR_MNEMONIC: string | undefined;
    LP_MNEMONIC: string | undefined;
    ADMIN_TOKEN: string | undefined;
    DEV_ORACLE_SECRET: string | undefined;
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
        if (!c.ARK_SIGNER_PUBKEY || !c.EMULATOR_PUBKEY) throw new Error("ARK_SIGNER_PUBKEY and EMULATOR_PUBKEY pins are required outside regtest");
    }
    if (c.POLYMARKET_ENABLED && c.POLYGON_RPC_URLS.length < 2) throw new Error("POLYGON_RPC_URLS needs at least two providers");
    if (c.MARKET_UNIT_SATS % 2 !== 0) throw new Error("MARKET_UNIT_SATS must be even");
    const adminToken = secret(env, "ADMIN_TOKEN");
    if (adminToken !== undefined && adminToken.length < 24) throw new Error("ADMIN_TOKEN must be at least 24 characters");
    return {
        ...c,
        OPERATOR_MNEMONIC: secret(env, "OPERATOR_MNEMONIC"),
        LP_MNEMONIC: secret(env, "LP_MNEMONIC"),
        ADMIN_TOKEN: adminToken,
        DEV_ORACLE_SECRET: c.APM_NETWORK === "regtest" ? secret(env, "DEV_ORACLE_SECRET") : undefined,
        DB_PATH: join(c.DATA_DIR, "apm.sqlite"),
    };
}

/** Config fields safe to log or expose. URL settings keep only scheme://host: keys hide in userinfo, path and query. */
export function redacted(c: Config): Record<string, unknown> {
    const { OPERATOR_MNEMONIC, LP_MNEMONIC, ADMIN_TOKEN, DEV_ORACLE_SECRET, ...rest } = c;
    const origin = (u: string) => (URL.canParse(u) ? `${new URL(u).protocol}//${new URL(u).host}` : "[invalid url]");
    const urls = Object.entries(rest)
        .filter(([k, v]) => /_URLS?$/.test(k) && v !== undefined)
        .map(([k, v]) => [k, Array.isArray(v) ? v.map(String).map(origin) : origin(String(v))]);
    return { ...rest, ...Object.fromEntries(urls), OPERATOR_MNEMONIC: !!OPERATOR_MNEMONIC, LP_MNEMONIC: !!LP_MNEMONIC, ADMIN_TOKEN: !!ADMIN_TOKEN, DEV_ORACLE_SECRET: !!DEV_ORACLE_SECRET };
}
