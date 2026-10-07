/**
 * HTTP API contract shared by server, browser and CLI. Amounts are decimal strings, bytes are lowercase hex,
 * times are ISO-8601 strings unless named `*Unix`.
 */
import { hex } from "@scure/base";
import type { VaultTerms } from "../core/market.js";
import type { OfferTerms, Side } from "../core/offers.js";

export type Outcome = "yes" | "no";
export type MarketKind = "polymarket" | "custom";
export type MarketStatus = "activating" | "open" | "closed" | "resolving" | "resolved" | "failed" | "hidden";
export type OraclePolicy = "platform-attestor" | "external-key" | "dev-oracle";

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
}

export interface MarketTermsJson {
    assets: { ctrl: string; yes: string; no: string };
    unitSats: string;
    capSats: string;
    oracleKey: string;
    binding: string;
    closeAtUnix: string;
    timeoutAtUnix: string;
    exitDelaySeconds: string;
}

export interface SourceJson {
    provider: "polymarket";
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
    clarifications: { observedAt: string; note: string }[];
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
    closeAt: string;
    createdAt: string;
    source: SourceJson | null;
    oracle: { policy: OraclePolicy; keys: string[]; threshold: number; epoch: number; label: string };
    terms: MarketTermsJson | null;
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

export interface MarketEvent {
    id: number;
    type: "market" | "offer" | "trade" | "resolution" | "workflow" | "health";
    marketId: string | null;
    at: string;
    data: unknown;
}

export interface CreateMarketRequest {
    question: string;
    rules: string;
    outcomes: [string, string];
    category: string | null;
    closeAtUnix: string;
    timeoutAtUnix: string;
    oracle: { policy: "external-key" | "dev-oracle"; key: string };
    marketId: string;
    genesisTxid: string;
    vaultTxid: string;
    terms: MarketTermsJson;
}

export interface PostOfferRequest {
    marketId: string;
    terms: OfferTermsJson;
    fundingTxid: string;
}

export const big = (s: string) => BigInt(s);

export function termsFromJson(t: MarketTermsJson): VaultTerms {
    return {
        assets: t.assets,
        unitSats: big(t.unitSats),
        capSats: big(t.capSats),
        oracleKey: hex.decode(t.oracleKey),
        binding: hex.decode(t.binding),
        closeAt: big(t.closeAtUnix),
        timeoutAt: big(t.timeoutAtUnix),
        exitDelaySeconds: big(t.exitDelaySeconds),
    };
}

export function termsToJson(t: VaultTerms): MarketTermsJson {
    return {
        assets: t.assets,
        unitSats: t.unitSats.toString(),
        capSats: t.capSats.toString(),
        oracleKey: hex.encode(t.oracleKey),
        binding: hex.encode(t.binding),
        closeAtUnix: t.closeAt.toString(),
        timeoutAtUnix: t.timeoutAt.toString(),
        exitDelaySeconds: t.exitDelaySeconds.toString(),
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
    };
}

export function coinFromJson(c: CoinJson) {
    return { txid: c.txid, vout: c.vout, value: Number(c.valueSats), assets: c.assets.map((a) => ({ assetId: a.assetId, amount: big(a.amount) })) };
}
