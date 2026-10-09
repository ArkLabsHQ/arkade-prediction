import sellOfferArtifact from "../../contracts/artifacts/sell_offer.json" with { type: "json" };
import buyOfferArtifact from "../../contracts/artifacts/buy_offer.json" with { type: "json" };
import sellOfferV1Artifact from "../../contracts/legacy/sell_offer.v1.json" with { type: "json" };
import buyOfferV1Artifact from "../../contracts/legacy/buy_offer.v1.json" with { type: "json" };
import { DUST_SATS } from "./arkadeTx.js";
import { assetScriptArgs } from "./assets.js";
import type { ArkadeClient, Contract } from "./market.js";
import { loadProgram, type ContractArtifact } from "./programs.js";

export const OFFER_PROGRAMS = {
    sell: loadProgram(sellOfferArtifact as ContractArtifact),
    buy: loadProgram(buyOfferArtifact as ContractArtifact),
};

/** Offers funded before the 330-sat fill rules: they can be cancelled, settled or repriced, never filled. */
const LEGACY_PROGRAMS = {
    sell: loadProgram(sellOfferV1Artifact as ContractArtifact),
    buy: loadProgram(buyOfferV1Artifact as ContractArtifact),
};

export const OFFER_TEMPLATE = { sell: sellOfferArtifact.fingerprint, buy: buyOfferArtifact.fingerprint };

export type Side = "sell" | "buy";

/** Everything a fill is checked against; also the order's authorization (signed by funding it). */
export interface OfferTerms {
    side: Side;
    maker: Uint8Array;
    /** P2TR pkScript (34 bytes) that receives proceeds/units on settle. */
    makerScript: Uint8Array;
    assetId: string;
    priceSats: bigint;
    minFill: bigint;
    /** Unix seconds on the emulator clock; 0 = no expiry. */
    expiresAt: bigint;
    /** Buy offers: sats that must remain as carrier. */
    reserveSats: bigint;
    exitDelaySeconds: bigint;
    legacy?: boolean;
}

export function offerContract(ark: ArkadeClient, t: OfferTerms): Contract {
    if (t.maker.length !== 32) throw new Error("maker key must be x-only");
    if (t.makerScript.length !== 34 || t.makerScript[0] !== 0x51 || t.makerScript[1] !== 0x20) throw new Error("maker script must be P2TR");
    if (t.priceSats <= 0n || t.minFill <= 0n) throw new Error("price and min fill must be positive");
    const a = assetScriptArgs(t.assetId);
    const common = {
        maker: t.maker,
        makerProgram: t.makerScript.slice(2),
        assetTxid: a.txid,
        assetGidx: a.gidx,
        price: t.priceSats,
        minFill: t.minFill,
        expiresAt: t.expiresAt,
        exit: t.exitDelaySeconds,
    };
    const programs = t.legacy ? LEGACY_PROGRAMS : OFFER_PROGRAMS;
    return t.side === "sell"
        ? ark.contract(programs.sell, common)
        : ark.contract(programs.buy, { ...common, reserve: t.reserveSats });
}

/** Smallest bet or offer, in sats. */
export const MIN_BET_SATS = DUST_SATS;

/** Smallest min fill at `price` that keeps every partial fill at or above MIN_BET_SATS. */
export const minFillFor = (price: bigint) => (MIN_BET_SATS + price - 1n) / price;

/** Why an offer of `size` units on `t` is too small to post, or undefined. */
export function offerTooSmall(t: Pick<OfferTerms, "priceSats" | "minFill">, size: bigint): string | undefined {
    if (size * t.priceSats < MIN_BET_SATS) return `An offer must be worth at least ${MIN_BET_SATS} sats`;
    if (t.minFill * t.priceSats < MIN_BET_SATS) return `Min fill must be worth at least ${MIN_BET_SATS} sats (${minFillFor(t.priceSats)} shares at this price)`;
    return undefined;
}

/** A buy offer left with `left` sats of budget closes to its maker: no further legal fill fits. */
export const buyCloses = (t: Pick<OfferTerms, "priceSats" | "minFill">, left: bigint) => left < t.minFill * t.priceSats || left < MIN_BET_SATS;

/**
 * `fill` in sell_offer.ark / buy_offer.ark: whether a fill of `qty` passes, given the units a sell offer holds
 * or the value of a buy offer's coin.
 */
export function fillAllowed(t: Pick<OfferTerms, "side" | "priceSats" | "minFill" | "reserveSats" | "legacy">, held: { units: bigint; value: bigint }, qty: bigint): boolean {
    if (t.legacy || qty <= 0n || qty * t.priceSats < MIN_BET_SATS) return false;
    if (t.side === "sell") {
        const rest = held.units - qty;
        return rest >= 0n && (qty >= t.minFill || rest === 0n) && (rest === 0n || rest * t.priceSats >= MIN_BET_SATS);
    }
    const left = held.value - qty * t.priceSats - t.reserveSats;
    return left >= 0n && (qty >= t.minFill || buyCloses(t, left));
}

/** Sats a taker pays (sell side) or receives (buy side) for `qty` units. */
export function fillNotional(t: Pick<OfferTerms, "priceSats">, qty: bigint): bigint {
    if (qty <= 0n) throw new Error("qty must be positive");
    return qty * t.priceSats;
}
