import { schnorr } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { hex } from "@scure/base";
import { issueMarketAssets, openVault, postOffer, walletParty, type Ctx, type Party } from "../../src/core/actions.js";
import { bindingOf, type MarketDefinition } from "../../src/core/definition.js";
import { oracleSlots, type VaultTerms } from "../../src/core/market.js";
import type { OfferTerms } from "../../src/core/offers.js";
import { offerTermsToJson, termsToJson, type CreateMarketRequest } from "../../src/shared/api.js";
import { newWallet, waitFor } from "./env.js";
import type { TestServer } from "./server.js";

export interface Trader {
    party: Party;
    key: Uint8Array;
}

export async function faucetTrader(server: TestServer, sats: number): Promise<Trader> {
    const w = await newWallet();
    await waitFor(async () => {
        const r = await server.api("/api/dev/faucet", { method: "POST", body: JSON.stringify({ address: await w.wallet.getAddress(), amountSats: sats }) });
        return r.status === 200;
    }, { what: "faucet", timeoutMs: 60_000, intervalMs: 2000 });
    await waitFor(async () => (await w.wallet.getBalance()).available >= sats, { what: "trader funded" });
    return { party: await walletParty(w.wallet, w.identity), key: await w.identity.xOnlyPublicKey() };
}

/** Creator-funded custom market registered through the API; the creator holds the attestor keys. */
export async function registeredMarket(server: TestServer, ctx: Ctx, creator: Trader, closeInSeconds: number, oracle = { attestors: 1, threshold: 1 }) {
    const oracleSecrets = Array.from({ length: oracle.attestors }, () => randomBytes(32));
    const oracleSecret = oracleSecrets[0]!;
    const keys = oracleSecrets.map((secret) => hex.encode(schnorr.getPublicKey(secret)));
    const oracleKey = keys[0]!;
    const slots = oracleSlots(keys.map((k) => hex.decode(k)), oracle.threshold);
    const marketId = hex.encode(randomBytes(16));
    const closeAt = BigInt(Math.floor(Date.now() / 1000) + closeInSeconds);
    const timeoutAt = closeAt + 86_400n;
    const definition: MarketDefinition = {
        question: `Fault drill ${marketId.slice(0, 6)}?`, rules: "Resolves by the creator's oracle key.", outcomes: ["YES", "NO"],
        category: "test", closeAtUnix: String(closeAt), timeoutAtUnix: String(timeoutAt), source: null,
    };
    const { assets, genesisTxid } = await issueMarketAssets(ctx, creator.party, marketId, 1n);
    await waitFor(async () => (await creator.party.coins()).some((c) => c.assets?.some((a) => a.assetId === assets.ctrl)), { what: "genesis" });
    const terms: VaultTerms = {
        assets, unitSats: 1000n, capSats: 1000n + 100_000n, oracleKeys: slots, oracleThreshold: oracle.threshold,
        binding: bindingOf({ network: "regtest", arkSigner: ctx.ark.serverKey, emulatorSigner: ctx.ark.emulatorKey!, marketId, definition, unitSats: 1000n, assets, oracleKeys: slots.map((k) => hex.encode(k)), oracleThreshold: oracle.threshold, oracleEpoch: 1 }),
        closeAt, timeoutAt, exitDelaySeconds: 512n,
    };
    const { txid: vaultTxid } = await openVault(ctx, creator.party, terms, 1n, 1000n);
    const req: CreateMarketRequest = {
        question: definition.question, rules: definition.rules, outcomes: ["YES", "NO"], category: "test",
        closeAtUnix: String(closeAt), timeoutAtUnix: String(timeoutAt), oracle: { policy: "external-key", keys, threshold: oracle.threshold },
        marketId, genesisTxid, vaultTxid, terms: termsToJson(terms),
    };
    const r = await server.api("/api/markets", { method: "POST", body: JSON.stringify(req) });
    if (r.status !== 201) throw new Error(`market registration failed: ${JSON.stringify(r.body)}`);
    return { marketId, terms, oracleSecret, oracleKey, oracleSecrets };
}

export async function postBid(server: TestServer, ctx: Ctx, marketId: string, t: Trader, assetId: string, priceSats: bigint, qty: bigint) {
    const terms: OfferTerms = {
        side: "buy", maker: t.key, makerScript: t.party.script, assetId, priceSats, minFill: 1n,
        expiresAt: BigInt(Math.floor(Date.now() / 1000) + 86_400 + Math.floor(Math.random() * 1000)), reserveSats: 330n, exitDelaySeconds: 512n,
    };
    const { txid } = await postOffer(ctx, t.party, terms, qty);
    await waitFor(async () => (await server.api("/api/offers", { method: "POST", body: JSON.stringify({ marketId, terms: offerTermsToJson(terms), fundingTxid: txid }) })).status === 201, { what: "bid listed" });
    return terms;
}
