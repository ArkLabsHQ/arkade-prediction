/** Source-market adapter contract. Implementations must never infer settlement from titles or prices. */

export type ProviderName = "polymarket" | "kalshi" | "manifold";
export const PROVIDER_LABEL: Record<ProviderName, string> = { polymarket: "Polymarket", kalshi: "Kalshi", manifold: "Manifold" };


/** API sources (Kalshi, Manifold) use chainId 0, their API as settlementContract and their market key as conditionId. */
export interface SourceProtocol {
    /** Source-reported position-system version, e.g. Polymarket "v1" (legacy CTF) or "v2". */
    version: string;
    chainId: number;
    negRisk: boolean;
    /** Neg-risk market whose condition the NegRiskAdapter reports (not an "Other" placeholder). */
    negRiskAdapter?: true;
    /** Resolver/oracle contract that will report the payout (lowercase 0x address), if known. */
    resolver: string | null;
    conditionId: string;
    questionId: string;
    /** Settlement contract read for the final payout (CTF for v1). */
    settlementContract: string;
}

export interface SourceMarket {
    provider: ProviderName;
    sourceId: string;
    slug: string;
    url: string;
    question: string;
    /** Full resolution rules as published by the source. */
    description: string;
    resolutionSource: string;
    /** Outcome labels in source order; index i maps to payout numerator i. */
    outcomes: string[];
    endDate: string | null;
    tags: string[];
    active: boolean;
    closed: boolean;
    archived: boolean;
    sourceStatus: string | null;
    protocol: SourceProtocol;
    /** Source prices as decimal strings in [0,1]. Reference only: never executable here. */
    referencePrices: { outcome: string; price: string }[] | null;
    /** Display only, outside versionHash: Polymarket's image (its upload bucket only) and parent event. */
    image: string | null;
    event: { title: string; slug: string } | null;
    /** Sports kickoff, when the source lists one. */
    gameStartTime: string | null;
    /** sha256 of the canonical normalized snapshot; changes when any field above changes. */
    versionHash: string;
    fetchedAt: string;
}

export interface EligibilityPolicy {
    profiles: string[];
    tags: string[];
    maxHorizonSeconds: number;
    minHorizonSeconds: number;
}

export type Eligibility =
    | { eligible: true; profile: string }
    | { eligible: false; code: string; reason: string };

export type ResolutionStatus =
    | "unresolved"
    | "proposed"
    | "disputed"
    | "too-early"
    | "final"
    | "unsupported"
    | "inconsistent";

export interface ResolutionEvidence {
    status: ResolutionStatus;
    detail: string;
    /** Present only when status is "final". */
    vector?: { numerators: bigint[]; denominator: bigint };
    /** Consistent finalized read used for the decision. Providers are labels ("host#n"), never URLs. */
    chain?: { chainId: number; blockNumber: string; blockHash: string; providers: string[] };
    /** Raw reads and identities bound into the attestation evidence digest. */
    reads?: Record<string, unknown>;
    observedAt: string;
}

export interface Page {
    markets: SourceMarket[];
    next: string | null;
}

export interface MarketSourceProvider {
    readonly name: ProviderName;
    /** The one eligibility profile this provider admits; it is bound into each market it imports. */
    readonly profile: string;
    /** `tag` narrows discovery to one source category (a Polymarket tag slug, a Kalshi category, ...). */
    discoverMarkets(cursor: string | null, limit: number, opts?: { tag?: string }): Promise<Page>;
    fetchMarketDefinition(sourceId: string): Promise<SourceMarket>;
    fetchMarketsBySlug?(slugs: string[]): Promise<SourceMarket[]>;
    /** The document an attestor hashes into its certificate's evidence digest. */
    evidenceRecord(market: SourceMarket, evidence: ResolutionEvidence): unknown;
    evaluateEligibility(market: SourceMarket, policy: EligibilityPolicy, now: Date): Eligibility;
    /** Reads authoritative settlement state at one finalized block across >= 2 providers. */
    /** `atBlock` pins the read so independent attestors sign identical evidence; it must already be finalized. */
    fetchResolutionEvidence(market: SourceMarket, opts?: { atBlock?: bigint }): Promise<ResolutionEvidence>;
    /** Trigger, never evidence: condition ids a quorum reports resolved, from one batch per provider. Confirm each. */
    screenResolved(markets: SourceMarket[]): Promise<string[]>;
    /** Re-checks evidence against the pinned profile (identity, resolver allowlist, vector shape). */
    verifyFinalResolution(market: SourceMarket, evidence: ResolutionEvidence, profile: string): { ok: true } | { ok: false; reason: string };
    /**
     * Authenticates from the chain who may report this market's result; a permissionless resolver makes its own
     * address no proof. Runs before activation and again in the attestor, which never relies on the server. Fails closed.
     */
    vetSource?(market: SourceMarket): Promise<{ ok: true } | { ok: false; reason: string }>;
}
