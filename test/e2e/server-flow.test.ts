import { afterAll, describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { hex } from "@scure/base";
import { issueMarketAssets, mintSets, openVault, postOffer, redeemAll, takeOffers, walletParty, type Ctx, type Party } from "../../src/core/actions.js";
import { attestationMessage, evidenceDigest, signAttestation } from "../../src/core/attestation.js";
import { bindingOf, type MarketDefinition } from "../../src/core/definition.js";
import type { VaultTerms } from "../../src/core/market.js";
import { BINARY_VECTORS } from "../../src/core/payout.js";
import {
    coinFromJson, offerTermsFromJson, offerTermsToJson, termsToJson,
    type CertificateJson, type CreateMarketRequest, type MarketJson, type OfferJson, type TradeJson,
} from "../../src/shared/api.js";
import { connectArkade, faucet, indexerProvider, newWallet, waitFor } from "./env.js";
import { network } from "./market.js";
import { startServer, type TestServer } from "./server.js";

let server: TestServer | undefined;
let second: TestServer | undefined;
afterAll(async () => {
    await second?.stop();
    await server?.stop();
});

describe("server API end to end", () => {
    it("registers a creator-funded market, lists orders, matches, resolves and redeems", { timeout: 900_000 }, async () => {
        server = await startServer({ port: 37401 });
        console.log(`server data dir ${server.dataDir}`);
        const { api } = server;
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };

        // Fund the operator (backs the dev faucet), then fund traders through the real faucet endpoint.
        const overview = await api<{ wallets: { operator: { address: string } } }>("/api/admin/overview", { admin: true });
        expect(overview.status).toBe(200);
        expect((await api("/api/admin/overview")).status).toBe(401);
        await faucet(overview.body.wallets.operator.address, 200_000);
        const parties: Record<string, Party> = {};
        const keys: Record<string, Awaited<ReturnType<typeof newWallet>>> = {};
        for (const n of ["alice", "bob", "carol"]) {
            const w = await newWallet();
            keys[n] = w;
            await waitFor(async () => {
                const r = await api<{ txid: string }>("/api/dev/faucet", { method: "POST", body: JSON.stringify({ address: await w.wallet.getAddress(), amountSats: 40_000 }) });
                return r.status === 200;
            }, { what: "faucet", timeoutMs: 60_000, intervalMs: 2000 });
            await waitFor(async () => (await w.wallet.getBalance()).available >= 40_000, { what: `${n} funded` });
            parties[n] = await walletParty(w.wallet, w.identity);
        }

        // Alice creates a custom market client-side; she holds the oracle key.
        const oracleSecret = randomBytes(32);
        const oracleKey = hex.encode(schnorr.getPublicKey(oracleSecret));
        const marketId = hex.encode(randomBytes(16));
        const closeAt = BigInt(Math.floor(Date.now() / 1000) + 90);
        const timeoutAt = closeAt + 86_400n;
        const definition: MarketDefinition = {
            question: "Will the regtest demo resolve YES?", rules: "Resolves YES if the e2e oracle says so.", outcomes: ["YES", "NO"],
            category: "test", closeAtUnix: String(closeAt), timeoutAtUnix: String(timeoutAt), source: null,
        };
        const { assets, genesisTxid } = await issueMarketAssets(ctx, parties.alice!, marketId, 1n);
        await waitFor(async () => (await parties.alice!.coins()).some((c) => c.assets?.some((a) => a.assetId === assets.ctrl)), { what: "genesis" });
        const terms: VaultTerms = {
            assets, unitSats: 1000n, capSats: 1000n + 100_000n, oracleKey: hex.decode(oracleKey),
            binding: bindingOf({ network: "regtest", arkSigner: ark.serverKey, emulatorSigner: ark.emulatorKey!, marketId, definition, unitSats: 1000n, assets, oracleKeys: [oracleKey], oracleEpoch: 1 }),
            closeAt, timeoutAt, exitDelaySeconds: 512n,
        };
        const { txid: vaultTxid } = await openVault(ctx, parties.alice!, terms, 1n, 1000n);
        const req: CreateMarketRequest = {
            question: definition.question, rules: definition.rules, outcomes: ["YES", "NO"], category: "test",
            closeAtUnix: String(closeAt), timeoutAtUnix: String(timeoutAt), oracle: { policy: "external-key", key: oracleKey },
            marketId, genesisTxid, vaultTxid, terms: termsToJson(terms),
        };
        const forged = await api("/api/markets", { method: "POST", body: JSON.stringify({ ...req, question: "Will it resolve NO?" }) });
        expect(forged.status).toBe(400);
        const wrongVault = await api("/api/markets", { method: "POST", body: JSON.stringify({ ...req, vaultTxid: genesisTxid }) });
        expect(wrongVault.status).toBe(400);
        const created = await api<MarketJson>("/api/markets", { method: "POST", body: JSON.stringify(req) });
        expect(created.status).toBe(201);
        expect(created.body.status).toBe("open");

        // Alice mints and posts an ask; the server only lists what it can find on the indexer.
        await mintSets(ctx, parties.alice!, terms, 10n);
        const askTerms = {
            side: "sell" as const, maker: await keys.alice!.identity.xOnlyPublicKey(), makerScript: parties.alice!.script,
            assetId: assets.yes, priceSats: 600n, minFill: 1n, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400), reserveSats: 330n, exitDelaySeconds: 512n,
        };
        await waitFor(async () => (await parties.alice!.coins()).some((c) => c.assets?.some((a) => a.assetId === assets.yes && a.amount >= 5n)), { what: "minted" });
        const posted = await postOffer(ctx, parties.alice!, askTerms, 5n);
        const ask = await waitFor(async () => {
            const r = await api<OfferJson>("/api/offers", { method: "POST", body: JSON.stringify({ marketId, terms: offerTermsToJson(askTerms), fundingTxid: posted.txid }) });
            return r.status === 201 && r.body;
        }, { what: "offer listed" });
        expect((await api("/api/offers", { method: "POST", body: JSON.stringify({ marketId, terms: offerTermsToJson(askTerms), fundingTxid: posted.txid }) })).status).toBe(409);

        // Bob takes 2 of 5 using only what the API returned.
        const book = await api<{ offers: OfferJson[] }>(`/api/markets/${marketId}/offers?status=open`);
        const listed = book.body.offers[0]!;
        await takeOffers(ctx, parties.bob!, [{ offer: { terms: offerTermsFromJson(listed.terms), coin: coinFromJson(listed.coin!) }, qty: 2n }], { maxSpendSats: 1200n });
        const refreshed = await waitFor(async () => {
            const r = await api<OfferJson>(`/api/offers/${encodeURIComponent(ask.id)}/refresh`, { method: "POST" });
            return r.body.remaining === "3" && r.body;
        }, { what: "fill observed" });
        expect(refreshed.status).toBe("open");

        // Crossing bids from Carol (YES 550) and Bob (NO 480): the server's keeper mints between them.
        const bid = (party: Party, maker: Uint8Array, assetId: string, priceSats: bigint) => ({
            side: "buy" as const, maker, makerScript: party.script, assetId, priceSats, minFill: 1n,
            expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400 + Math.floor(Math.random() * 1000)), reserveSats: 330n, exitDelaySeconds: 512n,
        });
        for (const [name, assetId, price] of [["carol", assets.yes, 550n], ["bob", assets.no, 480n]] as const) {
            const t = bid(parties[name]!, await keys[name]!.identity.xOnlyPublicKey(), assetId, price);
            const { txid } = await postOffer(ctx, parties[name]!, t, 3n);
            await waitFor(async () => (await api("/api/offers", { method: "POST", body: JSON.stringify({ marketId, terms: offerTermsToJson(t), fundingTxid: txid }) })).status === 201, { what: `${name} bid listed` });
        }
        const matched = await waitFor(async () => {
            const r = await api<{ trades: TradeJson[] }>(`/api/markets/${marketId}/trades`);
            return r.body.trades.filter((t) => t.kind === "mint-match").length >= 1 && r.body.trades;
        }, { what: "keeper mint-match", timeoutMs: 120_000, intervalMs: 2000 });
        expect(matched.some((t) => t.kind === "fill" && t.qty === "2")).toBe(true);

        // After close, Alice (oracle) certifies YES; a forged certificate is refused; the keeper resolves.
        await new Promise((r) => setTimeout(r, Math.max(0, Number(closeAt) * 1000 - Date.now() + 2000)));
        const evidence = evidenceDigest({ policy: "external-key", market: marketId, outcome: "YES" });
        const cert: CertificateJson = {
            outcome: "yes", numerators: ["1", "0"], denominator: "1", evidenceDigest: hex.encode(evidence),
            signature: hex.encode(signAttestation(oracleSecret, attestationMessage(terms.binding, evidence, BINARY_VECTORS.yes))),
            signer: oracleKey, sourceBlock: null, issuedAt: new Date().toISOString(),
        };
        expect((await api("/api/markets/" + marketId + "/certificates", { method: "POST", body: JSON.stringify({ ...cert, outcome: "no", numerators: ["0", "1"] }) })).status).toBe(400);
        expect((await api("/api/markets/" + marketId + "/certificates", { method: "POST", body: JSON.stringify(cert) })).status).toBe(200);
        const resolved = await waitFor(async () => {
            const r = await api<MarketJson>(`/api/markets/${marketId}`);
            return r.body.vault.phase === "resolved" && r.body;
        }, { what: "keeper resolution", timeoutMs: 120_000, intervalMs: 2000 });
        expect(resolved.vault.outcome).toBe("yes");

        // Winners redeem client-side.
        const bobPaid = await redeemAll(ctx, parties.bob!, terms, "yes");
        expect(bobPaid.yesBurn).toBe(2n);
        expect(bobPaid.payout).toBe(2000n);

        // A second instance on the same data directory must not become a writer.
        second = await startServer({ port: 37402, dataDir: server.dataDir, env: server.env });
        const health = await second.api<{ components: { writer: { ok: boolean } } }>("/api/health/ready");
        expect(health.body.components.writer.ok).toBe(false);
    });
});
