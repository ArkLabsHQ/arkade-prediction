// Live, read-only: the batched early-resolution screen flags a resolved Polymarket market and not an open one.
// Usage: node --import tsx scripts/live/early-resolution-check.ts [resolvedId] [openId]
import { createPolymarketProvider } from "../../src/server/sources/polymarket/index.js";

const [resolvedId = "2758339", openId = "593972"] = process.argv.slice(2);
const p = createPolymarketProvider({
    rpcUrls: ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"],
    resolverAllowlist: ["0x65070be91477460d8a7aeeb94ef92fe056c2f2a7", "0x157ce2d672854c848c9b79c49a8cc6cc89176a49"],
});
const resolved = await p.fetchMarketDefinition(resolvedId);
const open = await p.fetchMarketDefinition(openId);
const t0 = Date.now();
const hits = await p.screenResolved([resolved, open]);
console.log(JSON.stringify({ resolved: resolved.protocol.conditionId, open: open.protocol.conditionId, hits, ms: Date.now() - t0 }));
const ok = hits.includes(resolved.protocol.conditionId) && !hits.includes(open.protocol.conditionId);
console.log(ok ? "SCREEN OK" : "SCREEN UNEXPECTED");
process.exit(ok ? 0 : 1);
