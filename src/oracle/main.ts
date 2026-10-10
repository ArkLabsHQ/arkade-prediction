import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { hex } from "@scure/base";
import { RestArkProvider, networks, resolveEmulatorPubkey } from "@arkade-os/sdk";
import { defaultEndpoints } from "../core/endpoints.js";
import { attestationMessage, attestorPublicKey, evidenceDigest, outcomeOfVector, signAttestation, type AttestorScheme } from "../core/attestation.js";
import { bindingOf, type MarketDefinition } from "../core/definition.js";
import type { MarketAssets } from "../core/market.js";
import { attestorSetProblem } from "./request.js";
import type { CertificateJson } from "../shared/api.js";
import { DEFAULT_CREATORS, DEFAULT_NEG_RISK_ORACLES, createPolymarketProvider } from "../server/sources/polymarket/index.js";
import { createKalshiProvider } from "../server/sources/kalshi/index.js";
import { createManifoldProvider } from "../server/sources/manifold/index.js";
import { DEFAULT_RESOLVERS as LIMITLESS_RESOLVERS, createLimitlessProvider } from "../server/sources/limitless/index.js";
import { DEFAULT_ORACLES as OPINION_ORACLES, createOpinionProvider } from "../server/sources/opinion/index.js";
// Same defaults as the server config (src/server/config.ts).
const BASE_RPCS = ["https://base.gateway.tenderly.co", "https://base-mainnet.public.blastapi.io", "https://mainnet.base.org"];
const BNB_RPCS = ["https://bsc-rpc.publicnode.com", "https://bsc.blockrazor.xyz"];
import type { MarketSourceProvider } from "../server/sources/types.js";
import { definitionMismatch } from "../server/sources/definition.js";

export interface AttestRequest {
    marketId: string;
    definition: MarketDefinition;
    assets: MarketAssets;
    unitSats: string;
    deployment: { network: string; arkSigner: string; emulatorSigner: string };
    epoch: number;
    /** The market's attestor slots and quorum; this attestor's key must be one of them. */
    oracle: { keys: string[]; threshold: number };
    /** Finalized Polygon block the resolver read; every attestor reads the same one so their evidence matches. */
    atBlock?: string;
}

