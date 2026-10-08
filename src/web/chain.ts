import {
    EsploraProvider, IndexedDBContractRepository, IndexedDBWalletRepository, MnemonicIdentity, RestArkProvider,
    RestEmulatorProvider, RestIndexerProvider, Wallet, arkade, networks, type WalletBalance,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import {
    CARRIER_SATS, cancelOffer, execute, issueMarketAssets, openVault, postOffer, resolveMarket, spendableCoins, takeOffers,
    walletParty, type Ctx, type Party,
} from "../core/actions.js";
import type { Coin } from "../core/arkadeTx.js";
import { attestationMessage, evidenceDigest, signAttestation } from "../core/attestation.js";
import { claimBoxContract } from "../core/claimBox.js";
import { bindingOf, type MarketDefinition } from "../core/definition.js";
import { oracleSlots, slotSignatures, type ArkadeClient, type MarketAssets, type VaultTerms } from "../core/market.js";
import { offerContract, type OfferTerms, type Side } from "../core/offers.js";
import { BINARY_VECTORS, type BinaryOutcome } from "../core/payout.js";
import {
    coinFromJson, offerTermsFromJson, offerTermsToJson, termsToJson, type BoxJson, type CertificateJson, type CoinJson,
    type ConfigJson, type CreateMarketRequest, type MarketJson, type OfferJson, type Outcome, type PostOfferRequest, type RegisterBoxRequest,
} from "../shared/api.js";
import { api, enc } from "./api.js";
import { planFill, type Plan } from "./fills.js";
import { errMsg } from "./format.js";
import type { Keystore } from "./keystore.js";
import { addLog, readLog, updateLog, type LogEntry } from "./txlog.js";
import { checkLegs } from "./verify.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(probe: () => Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await probe())) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await sleep(1000);
    }
}

// --- Arkade connection ------------------------------------------------------------------------

export interface Chain {
    ark: ArkadeClient;
    ctx: Ctx;
    arkProvider: RestArkProvider;
    indexer: RestIndexerProvider;
    emulatorWarning: string | null;
}

export async function connectChain(config: ConfigJson): Promise<Chain> {
    const network = networks[config.network as keyof typeof networks];
    if (!network) throw new Error(`Unsupported network "${config.network}"`);
    const arkProvider = new RestArkProvider(config.arkServerUrl);
    const emulator = new RestEmulatorProvider(config.emulatorUrl);
    const indexer = new RestIndexerProvider(config.arkServerUrl);
    const ark = await arkade.Arkade.connect({ arkade: arkProvider, emulator, indexer, network, emulatorPubkey: config.emulatorPubkey });
    let emulatorWarning: string | null = null;
    try {
        const { signerPubkey } = await emulator.getInfo();
        // Compare x-only parts: either side may be served in 33-byte compressed form.
        if (signerPubkey.toLowerCase().slice(-64) !== config.emulatorPubkey.toLowerCase().slice(-64)) {
            emulatorWarning = `The emulator at ${config.emulatorUrl} reports signer ${signerPubkey}, but this deployment pins ${config.emulatorPubkey}. Covenant trades will be refused or co-signed by an unexpected party.`;
        }
    } catch (e) {
        emulatorWarning = `Could not read the emulator's signer key (${errMsg(e)}). Covenant trades may fail.`;
    }
    return { ark, arkProvider, indexer, emulatorWarning, ctx: { ark, net: { ark: arkProvider, emulator, indexer, checkpoint: ark.checkpoint }, indexer } };
}

// --- wallet session ---------------------------------------------------------------------------

export interface Session {
    wallet: Wallet;
    identity: MnemonicIdentity;
    party: Party;
    keystore: Keystore;
    address: string;
    script: string;
    pubkey: string;
}

export async function openSession(chain: Chain, config: ConfigJson, keystore: Keystore): Promise<Session> {
    const identity = MnemonicIdentity.fromMnemonic(keystore.secrets.mnemonic, { isMainnet: config.network === "bitcoin" });
    const wallet = await Wallet.create({
        identity,
        arkProvider: chain.arkProvider,
        indexerProvider: chain.indexer,
        onchainProvider: new EsploraProvider(config.esploraUrl),
        storage: {
            walletRepository: new IndexedDBWalletRepository(keystore.meta.db),
            contractRepository: new IndexedDBContractRepository(keystore.meta.db),
        },
        settlementConfig: false,
        // Offers name identity.xOnlyPublicKey() as maker and party.script as payee: both must stay on one key.
        walletMode: "static",
    });
    const party = await walletParty(wallet, identity);
    return {
        wallet, identity, party, keystore,
        address: await wallet.getAddress(),
        script: hex.encode(party.script),
        pubkey: hex.encode(await identity.xOnlyPublicKey()),
    };
}

