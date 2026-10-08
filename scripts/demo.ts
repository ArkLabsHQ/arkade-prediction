// Deterministic end-to-end demo against a running app (default http://127.0.0.1:37400) and the regtest stack.
// Every step is a real Arkade transaction; results are re-read from the API/indexer, never assumed.
import "../src/node/eventsource.js";
import { readFileSync } from "node:fs";
import { hex } from "@scure/base";
import { contractCoin, redeemAll, takeOffers, type Ctx } from "../src/core/actions.js";
import { attestationMessage, evidenceDigest, signAttestation } from "../src/core/attestation.js";
import { claimBoxContract } from "../src/core/claimBox.js";
import { marketContracts } from "../src/core/market.js";
import { BINARY_VECTORS } from "../src/core/payout.js";
import { coinFromJson, offerTermsFromJson, type CertificateJson, type MarketJson, type OfferJson, type TradeJson } from "../src/shared/api.js";
import { connectArkade, faucet, indexerProvider, waitFor } from "../test/e2e/env.js";
import { faucetTrader, postBid, registeredMarket } from "../test/e2e/flows.js";
import { network } from "../test/e2e/market.js";
import type { TestServer } from "../test/e2e/server.js";

const base = process.env.APM_URL ?? "http://127.0.0.1:37400";
const envFile = process.env.APM_ENV_FILE ?? ".env.regtest";
const adminBase = process.env.APM_ADMIN_URL ?? "http://127.0.0.1:37499";
const api: TestServer["api"] = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("content-type", "application/json");
    const r = await fetch(`${init.admin ? adminBase : base}${path}`, { ...init, headers });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
};
const server = { api } as TestServer;
const log: string[] = [];
const step = (msg: string) => {
    log.push(msg);
    console.log(`- ${msg}`);
};

async function main() {
    const ark = await connectArkade();
    const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
    const ov = await api<{ wallets: { operator: { address: string }; lp: { address: string } } }>("/api/admin/overview", { admin: true });
    if (ov.status !== 200) throw new Error(`admin overview failed (${ov.status}); is ${envFile} the app's env?`);
    await faucet(ov.body.wallets.operator.address, 300_000);
    await faucet(ov.body.wallets.lp.address, 300_000);
    step("funded operator (faucet) and LP wallets from the regtest node");

    const [alice, bob, carol, dana] = [await faucetTrader(server, 60_000), await faucetTrader(server, 30_000), await faucetTrader(server, 30_000), await faucetTrader(server, 30_000)];
    step("4 traders funded through POST /api/dev/faucet");

    const m = await registeredMarket(server, ctx, alice, 120);
    step(`alice created custom market ${m.marketId} (creator-held oracle key, closes in 120 s)`);

    const lp = await api(`/api/admin/markets/${m.marketId}/liquidity`, { method: "POST", admin: true, body: JSON.stringify({ sets: "10", yesAsk: "620", noAsk: "420" }) });
    if (lp.status !== 200) throw new Error(`liquidity request failed: ${JSON.stringify(lp.body)}`);
    const asks = await waitFor(async () => {
        const r = await api<{ offers: OfferJson[] }>(`/api/markets/${m.marketId}/offers?status=open`);
        return r.body.offers.filter((o) => o.terms.side === "sell").length === 2 && r.body.offers;
    }, { what: "LP asks", timeoutMs: 120_000, intervalMs: 2000 });
    step("LP keeper workflow minted 10 sets and posted asks YES@620 / NO@420; LP is now offline");

    const yesAsk = asks.find((o) => o.outcome === "yes" && o.terms.side === "sell")!;
    const owner = { owner: dana.key, ownerScript: dana.party.script };
    const box = claimBoxContract(ark, m.terms, owner);
    await api("/api/boxes", { method: "POST", body: JSON.stringify({ marketId: m.marketId, owner: hex.encode(dana.key), ownerScript: hex.encode(dana.party.script) }) });
    const bought = await takeOffers(ctx, dana.party, [{ offer: { terms: offerTermsFromJson(yesAsk.terms), coin: coinFromJson(yesAsk.coin!) }, qty: 3n }], { maxSpendSats: 1860n, receiveScript: box.pkScript });
    await api(`/api/offers/${encodeURIComponent(yesAsk.id)}/refresh`, { method: "POST" });
    step(`dana bought 3 YES for 1,860 sats into her auto-claim box (${bought.txid.slice(0, 16)}) and went offline`);

    await postBid(server, ctx, m.marketId, carol, m.terms.assets.yes, 560n, 4n);
    await postBid(server, ctx, m.marketId, bob, m.terms.assets.no, 470n, 4n);
    await waitFor(async () => (await api<{ trades: TradeJson[] }>(`/api/markets/${m.marketId}/trades`)).body.trades.some((t) => t.kind === "mint-match"), { what: "keeper mint-match", timeoutMs: 120_000, intervalMs: 2000 });
    step("carol bid YES@560, bob bid NO@470 (both offline); keeper minted 4 sets between them");

    await new Promise((r) => setTimeout(r, Math.max(0, Number(m.terms.closeAt) * 1000 - Date.now() + 2000)));
    const evidence = evidenceDigest({ demo: "regtest", outcome: "YES", at: new Date().toISOString() });
    const cert: CertificateJson = {
        outcome: "yes", numerators: ["1", "0"], denominator: "1", evidenceDigest: hex.encode(evidence),
        signature: hex.encode(signAttestation(m.oracleSecret, attestationMessage(m.terms.binding, evidence, BINARY_VECTORS.yes))),
        signer: m.oracleKey, sourceBlock: null, issuedAt: new Date().toISOString(),
    };
    await api(`/api/markets/${m.marketId}/certificates`, { method: "POST", body: JSON.stringify(cert) });
    const resolved = await waitFor(async () => {
        const r = await api<MarketJson>(`/api/markets/${m.marketId}`);
        return r.body.vault.phase === "resolved" && r.body;
    }, { what: "resolution", timeoutMs: 120_000, intervalMs: 2000 });
    step(`after close alice's oracle key certified YES; keeper resolved the vault (collateral ${resolved.vault.valueSats} sats)`);

    const danaBox = await waitFor(async () => {
        const r = await api<{ boxes: { status: string }[] }>(`/api/boxes?ownerScript=${hex.encode(dana.party.script)}`);
        return r.body.boxes[0]?.status === "claimed" && r.body.boxes[0];
    }, { what: "auto-claim", timeoutMs: 120_000, intervalMs: 2000 });
    step(`keeper auto-claimed dana's box while she was offline (status ${danaBox.status}): 3 YES -> 3,000 sats`);

    const carolPaid = await redeemAll(ctx, carol.party, m.terms, "yes");
    step(`carol redeemed ${carolPaid.yesBurn} YES for ${carolPaid.payout} sats`);
    const vaultLeft = (await contractCoin(ctx, marketContracts(ark, m.terms).resolved.yes))?.value;
    step(`resolved vault now holds ${vaultLeft} sats for the remaining winning claims plus its base`);
    console.log("\nDEMO OK");
    // SDK wallets keep event streams and poll timers open.
    process.exit(0);
}

main().catch((err) => {
    console.error("DEMO FAILED:", err);
    process.exit(1);
});
