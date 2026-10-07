import type { OfferJson } from "../shared/api.js";

export interface Leg {
    offer: OfferJson;
    qty: bigint;
    price: bigint;
}

export interface Plan {
    legs: Leg[];
    qty: bigint;
    notional: bigint;
    worst: bigint | null;
    /** Units resting on the side being taken, whether or not a legal fill reaches them. */
    depth: bigint;
}

/** Open, funded, unexpired (30 s margin for emulator clock skew) and not the taker's own. */
export function fillable(o: OfferJson, nowUnix: number, takerScript?: string): boolean {
    const exp = BigInt(o.terms.expiresAtUnix);
    return o.status === "open" && o.coin !== null && BigInt(o.remaining) > 0n
        && (exp === 0n || exp > BigInt(nowUnix + 30)) && o.terms.makerScript !== takerScript;
}

/** min(want, remaining) if the SellOffer/BuyOffer covenant accepts that fill, else 0n. */
export function legalTake(o: OfferJson, want: bigint): bigint {
    const t = o.terms;
    const remaining = BigInt(o.remaining);
    const min = BigInt(t.minFill);
    const price = BigInt(t.priceSats);
    const q = want < remaining ? want : remaining;
    if (q <= 0n) return 0n;
    if (t.side === "sell") return q >= min || q === remaining ? q : 0n;
    const reserve = BigInt(t.reserveSats);
    const value = o.coin ? BigInt(o.coin.valueSats) : remaining * price + reserve;
    const left = value - reserve - q * price;
    return left >= 0n && (q >= min || left < min * price) ? q : 0n;
}

/** Buying walks asks cheapest first, selling walks bids richest first. Never overfills, never invents a price. */
export function planFill(book: OfferJson[], side: "buy" | "sell", qty: bigint, nowUnix: number, takerScript?: string): Plan {
    const resting = side === "buy" ? "sell" : "buy";
    const sorted = book
        .filter((o) => o.terms.side === resting && fillable(o, nowUnix, takerScript))
        .sort((a, b) => {
            const d = BigInt(a.terms.priceSats) - BigInt(b.terms.priceSats);
            if (d === 0n) return a.createdAt.localeCompare(b.createdAt);
            return (d < 0n) === (side === "buy") ? -1 : 1;
        });
    const legs: Leg[] = [];
    let need = qty;
    let depth = 0n;
    for (const o of sorted) {
        depth += BigInt(o.remaining);
        const take = legalTake(o, need);
        if (take === 0n) continue;
        legs.push({ offer: o, qty: take, price: BigInt(o.terms.priceSats) });
        need -= take;
    }
    return { legs, qty: qty - need, notional: legs.reduce((s, l) => s + l.qty * l.price, 0n), worst: legs.at(-1)?.price ?? null, depth };
}