export interface Holdings {
    balance: WalletBalance;
    /** Sats actions can spend: every coin's value, less one carrier that keeps leftover claims in change. */
    plainSats: bigint;
    assets: Map<string, bigint>;
}

export async function readHoldings(s: Session): Promise<Holdings> {
    const [balance, coins] = await Promise.all([s.wallet.getBalance(), s.party.coins()]);
    const assets = new Map<string, bigint>();
    let total = 0n;
    for (const c of coins) {
        total += BigInt(c.value);
        for (const a of c.assets ?? []) assets.set(a.assetId, (assets.get(a.assetId) ?? 0n) + a.amount);
    }
    const plainSats = assets.size > 0 ? (total > CARRIER_SATS ? total - CARRIER_SATS : 0n) : total;
    return { balance, plainSats, assets };
}

// --- logged actions ---------------------------------------------------------------------------

/** Runs one money-moving action with a write-ahead entry in the local tx log. */
export async function logged<T extends { txid: string }>(
    chain: Chain,
    s: Session,
    entry: Omit<LogEntry, "id" | "at" | "status">,
    run: (ctx: Ctx) => Promise<T>,
    record?: (r: T) => Partial<LogEntry>,
): Promise<T & { logId: string }> {
    const logId = addLog(s.script, { ...entry, status: "signing" });
    const ctx: Ctx = { ...chain.ctx, beforeSubmit: ({ txid }) => updateLog(s.script, logId, { txid, status: "submitting" }) };
    try {
        const r = await run(ctx);
        updateLog(s.script, logId, { txid: r.txid, status: "accepted", error: undefined, ...record?.(r) });
        return { ...r, logId };
    } catch (e) {
        const submitted = readLog(s.script).find((x) => x.id === logId)?.txid;
        updateLog(s.script, logId, { status: submitted ? "uncertain" : "failed", error: errMsg(e) });
        throw e;
    }
}

async function landed(ctx: Ctx, txid: string): Promise<boolean> {
    try {
        return (await ctx.indexer.getVirtualTxs([txid])).txs.length > 0;
    } catch {
        return false;
    }
}

/** Moves accepted/uncertain entries to confirmed once the indexer serves their tx. */
export async function confirmPending(chain: Chain, script: string): Promise<void> {
    for (const e of readLog(script)) {
        if (!e.txid || !["submitting", "accepted", "uncertain"].includes(e.status)) continue;
        if (await landed(chain.ctx, e.txid)) updateLog(script, e.id, { status: "confirmed" });
    }
}

// --- offers -----------------------------------------------------------------------------------

const offerCoins = (ctx: Ctx, o: OfferJson) => spendableCoins(ctx, offerContract(ctx.ark, offerTermsFromJson(o.terms)).pkScript);
const sameCoin = (c: Coin, o: OfferJson) => !!o.coin && c.txid === o.coin.txid && c.vout === o.coin.vout;
const pickCoin = (coins: Coin[], o: OfferJson) => coins.find((c) => sameCoin(c, o)) ?? coins[0];

function withCoin(o: OfferJson, c: Coin | undefined): OfferJson {
    if (!c) return { ...o, coin: null, remaining: "0" };
    const t = o.terms;
    const held = (c.assets ?? []).filter((a) => a.assetId === t.assetId).reduce((s, a) => s + a.amount, 0n);
    const budget = (BigInt(c.value) - BigInt(t.reserveSats)) / BigInt(t.priceSats);
    return {
        ...o,
        coin: { txid: c.txid, vout: c.vout, valueSats: String(c.value), assets: (c.assets ?? []).map((a) => ({ assetId: a.assetId, amount: a.amount.toString() })) },
        remaining: String(t.side === "sell" ? held : budget > 0n ? budget : 0n),
    };
}

export interface FillRequest {
    side: Side;
    qty: bigint;
    /** Buy: max sats spent. Sell: min sats received. */
    bound: bigint;
    takerScript: string;
    /** Buy only: deliver the shares to this script (the taker's claim box) instead of the wallet. */
    receiveScript?: Uint8Array;
    /** The audited claim of the chosen outcome; every leg must trade exactly this asset. */
    assetId: string;
}

