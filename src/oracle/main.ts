import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { attestationMessage, evidenceDigest, outcomeOfVector, signAttestation } from "../core/attestation.js";
import { bindingOf, type MarketDefinition } from "../core/definition.js";
import type { MarketAssets } from "../core/market.js";
import type { CertificateJson } from "../shared/api.js";
import { PROFILE, createPolymarketProvider } from "../server/sources/polymarket/index.js";
import { sourceBinding } from "../server/sources/definition.js";

export interface AttestRequest {
    marketId: string;
    definition: MarketDefinition;
    assets: MarketAssets;
    unitSats: string;
    deployment: { network: string; arkSigner: string; emulatorSigner: string };
    epoch: number;
}

const env = process.env;
const fileOr = (name: string) => (env[`${name}_FILE`] ? readFileSync(env[`${name}_FILE`]!, "utf8").trim() : env[name]?.trim());
const secret = fileOr("ORACLE_SECRET_KEY");
if (!secret || !/^[0-9a-f]{64}$/.test(secret)) throw new Error("ORACLE_SECRET_KEY(_FILE) must be 32-byte hex");
const pins = { network: env.APM_NETWORK ?? "", arkSigner: env.ARK_SIGNER_XONLY ?? "", emulatorSigner: env.EMULATOR_PUBKEY ?? "" };
if (!pins.network || !/^[0-9a-f]{64}$/.test(pins.arkSigner) || !/^[0-9a-f]{66}$/.test(pins.emulatorSigner)) {
    throw new Error("APM_NETWORK, ARK_SIGNER_XONLY (32-byte) and EMULATOR_PUBKEY (33-byte) pins are required");
}
const epoch = Number(env.ORACLE_EPOCH ?? 1);
const pubkey = hex.encode(schnorr.getPublicKey(hex.decode(secret)));
const dataDir = env.ORACLE_DATA_DIR ?? "/data/oracle";
mkdirSync(dataDir, { recursive: true });
const rpcUrls = (env.POLYGON_RPC_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (rpcUrls.length < 2) throw new Error("POLYGON_RPC_URLS needs at least two providers");
const provider = createPolymarketProvider({
    gammaUrl: env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com",
    rpcUrls,
    resolverAllowlist: (env.POLYMARKET_RESOLVERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
});
const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), service: "attestor", msg, ...extra }));

const app = new Hono();
app.get("/info", (c) => c.json({ pubkey, epoch, profile: PROFILE, deployment: pins }));
app.get("/health", (c) => c.json({ ok: true }));

/**
 * Signs only after independently re-reading the source: the backend's view is never trusted. The binding is
 * recomputed with this attestor's own key and epoch, so a certificate cannot be replayed to another market,
 * network, template or key set.
 */
app.post("/attest", async (c) => {
    const req = (await c.req.json()) as AttestRequest;
    if (req.deployment.network !== pins.network || req.deployment.arkSigner !== pins.arkSigner || req.deployment.emulatorSigner !== pins.emulatorSigner) {
        return c.json({ error: "deployment does not match this attestor's pins", code: "deployment" }, 400);
    }
    if (req.epoch !== epoch) return c.json({ error: `epoch ${req.epoch} is not served (current ${epoch})`, code: "epoch" }, 400);
    const bound = req.definition.source as { provider?: string; profile?: string; sourceId?: string } | null | undefined;
    if (!bound || bound.provider !== "polymarket" || bound.profile !== PROFILE || !bound.sourceId) {
        return c.json({ error: "unsupported source profile", code: "profile" }, 400);
    }
    const live = await provider.fetchMarketDefinition(bound.sourceId);
    const identity = sourceBinding(live, PROFILE);
    for (const k of ["sourceId", "chainId", "protocolVersion", "settlementContract", "resolver", "conditionId", "questionId"] as const) {
        if (JSON.stringify(identity[k]) !== JSON.stringify((bound as Record<string, unknown>)[k])) {
            log("source identity mismatch", { market: req.marketId, field: k });
            return c.json({ error: `source ${k} changed since the market was funded; quarantined`, code: "identity" }, 409);
        }
    }
    if (JSON.stringify(identity.outcomes) !== JSON.stringify((bound as Record<string, unknown>).outcomes)) {
        return c.json({ error: "outcome order changed since the market was funded; quarantined", code: "identity" }, 409);
    }
    const evidence = await provider.fetchResolutionEvidence(live);
    if (evidence.status !== "final") return c.json({ status: evidence.status, detail: evidence.detail }, 409);
    const verified = provider.verifyFinalResolution(live, evidence, PROFILE);
    if (!verified.ok) return c.json({ error: verified.reason, code: "verification" }, 409);
    const vector = { numerators: evidence.vector!.numerators, denominator: evidence.vector!.denominator };
    const outcome = outcomeOfVector(vector);
    const binding = bindingOf({
        network: pins.network, arkSigner: hex.decode(pins.arkSigner), emulatorSigner: hex.decode(pins.emulatorSigner),
        marketId: req.marketId, definition: req.definition, unitSats: BigInt(req.unitSats), assets: req.assets,
        oracleKeys: [pubkey], oracleEpoch: epoch,
    });
    const evidenceDoc = { sourceId: live.sourceId, conditionId: live.protocol.conditionId, chain: evidence.chain, vector, reads: evidence.reads };
    const digest = evidenceDigest(evidenceDoc);
    const signature = signAttestation(hex.decode(secret), attestationMessage(binding, digest, vector));
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
serve({ fetch: app.fetch, hostname: env.ORACLE_HOST ?? "0.0.0.0", port }, () => log("listening", { port, pubkey, epoch }));
