/**
 * HTTP API contract shared by server, browser and CLI. Amounts are decimal strings, bytes are lowercase hex,
 * times are ISO-8601 strings unless named `*Unix`.
 */
import { hex } from "@scure/base";
import type { PriceTerms, VaultTerms } from "../core/market.js";
import type { OfferTerms, Side } from "../core/offers.js";
import type { Section } from "./sections.js";

export type Outcome = "yes" | "no";
export type MarketKind = "polymarket" | "custom";
export type MarketStatus = "activating" | "open" | "halted" | "closed" | "resolving" | "resolved" | "failed" | "hidden";
export type OraclePolicy = "platform-attestor" | "external-key" | "dev-oracle" | "redstone";

export interface ConfigJson {
    network: string;
    deploymentId: string;
    arkServerUrl: string;
    emulatorUrl: string;
    esploraUrl: string;
    arkSignerPubkey: string;
    emulatorPubkey: string;
    explorerUrl: string | null;
    unitSats: string;
    exitDelaySeconds: string;
    devFaucet: boolean;
    testNetwork: boolean;
    /** Served by the admin listener (ADMIN_PORT). */
    admin: boolean;
    /** Latest close time the server admits for new markets, relative to now. */
    maxCloseHorizonSeconds: string;
}

export interface MarketTermsJson {
    assets: { ctrl: string; yes: string; no: string };
    unitSats: string;
    capSats: string;
    /** Vault attestor slots (x-only hex), repeated keys allowed; signatures needed: `oracleThreshold`. */
    oracleKeys: string[];
    oracleThreshold: number;
    binding: string;
    closeAtUnix: string;
    timeoutAtUnix: string;
    exitDelaySeconds: string;
    /** Price markets settled by RedStone's signed rounds; attestor fields are then unused. */
    price?: PriceTermsJson;
}

export type PriceTermsJson = { feedId: string; signers: string[]; quorum: number } & (
    | { kind: "threshold"; strike: string; settleAtMs: string }
    | { kind: "updown"; startAtMs: string; endAtMs: string }
);

export interface SourceJson {
    provider: "polymarket" | "kalshi" | "manifold";
    sourceId: string;
    url: string;
    slug: string;
    protocol: string;
    conditionId: string;
    questionId: string;
    resolver: string | null;
    resolutionSource: string;
    referencePrices: { outcome: string; price: string; asOf: string }[] | null;
    sourceStatus: string | null;
    image: string | null;
    event: { title: string; slug: string } | null;
    /** When the underlying event starts (sports kickoff, Up/Down window), if the source lists it. */
    startsAt: string | null;
    clarifications: { observedAt: string; note: string }[];
    /** Source identity exactly as committed in the market binding. */
    binding: Record<string, unknown> | null;
}

export interface CertificateJson {
    outcome: "yes" | "no" | "invalid";
    numerators: string[];
    denominator: string;
    evidenceDigest: string;
    signature: string;
    signer: string;
    sourceBlock: { number: string; hash: string } | null;
    issuedAt: string;
}

export interface MarketJson {
    id: string;
    kind: MarketKind;
    status: MarketStatus;
    question: string;
    rules: string;
    outcomes: [string, string];
    category: string | null;
    /** Browse section derived from the source tags or the category (see shared/sections.ts). */
    section: Section;
    closeAt: string;
    createdAt: string;
    source: SourceJson | null;
    oracle: { policy: OraclePolicy; keys: string[]; threshold: number; epoch: number; label: string };
    terms: MarketTermsJson | null;
    genesisTxid: string | null;
    vaultTxid: string | null;
    vault: { phase: "open" | "resolved"; outcome: "yes" | "no" | "invalid" | null; valueSats: string | null; outpoint: string | null; expiresAt: string | null };
    resolution: { status: string; detail: string; certificate: CertificateJson | null };
    book: { yes: { bid: string | null; ask: string | null }; no: { bid: string | null; ask: string | null } };
    stats: { openInterestSets: string; collateralSats: string; volumeSats: string; trades: number };
}

export interface OfferTermsJson {
    side: Side;
    maker: string;
    makerScript: string;
    assetId: string;
    priceSats: string;
    minFill: string;
    expiresAtUnix: string;
    reserveSats: string;
    exitDelaySeconds: string;
    /** Funded under the pre-330-sat offer contracts (see OfferTerms.legacy). */
    legacy?: boolean;
}

export interface CoinJson {
    txid: string;
    vout: number;
    valueSats: string;
    assets: { assetId: string; amount: string }[];
    /** Batch expiry of this VTXO (renewal deadline). */
    expiresAt?: string | null;
}

export type OfferStatus = "open" | "filled" | "expired" | "cancelled" | "settled" | "gone";

export interface OfferJson {
    id: string;
    marketId: string;
    outcome: Outcome;
    terms: OfferTermsJson;
    script: string;
    coin: CoinJson | null;
    /** Sell: units left. Buy: whole units the remaining budget can still buy. */
    remaining: string;
    status: OfferStatus;
    createdAt: string;
    updatedAt: string;
}

export interface TradeJson {
    txid: string;
    marketId: string;
    offerId: string | null;
    outcome: Outcome;
    kind: "fill" | "mint-match";
    /** Side of the resting offer. */
    makerSide: Side;
    qty: string;
    priceSats: string;
    at: string;
}

export type ProofStage = "waiting-source" | "waiting-checkpoint" | "waiting-l1-finality" | "witness-ready" | "proving" | "verified" | "failed";