export function mustPlan(book: OfferJson[], req: FillRequest): Plan {
    const plan = planFill(book, req.side, req.qty, Math.floor(Date.now() / 1000), req.takerScript);
    if (plan.legs.length === 0) throw new Error("No liquidity");
    if (plan.qty < req.qty) throw new Error(`Only ${plan.qty} of ${req.qty} can be filled from the current book at legal fill sizes`);
    return plan;
}

/** Takes the book for `req`; if an offer coin was spent under us, re-reads the touched offers and retries once. */
export async function fillWithRetry(ctx: Ctx, party: Party, book: OfferJson[], req: FillRequest) {
    const sent: { txid?: string } = {};
    const tracked: Ctx = {
        ...ctx,
        beforeSubmit: async (p) => {
            sent.txid = p.txid;
            await ctx.beforeSubmit?.(p);
        },
    };
    const take = async (plan: Plan) => {
        checkLegs(ctx.ark, plan.legs.map((l) => l.offer), req.side, req.assetId);
        const legs = plan.legs.map((l) => ({ offer: { terms: offerTermsFromJson(l.offer.terms), coin: coinFromJson(l.offer.coin!) }, qty: l.qty }));
        const limits = req.side === "buy" ? { maxSpendSats: req.bound, receiveScript: req.receiveScript } : { minReceiveSats: req.bound };
        const r = await takeOffers(tracked, party, legs, limits);
        return { txid: r.txid, qty: r.qty, notional: r.notional, touched: plan.legs.map((l) => l.offer.id), retried: false };
    };
    const plan = mustPlan(book, req);
    try {
        return await take(plan);
    } catch (err) {
        const ours = sent.txid;
        if (!ours) throw err;
        await sleep(1000);
        const fresh = await Promise.all(plan.legs.map((l) => offerCoins(ctx, l.offer)));
        // An error after submission does not prove rejection: never buy twice.
        if (fresh.some((cs) => cs.some((c) => c.txid === ours)) || (await landed(ctx, ours))) {
            return { txid: ours, qty: plan.qty, notional: plan.notional, touched: plan.legs.map((l) => l.offer.id), retried: false };
        }
        const spent = plan.legs.filter((l, i) => !fresh[i]!.some((c) => sameCoin(c, l.offer)));
        if (spent.length === 0) throw err;
        const refreshed = book.map((o) => {
            const i = plan.legs.findIndex((l) => l.offer.id === o.id);
            return i < 0 ? o : withCoin(o, pickCoin(fresh[i]!, o));
        });
        const r = await take(mustPlan(refreshed, req));
        return { ...r, touched: [...r.touched, ...spent.map((l) => l.offer.id)], retried: true };
    }
}

// --- auto-claim boxes -------------------------------------------------------------------------

const boxOf = (ark: ArkadeClient, s: Session, terms: VaultTerms) =>
    claimBoxContract(ark, terms, { owner: hex.decode(s.pubkey), ownerScript: s.party.script });

/** Registers the box (idempotent) and refuses to proceed unless the server watches exactly the script we pay into. */
export async function ensureBox(chain: Chain, s: Session, m: MarketJson, terms: VaultTerms): Promise<Uint8Array> {
    const box = boxOf(chain.ark, s, terms);
    const req: RegisterBoxRequest = { marketId: m.id, owner: s.pubkey, ownerScript: s.script };
    const registered = await api<BoxJson>("/api/boxes", { body: req });
    if (registered.script !== hex.encode(box.pkScript)) throw new Error("The server derived a different claim box script; refusing to buy into it");
    return box.pkScript;
}

/** Owner + operator leaf: moves one box coin, shares and carrier, back into the wallet. */
export function withdrawBox(ctx: Ctx, s: Session, terms: VaultTerms, coin: CoinJson) {
    const c = coinFromJson(coin);
    return execute(ctx, [{ kind: "tapscript", coin: c, contract: boxOf(ctx.ark, s, terms), fn: "withdraw" }],
        [{ script: s.party.script, amount: BigInt(c.value), assets: c.assets }], s.party);
}

export async function cancelFresh(ctx: Ctx, party: Party, o: OfferJson) {
    const coin = pickCoin(await offerCoins(ctx, o), o);
    if (!coin) throw new Error("This order is no longer live: it was filled, cancelled or settled");
    return cancelOffer(ctx, party, { terms: offerTermsFromJson(o.terms), coin });
}

