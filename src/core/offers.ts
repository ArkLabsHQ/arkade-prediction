import sellOfferArtifact from "../../contracts/artifacts/sell_offer.json" with { type: "json" };
import buyOfferArtifact from "../../contracts/artifacts/buy_offer.json" with { type: "json" };
import { assetScriptArgs } from "./assets.js";
import type { ArkadeClient, Contract } from "./market.js";
import { loadProgram, type ContractArtifact } from "./programs.js";

export const OFFER_PROGRAMS = {
    sell: loadProgram(sellOfferArtifact as ContractArtifact),
    buy: loadProgram(buyOfferArtifact as ContractArtifact),
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
    return t.side === "sell"
        ? ark.contract(OFFER_PROGRAMS.sell, common)
        : ark.contract(OFFER_PROGRAMS.buy, { ...common, reserve: t.reserveSats });
}

/** Sats a taker pays (sell side) or receives (buy side) for `qty` units. */
export function fillNotional(t: Pick<OfferTerms, "priceSats">, qty: bigint): bigint {
    if (qty <= 0n) throw new Error("qty must be positive");
    return qty * t.priceSats;
}
