import { hex } from "@scure/base";
import { bindingHash, type MarketBinding } from "./attestation.js";
import { canonicalJson, sha256Hex } from "./encoding.js";
import { TEMPLATE, type MarketAssets } from "./market.js";

/** Immutable terms a market is funded under. Source identity is included for imported markets. */
export interface MarketDefinition {
    question: string;
    rules: string;
    outcomes: readonly [string, string];
    category: string | null;
    closeAtUnix: string;
    timeoutAtUnix: string;
    source?: Record<string, unknown> | null;
}

export function definitionHash(d: MarketDefinition): string {
    return sha256Hex(canonicalJson({ ...d, outcomes: [...d.outcomes], source: d.source ?? null }));
}

export interface BindingInput {
    network: string;
    arkSigner: Uint8Array;
    emulatorSigner: Uint8Array;
    marketId: string;
    definition: MarketDefinition;
    unitSats: bigint;
    assets: MarketAssets;
    /** The vault's attestor slots, in order (see `oracleSlots`). */
    oracleKeys: string[];
    oracleThreshold: number;
    oracleEpoch: number;
}

export function marketBinding(b: BindingInput): MarketBinding {
    return {
        schema: 1,
        deployment: { network: b.network, arkSigner: hex.encode(b.arkSigner), emulatorSigner: hex.encode(b.emulatorSigner) },
        template: TEMPLATE,
        marketId: b.marketId,
        definitionHash: definitionHash(b.definition),
        collateral: { kind: "BTC", unitSats: b.unitSats },
        claims: { ctrl: b.assets.ctrl, outcomes: [b.assets.yes, b.assets.no] },
        outcomeLabels: [...b.definition.outcomes],
        source: b.definition.source ?? null,
        oracle: { keys: b.oracleKeys, threshold: b.oracleThreshold, epoch: b.oracleEpoch },
        timing: { closeAt: BigInt(b.definition.closeAtUnix), timeoutAt: BigInt(b.definition.timeoutAtUnix) },
    };
}

export const bindingOf = (b: BindingInput) => bindingHash(marketBinding(b));
