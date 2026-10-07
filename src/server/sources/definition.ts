import type { MarketDefinition } from "../../core/definition.js";
import type { SourceMarket } from "./types.js";

/** Immutable source identity a funded market follows. Excludes prices and the mutable version hash. */
export function sourceBinding(m: SourceMarket, profile: string) {
    return {
        provider: m.provider,
        profile,
        sourceId: m.sourceId,
        chainId: m.protocol.chainId,
        protocolVersion: m.protocol.version,
        settlementContract: m.protocol.settlementContract,
        resolver: m.protocol.resolver,
        conditionId: m.protocol.conditionId,
        questionId: m.protocol.questionId,
        outcomes: [...m.outcomes],
        payoutPolicy: "follow-final-source-payout-vector; 50-50 maps to INVALID [1,1]/2; no source result by timeout => INVALID",
    };
}

/** The question and rules text are committed as imported; later source edits are recorded, never applied. */
export function importedDefinition(m: SourceMarket, profile: string, timeoutDays: number): MarketDefinition {
    if (!m.endDate || m.outcomes.length !== 2) throw new Error("imported market needs an end date and two outcomes");
    const closeAt = Math.floor(Date.parse(m.endDate) / 1000);
    return {
        question: m.question,
        rules: `${m.description}\n\nResolution source: ${m.resolutionSource || "as stated in the rules"}`,
        outcomes: [m.outcomes[0]!, m.outcomes[1]!],
        category: m.tags[0] ?? null,
        closeAtUnix: String(closeAt),
        timeoutAtUnix: String(closeAt + timeoutDays * 86_400),
        source: sourceBinding(m, profile),
    };
}
