/** Exact settlement math. All quantities are bigint; never floats. */

export interface PayoutVector {
    numerators: readonly bigint[];
    denominator: bigint;
}

export const BINARY_VECTORS = {
    yes: { numerators: [1n, 0n], denominator: 1n },
    no: { numerators: [0n, 1n], denominator: 1n },
    invalid: { numerators: [1n, 1n], denominator: 2n },
} as const satisfies Record<string, PayoutVector>;

export type BinaryOutcome = keyof typeof BINARY_VECTORS;

export function assertVector(v: PayoutVector): void {
    if (v.denominator <= 0n) throw new Error("denominator must be positive");
    if (v.numerators.some((n) => n < 0n)) throw new Error("numerators must be non-negative");
    const sum = v.numerators.reduce((a, b) => a + b, 0n);
    if (sum !== v.denominator) throw new Error("numerators must sum to the denominator");
}

/** floor(sum(burn[i] * n[i]) * unit / D) — what ResolvedVault.redeem releases. */
export function redemptionPayout(burns: readonly bigint[], v: PayoutVector, unit: bigint): bigint {
    assertVector(v);
    if (burns.length !== v.numerators.length) throw new Error("burn vector length mismatch");
    if (burns.some((b) => b < 0n)) throw new Error("burns must be non-negative");
    const weighted = burns.reduce((acc, b, i) => acc + b * v.numerators[i]!, 0n);
    return (weighted * unit) / v.denominator;
}

/** Collateral that stays unclaimable after every outstanding claim is redeemed one unit at a time. */
export function worstCaseResidual(sets: bigint, v: PayoutVector, unit: bigint): bigint {
    const perUnit = v.numerators.map((n) => (n * unit) / v.denominator);
    return sets * unit - sets * perUnit.reduce((a, b) => a + b, 0n);
}
