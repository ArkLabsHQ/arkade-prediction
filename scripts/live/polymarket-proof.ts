import { writeFileSync } from "node:fs";
import { BINARY_VECTORS } from "../../src/core/payout.js";
import { PROFILE, createPolymarketProvider } from "../../src/server/sources/polymarket/index.js";

const RPC_URLS = ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"];
const RESOLVER_ALLOWLIST = ["0x65070be91477460d8a7aeeb94ef92fe056c2f2a7", "0x157ce2d672854c848c9b79c49a8cc6cc89176a49"];
const PROOFS = { "2758339": BINARY_VECTORS.no, "3409541": BINARY_VECTORS.yes, "4737427": BINARY_VECTORS.invalid };
const OUT_DIR = new URL("../../docs/research/evidence/polymarket/", import.meta.url);
const json = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x), 2);

const provider = createPolymarketProvider({ rpcUrls: RPC_URLS, resolverAllowlist: RESOLVER_ALLOWLIST });
const policy = { profiles: [PROFILE], tags: [], minHorizonSeconds: 3600, maxHorizonSeconds: 365 * 86400 };

const page = await provider.discoverMarkets(null, 100);
const counts: Record<string, number> = {};
const unknownResolvers = new Set<string>();
for (const m of page.markets) {
    const e = provider.evaluateEligibility(m, policy, new Date());
    const key = e.eligible ? "eligible" : e.code;
    counts[key] = (counts[key] ?? 0) + 1;
    if (key === "unknown-resolver") unknownResolvers.add(m.protocol.resolver ?? "null");
}
console.log(`discovery: ${page.markets.length} markets, next cursor ${page.next ? "present" : "absent"}`, counts);
if (unknownResolvers.size > 0) console.log("unknown resolvers:", [...unknownResolvers]);
const first = page.markets[0];
if (first) {
    const again = await provider.fetchMarketDefinition(first.sourceId);
    console.log(`discovery vs definition versionHash equal for ${first.sourceId}: ${again.versionHash === first.versionHash}`);
}

let failures = 0;
for (const [id, expected] of Object.entries(PROOFS)) {
    const market = await provider.fetchMarketDefinition(id);
    const evidence = await provider.fetchResolutionEvidence(market);
    const verification = provider.verifyFinalResolution(market, evidence, PROFILE);
    const v = evidence.vector;
    const matchesExpected = v?.denominator === expected.denominator && expected.numerators.every((n, i) => n === v.numerators[i]);
    if (!verification.ok || !matchesExpected) failures++;
    const record = { fetchedAt: new Date().toISOString(), profile: PROFILE, expectedVector: expected, matchesExpected, verification, market, evidence };
    writeFileSync(new URL(`live-verify-${id}.json`, OUT_DIR), `${json(record)}\n`);
    console.log(`${id}: ${evidence.status} | ${evidence.detail} | verify=${verification.ok ? "ok" : verification.reason} | expected=${matchesExpected}`);
}
process.exitCode = failures > 0 ? 1 : 0;
