// Trade, resolve and redeem on Mutinynet against a running app (test funds only).
import "../src/node/eventsource.js";
import { schnorr } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { hex } from "@scure/base";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { issueMarketAssets, mintSets, openVault, redeemAll, takeOffers } from "../src/core/actions.js";
import { attestationMessage, evidenceDigest, signAttestation } from "../src/core/attestation.js";
import { bindingOf, type MarketDefinition } from "../src/core/definition.js";
import { oracleSlots, type VaultTerms } from "../src/core/market.js";
import { BINARY_VECTORS } from "../src/core/payout.js";
import { loadConfig } from "../src/server/config.js";
import { connectNetwork, partyFromMnemonic } from "../src/server/network.js";
import { coinFromJson, offerTermsFromJson, termsToJson, type CertificateJson, type MarketJson, type OfferJson, type TradeJson } from "../src/shared/api.js";

const base = process.env.APM_URL ?? "http://127.0.0.1:37500";
const api = async <T = any>(path: string, init: RequestInit = {}) => {
    const r = await fetch(base + path, { ...init, headers: init.body ? { "content-type": "application/json" } : {} });
    const text = await r.text();
    return { status: r.status, body: (text ? JSON.parse(text) : undefined) as T };
};
const waitFor = async <T>(probe: () => Promise<T | false | undefined>, what: string, timeoutMs = 300_000): Promise<T> => {
    const end = Date.now() + timeoutMs;
    for (;;) {
        const v = await probe().catch(() => undefined);
        if (v) return v;
        if (Date.now() > end) throw new Error(`timed out: ${what}`);
        await new Promise((r) => setTimeout(r, 3000));
    }
};
const step = (m: string) => console.log(`${new Date().toISOString()} - ${m}`);

const cfg = loadConfig();
const net = await connectNetwork(cfg);
const ctx = net.ctx;
const operator = await partyFromMnemonic(cfg, cfg.OPERATOR_MNEMONIC!);
const trader = await partyFromMnemonic(cfg, generateMnemonic(wordlist));

await operator.wallet.send({ address: await trader.wallet.getAddress(), amount: 15_000 });
await waitFor(async () => (await trader.wallet.getBalance()).available >= 15_000, "trader funded");
step("trader funded 15000 sats from the operator wallet");

// 1. Trade: take 1 YES from an LP ask on an imported market.
const markets = (await api<{ markets: MarketJson[] }>("/api/markets")).body.markets.filter((m) => m.status === "open" && m.kind === "polymarket");
const imported = markets[0]!;
const asks = (await api<{ offers: OfferJson[] }>(`/api/markets/${imported.id}/offers?status=open`)).body.offers;
const ask = asks.find((o) => o.terms.side === "sell" && o.outcome === "yes")!;
await takeOffers(ctx, trader.party, [{ offer: { terms: offerTermsFromJson(ask.terms), coin: coinFromJson(ask.coin!) }, qty: 1n }], { maxSpendSats: 700n });
const yesId = ask.terms.assetId;
await waitFor(async () => (await trader.party.coins()).some((c) => c.assets?.some((a) => a.assetId === yesId && a.amount >= 1n)), "YES in trader wallet");
step(`took 1 YES @${ask.terms.priceSats} on imported market ${imported.id}`);
const fill = await waitFor(async () => {
    await api(`/api/offers/${encodeURIComponent(ask.id)}/refresh`, { method: "POST" });
    const t = (await api<{ trades: TradeJson[] }>(`/api/markets/${imported.id}/trades`)).body.trades;
    return t.find((x) => x.kind === "fill");
}, "server records the fill");
step(`server recorded fill qty=${fill.qty}`);

// 2. Custom market: create, mint, certify YES after close, keeper resolves, trader redeems.
const oracleSecret = randomBytes(32);
const oracleKey = hex.encode(schnorr.getPublicKey(oracleSecret));
const slots = oracleSlots([hex.decode(oracleKey)], 1);
const marketId = hex.encode(randomBytes(16));
const closeAt = BigInt(Math.floor(Date.now() / 1000) + 240);
const timeoutAt = closeAt + 86_400n;
const definition: MarketDefinition = {
    question: `Mutinynet drill ${marketId.slice(0, 6)}?`, rules: "Resolves by the creator's oracle key.", outcomes: ["YES", "NO"],
    category: "test", closeAtUnix: String(closeAt), timeoutAtUnix: String(timeoutAt), source: null,
};
const { assets, genesisTxid } = await issueMarketAssets(ctx, trader.party, marketId, 1n);
await waitFor(async () => (await trader.party.coins()).some((c) => c.assets?.some((a) => a.assetId === assets.ctrl)), "genesis");
const terms: VaultTerms = {
    assets, unitSats: 1000n, capSats: 1000n + 100_000n, oracleKeys: slots, oracleThreshold: 1,
    binding: bindingOf({ network: "mutinynet", arkSigner: ctx.ark.serverKey, emulatorSigner: ctx.ark.emulatorKey!, marketId, definition, unitSats: 1000n, assets, oracleKeys: slots.map((k) => hex.encode(k)), oracleThreshold: 1, oracleEpoch: 1 }),
    closeAt, timeoutAt, exitDelaySeconds: net.exitDelaySeconds,
};
const { txid: vaultTxid } = await openVault(ctx, trader.party, terms, 1n, 1000n);
const reg = await api<MarketJson>("/api/markets", { method: "POST", body: JSON.stringify({
    question: definition.question, rules: definition.rules, outcomes: ["YES", "NO"], category: "test",
    closeAtUnix: String(closeAt), timeoutAtUnix: String(timeoutAt), oracle: { policy: "external-key", keys: [oracleKey], threshold: 1 },
    marketId, genesisTxid, vaultTxid, terms: termsToJson(terms),
}) });
if (reg.status !== 201) throw new Error(`registration ${reg.status}: ${JSON.stringify(reg.body)}`);
step(`custom market ${marketId} registered (closes in 240 s)`);
await mintSets(ctx, trader.party, terms, 2n);
await waitFor(async () => (await trader.party.coins()).some((c) => c.assets?.some((a) => a.assetId === assets.yes && a.amount >= 2n)), "minted");
step("minted 2 sets");

await new Promise((r) => setTimeout(r, Math.max(0, Number(closeAt) * 1000 - Date.now() + 5000)));
const evidence = evidenceDigest({ policy: "external-key", market: marketId, outcome: "YES" });
const cert: CertificateJson = {
    outcome: "yes", numerators: ["1", "0"], denominator: "1", evidenceDigest: hex.encode(evidence),
    signature: hex.encode(signAttestation(oracleSecret, attestationMessage(terms.binding, evidence, BINARY_VECTORS.yes))),
    signer: oracleKey, sourceBlock: null, issuedAt: new Date().toISOString(),
};
const posted = await api(`/api/markets/${marketId}/certificates`, { method: "POST", body: JSON.stringify(cert) });
if (posted.status !== 200) throw new Error(`certificate ${posted.status}: ${JSON.stringify(posted.body)}`);
step("certificate YES accepted");
await waitFor(async () => (await api<MarketJson>(`/api/markets/${marketId}`)).body.vault.phase === "resolved", "keeper resolution", 900_000);
step("keeper resolved the vault on-chain");
const paid = await redeemAll(ctx, trader.party, terms, "yes");
step(`redeemed: yesBurn=${paid.yesBurn} payout=${paid.payout}`);
console.log("MUTINYNET FLOW OK");
process.exit(0);