const env = process.env;
const fileOr = (name: string) => (env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`]!, "utf8").trim() : env[name]?.trim());
const secret = fileOr("ORACLE_SECRET_KEY");
if (!secret || !/^[0-9a-f]{64}$/.test(secret)) throw new Error("ORACLE_SECRET_KEY(_FILE) must be 32-byte hex");
const network = env.APM_NETWORK ?? "";
if (!(network in networks)) throw new Error("APM_NETWORK must name an Arkade network");
// Pins are optional: the operator key is read from the Ark server, the emulator key is the SDK's network pin.
const arkServer = env.ARK_SERVER_URL || defaultEndpoints(network).arkServer;
const liveSigner = arkServer ? (await new RestArkProvider(arkServer).getInfo()).signerPubkey.slice(-64) : undefined;
if (env.ARK_SIGNER_XONLY && liveSigner && env.ARK_SIGNER_XONLY !== liveSigner) {
    throw new Error(`Ark server reports signer ${liveSigner}, pinned ${env.ARK_SIGNER_XONLY}`);
}
const pins = {
    network,
    arkSigner: env.ARK_SIGNER_XONLY || liveSigner || "",
    emulatorSigner: resolveEmulatorPubkey(networks[network as keyof typeof networks], env.EMULATOR_PUBKEY || undefined),
};
if (!/^[0-9a-f]{64}$/.test(pins.arkSigner)) throw new Error("set ARK_SERVER_URL (or ARK_SIGNER_XONLY) so the attestor knows the operator key");
const epoch = Number(env.ORACLE_EPOCH ?? 1);
const scheme = (env.ORACLE_KEY_SCHEME || "schnorr") as AttestorScheme;
if (!["schnorr", "ecdsa-secp256k1", "ecdsa-p256"].includes(scheme)) throw new Error("ORACLE_KEY_SCHEME must be schnorr, ecdsa-secp256k1 or ecdsa-p256");
const pubkey = hex.encode(attestorPublicKey(scheme, hex.decode(secret)));
const dataDir = env.ORACLE_DATA_DIR ?? "/data/oracle";
mkdirSync(dataDir, { recursive: true });
// URLs keep their case: RPC API keys in paths are case-sensitive.
const urls = (name: string, fallback: readonly string[]) => {
    const set = (env[name] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    return set.length > 0 ? set : [...fallback];
};
const csv = (name: string, fallback: readonly string[] = []) => {
    const set = (env[name] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
    return set.length > 0 ? set : [...fallback];
};
// Same truthy values as the server's config (true / 1), so both sides agree on which sources are on.
const on = (v: string | undefined) => v === "true" || v === "1";
const rpcUrls = (env.POLYGON_RPC_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (rpcUrls.length === 1) throw new Error("POLYGON_RPC_URLS needs at least two providers");
const providers: MarketSourceProvider[] = [
    ...(rpcUrls.length >= 2
        ? [createPolymarketProvider({
              gammaUrl: env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com",
              rpcUrls,
              resolverAllowlist: csv("POLYMARKET_RESOLVERS"),
              creatorAllowlist: csv("POLYMARKET_CREATORS", DEFAULT_CREATORS),
              negRiskOracleAllowlist: csv("POLYMARKET_NEGRISK_ORACLES", DEFAULT_NEG_RISK_ORACLES),
          })]
        : []),
    ...(on(env.KALSHI_ENABLED) ? [createKalshiProvider({ apiUrl: env.KALSHI_API_URL || undefined })] : []),
    ...(on(env.MANIFOLD_ENABLED) ? [createManifoldProvider({ apiUrl: env.MANIFOLD_API_URL || undefined })] : []),
    ...(on(env.LIMITLESS_ENABLED) ? [createLimitlessProvider({ apiUrl: env.LIMITLESS_API_URL || undefined, rpcUrls: urls("BASE_RPC_URLS", BASE_RPCS), resolverAllowlist: csv("LIMITLESS_RESOLVERS", LIMITLESS_RESOLVERS) })] : []),
    ...(on(env.OPINION_ENABLED) ? [createOpinionProvider({ apiUrl: env.OPINION_API_URL || undefined, rpcUrls: urls("BNB_RPC_URLS", BNB_RPCS), resolverAllowlist: csv("OPINION_ORACLES", OPINION_ORACLES) })] : []),
];
if (providers.length === 0) throw new Error("no source enabled: set POLYGON_RPC_URLS, KALSHI_ENABLED, MANIFOLD_ENABLED, LIMITLESS_ENABLED or OPINION_ENABLED");
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), service: "attestor", msg, ...extra }));

const app = new Hono();
app.get("/info", (c) => c.json({ pubkey, epoch, profiles: providers.map((p) => p.profile), deployment: pins }));
app.get("/health", (c) => c.json({ ok: true }));

/**
 * Signs only after independently re-reading the source: the backend's view is never trusted. The binding is
 * recomputed over the market's attestor set (which must contain this key) and this attestor's epoch, so a
 * certificate cannot be replayed to another market, network, template or attestor set.
 */
app.post("/attest", async (c) => {
    const req = (await c.req.json()) as AttestRequest;
    if (req.deployment.network !== pins.network || req.deployment.arkSigner !== pins.arkSigner || req.deployment.emulatorSigner !== pins.emulatorSigner) {
        return c.json({ error: "deployment does not match this attestor's pins", code: "deployment" }, 400);
    }
    if (req.epoch !== epoch) return c.json({ error: `epoch ${req.epoch} is not served (current ${epoch})`, code: "epoch" }, 400);
    const refused = attestorSetProblem(req, pubkey);
    if (refused) return c.json(refused, 400);
    const keys = req.oracle.keys;
    const bound = req.definition.source as { provider?: string; profile?: string; sourceId?: string } | null | undefined;
    const provider = providers.find((p) => p.name === bound?.provider);
    if (!bound || !provider || bound.profile !== provider.profile || !bound.sourceId) {
        return c.json({ error: "unsupported source profile", code: "profile" }, 400);
    }
    const live = await provider.fetchMarketDefinition(bound.sourceId);
    const mismatch = definitionMismatch(req.definition, live, provider.profile);
    if (mismatch) {
        log("source identity mismatch", { market: req.marketId, reason: mismatch });
        return c.json({ error: `${mismatch}; quarantined`, code: "identity" }, 409);
    }
    // The source API says which contract will report the result; only the chain says who may make it report.
    const vetted = await provider.vetSource?.(live);
    if (vetted && !vetted.ok) {
        log("source not vetted", { market: req.marketId, reason: vetted.reason });
        return c.json({ error: `${vetted.reason}; quarantined`, code: "unvetted-source" }, 409);
    }
    const evidence = await provider.fetchResolutionEvidence(live, { atBlock: req.atBlock === undefined ? undefined : BigInt(req.atBlock) });
    if (evidence.status !== "final") return c.json({ status: evidence.status, detail: evidence.detail }, 409);
    const verified = provider.verifyFinalResolution(live, evidence, provider.profile);
    if (!verified.ok) return c.json({ error: verified.reason, code: "verification" }, 409);
    const vector = { numerators: evidence.vector!.numerators, denominator: evidence.vector!.denominator };
    const outcome = outcomeOfVector(vector);
    const binding = bindingOf({
        network: pins.network, arkSigner: hex.decode(pins.arkSigner), emulatorSigner: hex.decode(pins.emulatorSigner),
        marketId: req.marketId, definition: req.definition, unitSats: BigInt(req.unitSats), assets: req.assets,
        oracleKeys: keys, oracleThreshold: req.oracle.threshold, oracleEpoch: epoch,
    });
    const evidenceDoc = provider.evidenceRecord(live, evidence);
    const digest = evidenceDigest(evidenceDoc);
    const signature = signAttestation(hex.decode(secret), attestationMessage(binding, digest, vector), scheme);
    const cert: CertificateJson = {
        outcome, numerators: vector.numerators.map(String), denominator: vector.denominator.toString(), evidenceDigest: hex.encode(digest),
        signature: hex.encode(signature), signer: pubkey,
        sourceBlock: evidence.chain ? { number: evidence.chain.blockNumber, hash: evidence.chain.blockHash } : null,
        issuedAt: new Date().toISOString(),
    };
    const record = JSON.stringify({ marketId: req.marketId, binding: hex.encode(binding), cert, evidence: evidenceDoc }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    appendFileSync(join(dataDir, "attestations.jsonl"), record + "\n");
    log("attested", { market: req.marketId, outcome, block: cert.sourceBlock });
    return c.json({ certificate: cert, evidence: JSON.parse(record).evidence });
});

const port = Number(env.ORACLE_PORT ?? 37410);
serve({ fetch: app.fetch, hostname: env.ORACLE_HOST ?? "0.0.0.0", port }, () => log("listening", { port, pubkey, epoch, deployment: pins }));
