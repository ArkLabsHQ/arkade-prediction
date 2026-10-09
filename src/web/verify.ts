import { hex } from "@scure/base";
import { AuditError, auditGenesis } from "../core/audit.js";
import { bindingOf, type MarketDefinition } from "../core/definition.js";
import { ORACLE_SLOTS, oracleSlots, type ArkadeClient, type VaultTerms } from "../core/market.js";
import { offerContract, type Side } from "../core/offers.js";
import { offerTermsFromJson, termsFromJson, type ConfigJson, type MarketJson, type MarketTermsJson, type OfferJson, type PriceTermsJson } from "../shared/api.js";
import { REDSTONE_PRIMARY_SIGNERS, feedIdBytes } from "../core/redstone.js";
import type { Chain } from "./chain.js";
import { errMsg } from "./format.js";

export interface Deployment {
    network: string;
    arkSigner: Uint8Array;
    emulatorSigner: Uint8Array;
}

const xOnly = (key: string) => key.toLowerCase().slice(-64);

/** The definition this page displays, in the exact shape the market binding commits to. */
export function displayedDefinition(m: MarketJson): MarketDefinition {
    if (!m.terms) throw new Error("the market has no funded terms");
    return {
        question: m.question, rules: m.rules, outcomes: m.outcomes, category: m.category,
        closeAtUnix: String(Date.parse(m.closeAt) / 1000), timeoutAtUnix: m.terms.timeoutAtUnix,
        source: m.source?.binding ?? null,
    };
}

/** Throws unless terms.binding commits to what the page displays, on this deployment. */
export function checkDisplayedBinding(m: MarketJson, dep: Deployment): void {
    const t = m.terms;
    if (t?.price) return checkPriceTerms(m, t, t.price);
    const definition = displayedDefinition(m);
    if (!t || definition.closeAtUnix !== t.closeAtUnix) throw new Error("the close time shown differs from the funded terms");
    if (m.oracle.threshold !== t.oracleThreshold || m.oracle.keys.map((k) => k.toLowerCase()).join() !== t.oracleKeys.join()) {
        throw new Error("the attestors shown are not the ones the vault checks");
    }
    try {
        if (t.oracleKeys.length !== ORACLE_SLOTS) throw new Error("wrong number of attestor slots");
        oracleSlots(t.oracleKeys.map((k) => hex.decode(k)), t.oracleThreshold);
    } catch (err) {
        throw new Error(`the vault's attestor set is not valid: ${(err as Error).message}`);
    }
    const s = m.source;
    const b = s?.binding;
    if (s && (!b || b.sourceId !== s.sourceId || b.protocolVersion !== s.protocol || b.conditionId !== s.conditionId || b.questionId !== s.questionId || (b.resolver ?? null) !== s.resolver)) {
        throw new Error("the source shown differs from the committed source identity");
    }
    const expected = bindingOf({
        network: dep.network, arkSigner: dep.arkSigner, emulatorSigner: dep.emulatorSigner, marketId: m.id, definition,
        unitSats: BigInt(t.unitSats), assets: t.assets, oracleKeys: t.oracleKeys, oracleThreshold: t.oracleThreshold, oracleEpoch: m.oracle.epoch,
    });
    if (hex.encode(expected) !== t.binding) throw new Error("the funded terms do not commit to the question, rules, outcomes, timing, source and oracle shown, on this network");
}

/** Refuses any leg that would not trade this market's claim for the chosen outcome, on the side being taken. */
export function checkLegs(ark: ArkadeClient, offers: OfferJson[], takerSide: Side, assetId: string): void {
    const resting: Side = takerSide === "buy" ? "sell" : "buy";
    for (const o of offers) {
        if (o.terms.assetId !== assetId) throw new Error(`Order ${o.id} trades a different asset than the outcome you picked; nothing was signed`);
        if (o.terms.side !== resting) throw new Error(`Order ${o.id} is not ${resting === "sell" ? "an ask" : "a bid"}; nothing was signed`);
        if (hex.encode(offerContract(ark, offerTermsFromJson(o.terms)).pkScript) !== o.script) throw new Error(`Order ${o.id} is listed under a script its terms do not produce; nothing was signed`);
    }
}

