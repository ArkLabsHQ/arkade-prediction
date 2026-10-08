import { mine } from "./env.js";

/**
 * The stack mines only on demand. Without blocks the median time never passes a batch's expiry, the operator's
 * sweeper cannot reclaim it, and its liquidity drains until new batches (renewals, note redemptions) stall.
 */
export default function setup(): void {
    mine(12);
}
