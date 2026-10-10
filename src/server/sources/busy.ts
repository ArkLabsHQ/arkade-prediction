import { UPDOWN_SLUG } from "../updown.js";
import type { ProviderName, SourceMarket } from "./types.js";

/**
 * 24h volume floors in each source's unit, from the eligible markets of five import pages on 2026-10-10:
 * Polymarket p67 was 2,782 USD and Manifold p67 336 mana; Kalshi only 16 of 456 traded at all (max 743).
 */
export const MIN_VOLUME_24H: Record<ProviderName, number> = { polymarket: 2500, kalshi: 10, manifold: 300, limitless: 100, opinion: 1000 };

/** Where the LP spends its capital. Up/Down windows have no volume before they start and are the demo's fast markets. */
export function isBusy(m: Pick<SourceMarket, "provider" | "slug"> & { volume24h?: number | null }): boolean {
    if (UPDOWN_SLUG.test(m.slug)) return true;
    return typeof m.volume24h === "number" && m.volume24h >= (MIN_VOLUME_24H[m.provider] ?? Infinity);
}