/** The server finds the funding coin on the indexer, which can lag the submission by a moment. */
export async function registerOffer(req: PostOfferRequest): Promise<OfferJson> {
    let last: unknown;
    for (let i = 0; i < 4; i++) {
        try {
            return await api<OfferJson>("/api/offers", { body: req });
        } catch (e) {
            last = e;
            await sleep(1500);
        }
    }
    throw last;
}

export interface OrderInput {
    side: Side;
    outcome: Outcome;
    price: bigint;
    size: bigint;
    minFill: bigint;
    expiresAt: bigint;
}

export async function postOrder(chain: Chain, s: Session, config: ConfigJson, m: MarketJson, t: VaultTerms, o: OrderInput) {
    const terms: OfferTerms = {
        side: o.side, maker: await s.identity.xOnlyPublicKey(), makerScript: s.party.script,
        assetId: o.outcome === "yes" ? t.assets.yes : t.assets.no, priceSats: o.price, minFill: o.minFill,
        expiresAt: o.expiresAt, reserveSats: CARRIER_SATS, exitDelaySeconds: BigInt(config.exitDelaySeconds),
    };
    const label = `${o.side === "buy" ? "Bid" : "Ask"} ${o.size} ${m.outcomes[o.outcome === "yes" ? 0 : 1]} @ ${o.price}`;
    const r = await logged(chain, s, {
        kind: "post", label, marketId: m.id, outcome: o.outcome, qty: String(o.size), sats: o.side === "buy" ? String(o.size * o.price) : undefined,
    }, (ctx) => postOffer(ctx, s.party, terms, o.size));
    const req: PostOfferRequest = { marketId: m.id, terms: offerTermsToJson(terms), fundingTxid: r.txid };
    try {
        return { txid: r.txid, offer: await registerOffer(req) };
    } catch (e) {
        updateLog(s.script, r.logId, { status: "unregistered", post: req, error: errMsg(e) });
        return { txid: r.txid, registerError: errMsg(e) };
    }
}

// --- market creation --------------------------------------------------------------------------

export const VAULT_BASE_SATS = 1000n;
export const MAX_SETS = 1000n;

/** Everything needed to resume a half-finished creation after a reload or failure. */
export interface CreateDraft {
    marketId: string;
    network: string;
    definition: Omit<MarketDefinition, "outcomes" | "source"> & { outcomes: [string, string] };
    oracleKey: string;
    unitSats: string;
    exitDelaySeconds: string;
    genesisTxid?: string;
    assets?: MarketAssets;
    vaultTxid?: string;
}

const draftKey = (script: string) => `apm.createDraft.${script}`;
export const loadDraft = (script: string): CreateDraft | null => JSON.parse(localStorage.getItem(draftKey(script)) ?? "null") as CreateDraft | null;
export const saveDraft = (script: string, d: CreateDraft) => localStorage.setItem(draftKey(script), JSON.stringify(d));
export const clearDraft = (script: string) => localStorage.removeItem(draftKey(script));

export function draftTerms(chain: Chain, d: CreateDraft, assets: MarketAssets): VaultTerms {
    if (!chain.ark.emulatorKey) throw new Error("The Arkade client has no emulator key");
    const unitSats = BigInt(d.unitSats);
    const oracleKeys = oracleSlots([hex.decode(d.oracleKey)], 1);
    const binding = bindingOf({
        network: d.network, arkSigner: chain.ark.serverKey, emulatorSigner: chain.ark.emulatorKey, marketId: d.marketId,
        definition: { ...d.definition, source: null }, unitSats, assets, oracleKeys: oracleKeys.map((k) => hex.encode(k)), oracleThreshold: 1, oracleEpoch: 1,
    });
    return {
        assets, unitSats, capSats: VAULT_BASE_SATS + MAX_SETS * unitSats, oracleKeys, oracleThreshold: 1, binding,
        closeAt: BigInt(d.definition.closeAtUnix), timeoutAt: BigInt(d.definition.timeoutAtUnix), exitDelaySeconds: BigInt(d.exitDelaySeconds),
    };
}