/** Progress towards a trustless proof of a Polymarket mirror's result. Observation only: settlement is unchanged. */
export interface ProofJobJson {
    marketId: string;
    question: string;
    stage: ProofStage;
    detail: string;
    /** Polygon block and transaction holding the CTF ConditionResolution log. */
    polygonBlock: number | null;
    txHash: string | null;
    logIndex: number | null;
    /** RootChain header block (checkpoint) id covering `polygonBlock`, its root, and the Ethereum block that posted it. */
    headerBlockId: number | null;
    checkpointRoot: string | null;
    checkpointL1Block: number | null;
    attempts: number;
    startedAt: string;
    updatedAt: string;
}

export interface MarketEvent {
    id: number;
    type: "market" | "offer" | "trade" | "resolution" | "workflow" | "health" | "proof";
    marketId: string | null;
    at: string;
    data: unknown;
}

export const MAX_TIMEOUT_AFTER_CLOSE_SECONDS = 365 * 86_400;

export interface CreateMarketRequest {
    question: string;
    rules: string;
    outcomes: [string, string];
    category: string | null;
    closeAtUnix: string;
    timeoutAtUnix: string;
    oracle: { policy: "external-key" | "dev-oracle"; keys: string[]; threshold: number };
    marketId: string;
    genesisTxid: string;
    vaultTxid: string;
    terms: MarketTermsJson;
}

export interface RegisterBoxRequest {
    marketId: string;
    owner: string;
    ownerScript: string;
}

export interface BoxJson {
    script: string;
    marketId: string;
    owner: string;
    ownerScript: string;
    status: "watching" | "claimed";
    coins: CoinJson[];
}

export interface PostOfferRequest {
    marketId: string;
    terms: OfferTermsJson;
    fundingTxid: string;
}

export const big = (s: string) => BigInt(s);

export function termsFromJson(t: MarketTermsJson): VaultTerms {
    if (!Array.isArray(t.oracleKeys)) throw new Error("market terms use the retired single-attestor vault template");
    return {
        assets: t.assets,
        unitSats: big(t.unitSats),
        capSats: big(t.capSats),
        oracleKeys: t.oracleKeys.map((k) => hex.decode(k)),
        oracleThreshold: t.oracleThreshold,
        binding: hex.decode(t.binding),
        closeAt: big(t.closeAtUnix),
        timeoutAt: big(t.timeoutAtUnix),
        exitDelaySeconds: big(t.exitDelaySeconds),
        ...(t.price ? { price: priceFromJson(t.price) } : {}),
    };
}

function priceFromJson(p: PriceTermsJson): PriceTerms {
    const base = { feedId: hex.decode(p.feedId), signers: p.signers.map((k) => hex.decode(k)), quorum: p.quorum };
    return p.kind === "threshold"
        ? { ...base, kind: "threshold", strike: big(p.strike), settleAtMs: big(p.settleAtMs) }
        : { ...base, kind: "updown", startAtMs: big(p.startAtMs), endAtMs: big(p.endAtMs) };
}

function priceToJson(p: PriceTerms): PriceTermsJson {
    const base = { feedId: hex.encode(p.feedId), signers: p.signers.map((k) => hex.encode(k)), quorum: p.quorum };
    return p.kind === "threshold"
        ? { ...base, kind: "threshold", strike: p.strike.toString(), settleAtMs: p.settleAtMs.toString() }
        : { ...base, kind: "updown", startAtMs: p.startAtMs.toString(), endAtMs: p.endAtMs.toString() };
}

export function termsToJson(t: VaultTerms): MarketTermsJson {
    return {
        assets: t.assets,
        unitSats: t.unitSats.toString(),
        capSats: t.capSats.toString(),
        oracleKeys: t.oracleKeys.map((k) => hex.encode(k)),
        oracleThreshold: t.oracleThreshold,
        binding: hex.encode(t.binding),
        closeAtUnix: t.closeAt.toString(),
        timeoutAtUnix: t.timeoutAt.toString(),
        exitDelaySeconds: t.exitDelaySeconds.toString(),
        ...(t.price ? { price: priceToJson(t.price) } : {}),
    };
}

export function offerTermsFromJson(t: OfferTermsJson): OfferTerms {
    return {
        side: t.side,
        maker: hex.decode(t.maker),
        makerScript: hex.decode(t.makerScript),
        assetId: t.assetId,
        priceSats: big(t.priceSats),
        minFill: big(t.minFill),
        expiresAt: big(t.expiresAtUnix),
        reserveSats: big(t.reserveSats),
        exitDelaySeconds: big(t.exitDelaySeconds),
        ...(t.legacy ? { legacy: true } : {}),
    };
}

export function offerTermsToJson(t: OfferTerms): OfferTermsJson {
    return {
        side: t.side,
        maker: hex.encode(t.maker),
        makerScript: hex.encode(t.makerScript),
        assetId: t.assetId,
        priceSats: t.priceSats.toString(),
        minFill: t.minFill.toString(),
        expiresAtUnix: t.expiresAt.toString(),
        reserveSats: t.reserveSats.toString(),
        exitDelaySeconds: t.exitDelaySeconds.toString(),
        ...(t.legacy ? { legacy: true } : {}),
    };
}

export function coinFromJson(c: CoinJson) {
    return { txid: c.txid, vout: c.vout, value: Number(c.valueSats), assets: c.assets.map((a) => ({ assetId: a.assetId, amount: big(a.amount) })) };
}