async function verify(chain: Chain, config: ConfigJson, m: MarketJson): Promise<VaultTerms> {
    const emulatorSigner = chain.ark.emulatorKey;
    if (!m.terms || !m.genesisTxid || !m.vaultTxid) throw new Error("the market lists no vault funding to audit");
    if (!emulatorSigner || xOnly(hex.encode(emulatorSigner)) !== xOnly(config.emulatorPubkey)) throw new Error("the Arkade client does not use this deployment's emulator key");
    if (hex.encode(chain.ark.serverKey) !== xOnly(config.arkSignerPubkey)) throw new Error("the Arkade operator signs with a different key than this deployment pins");
    checkDisplayedBinding(m, { network: config.network, arkSigner: chain.ark.serverKey, emulatorSigner });
    const terms = termsFromJson(m.terms);
    await auditGenesis(chain, terms, m.genesisTxid, m.vaultTxid);
    return terms;
}

const verified = new Map<string, { key: string; terms: Promise<VaultTerms> }>();

/**
 * Terms of `m`, audited against this browser's own Arkade connection; the first money-moving action on a market
 * pays for the audit and later ones reuse it unless the server starts serving different terms.
 */
export function verifiedTerms(chain: Chain, config: ConfigJson, m: MarketJson): Promise<VaultTerms> {
    const s = m.source;
    const key = JSON.stringify([
        hex.encode(chain.ark.serverKey), m.question, m.rules, m.outcomes, m.category, m.closeAt, m.oracle.keys, m.oracle.threshold, m.oracle.epoch,
        m.terms, m.genesisTxid, m.vaultTxid, s && [s.binding, s.sourceId, s.protocol, s.conditionId, s.questionId, s.resolver],
    ]);
    const hit = verified.get(m.id);
    if (hit?.key === key) return hit.terms;
    const terms: Promise<VaultTerms> = verify(chain, config, m).catch((e: unknown) => {
        if (verified.get(m.id)?.terms === terms) verified.delete(m.id);
        throw new Error(`This market failed verification, so nothing was signed: ${errMsg(e)}${e instanceof AuditError ? ` (${e.code})` : ""}`);
    });
    verified.set(m.id, { key, terms });
    return terms;
}

/** A RedStone-settled vault checks no attestation: its feed, rounds, timing and signer set must be the ones shown. */
function checkPriceTerms(m: MarketJson, t: MarketTermsJson, p: PriceTermsJson): void {
    const s = (m.source?.binding as { settlement?: { oracle?: string; feed?: string; startAtMs?: number; endAtMs?: number } } | null)?.settlement;
    if (m.oracle.policy !== "redstone" || !s || s.oracle !== "redstone-primary-prod" || typeof s.feed !== "string") throw new Error("the market does not show the RedStone settlement its vault uses");
    if (p.feedId !== hex.encode(feedIdBytes(s.feed))) throw new Error(`the vault settles on another feed than ${s.feed}`);
    if (p.kind !== "updown" || p.startAtMs !== String(s.startAtMs) || p.endAtMs !== String(s.endAtMs)) throw new Error("the vault settles on other rounds than the ones shown");
    if (BigInt(Date.parse(m.closeAt)) !== BigInt(p.endAtMs) || t.closeAtUnix !== String(Date.parse(m.closeAt) / 1000)) throw new Error("the close time shown differs from the settlement round");
    if (m.oracle.keys.map((key) => key.toLowerCase()).join() !== p.signers.join()) throw new Error("the RedStone signers shown are not the ones the vault checks");
    if (p.signers.length !== 5 || new Set(p.signers).size !== 5 || p.signers.some((key) => !REDSTONE_PRIMARY_SIGNERS.includes(key))) throw new Error("the vault does not commit to the RedStone primary-prod signers");
    if (p.quorum * 2 <= 5) throw new Error("the vault quorum is not a majority of its signers");
}