export async function runCreate(chain: Chain, s: Session, draft: CreateDraft, step: (msg: string) => void): Promise<MarketJson> {
    let d = draft;
    const name = d.definition.question.slice(0, 60);
    if (!d.genesisTxid || !d.assets) {
        step("Issuing market assets: CTRL plus 1 YES and 1 NO");
        const g = await logged(chain, s, { kind: "genesis", label: `Issue assets: ${name}`, marketId: d.marketId },
            (ctx) => issueMarketAssets(ctx, s.party, d.marketId, 1n).then((r) => ({ ...r, txid: r.genesisTxid })));
        d = { ...d, genesisTxid: g.genesisTxid, assets: g.assets };
        saveDraft(s.script, d);
    }
    const assets = d.assets!;
    const terms = draftTerms(chain, d, assets);
    if (!d.vaultTxid && terms.timeoutAt === 0n) {
        throw new Error("This unfinished market has no timeout, which listing now requires. Discard it and create it again; its vault was not funded.");
    }
    if (!d.vaultTxid) {
        step("Waiting for the wallet to see the control asset");
        await waitFor(async () => (await s.party.coins()).some((c) => c.assets?.some((a) => a.assetId === assets.ctrl)), 90_000, "the control asset");
        step("Funding the market vault");
        const v = await logged(chain, s, { kind: "vault", label: `Open vault: ${name}`, marketId: d.marketId, sats: String(VAULT_BASE_SATS + terms.unitSats) },
            (ctx) => openVault(ctx, s.party, terms, 1n, VAULT_BASE_SATS));
        d = { ...d, vaultTxid: v.txid };
        saveDraft(s.script, d);
    }
    step("Registering the market with the server");
    const req: CreateMarketRequest = {
        ...d.definition, oracle: { policy: "external-key", keys: [d.oracleKey], threshold: 1 }, marketId: d.marketId,
        genesisTxid: d.genesisTxid!, vaultTxid: d.vaultTxid!, terms: termsToJson(terms),
    };
    const market = await api<MarketJson>("/api/markets", { body: req });
    clearDraft(s.script);
    return market;
}

// --- resolution -------------------------------------------------------------------------------

/** The attestor key of this market this wallet holds: its own key, or one generated by an earlier version. */
export function oracleKeyFor(s: Session | null, m: MarketJson): { key: string; sign(message: Uint8Array): Promise<Uint8Array> } | undefined {
    if (!s) return undefined;
    if (m.terms?.oracleKeys.includes(s.pubkey)) return { key: s.pubkey, sign: (msg) => s.identity.signMessage(msg, "schnorr") };
    const key = m.terms?.oracleKeys.find((k) => s.keystore.secrets.oracleKeys[k]);
    return key ? { key, sign: async (msg) => signAttestation(hex.decode(s.keystore.secrets.oracleKeys[key]!), msg) } : undefined;
}

/**
 * Signs the attestation and hands the certificate to the server. When this one signature meets the quorum the
 * resolve tx is submitted directly; otherwise the keeper submits it once enough attestors have signed.
 */
export async function resolveAsOracle(chain: Chain, s: Session, m: MarketJson, terms: VaultTerms, outcome: BinaryOutcome, note: string) {
    const held = oracleKeyFor(s, m);
    if (!held) throw new Error("This wallet does not hold an oracle key of this market");
    const issuedAt = new Date().toISOString();
    const evidence = evidenceDigest({ market: m.id, outcome, note, at: issuedAt });
    const vector = BINARY_VECTORS[outcome];
    const signature = await held.sign(attestationMessage(terms.binding, evidence, vector));
    const certificate: CertificateJson = {
        outcome, numerators: vector.numerators.map(String), denominator: String(vector.denominator),
        evidenceDigest: hex.encode(evidence), signature: hex.encode(signature), signer: held.key, sourceBlock: null, issuedAt,
    };
    let txid: string | undefined;
    let resolveError: string | undefined;
    if (terms.oracleThreshold === 1) {
        try {
            txid = (await logged(chain, s, { kind: "resolve", label: `Resolve ${outcome.toUpperCase()}: ${m.question.slice(0, 60)}`, marketId: m.id, outcome },
                (ctx) => resolveMarket(ctx, terms, outcome, evidence, slotSignatures(terms, [{ signer: held.key, signature }])))).txid;
        } catch (e) {
            resolveError = errMsg(e);
        }
    }
    return { txid, resolveError, certificate, ...(await sendCertificate(m.id, certificate)) };
}

export async function sendCertificate(marketId: string, certificate: CertificateJson): Promise<{ postError?: string }> {
    try {
        await api(`/api/markets/${enc(marketId)}/certificates`, { body: certificate });
        return {};
    } catch (e) {
        return { postError: errMsg(e) };
    }
}
