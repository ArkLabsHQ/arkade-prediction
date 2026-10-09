import { hex } from "@scure/base";
import type { MarketDefinition } from "../core/definition.js";
import type { CertificateJson } from "../shared/api.js";
import { acceptCertificate, quorums } from "./certificates.js";
import { all, now, run } from "./db.js";
import { marketTerms, type Deps, type MarketRow } from "./markets.js";
import { PROVIDER_LABEL, type MarketSourceProvider, type SourceMarket } from "./sources/types.js";

type SourceDeps = Deps & { providers: MarketSourceProvider[]; log: (m: string, e?: Record<string, unknown>) => void };
const providerOf = (d: SourceDeps, m: MarketRow) => d.providers.find((p) => p.name === m.source_provider);
type Snapshot = SourceMarket & { binding: MarketDefinition["source"] };

const lastPoll = new Map<string, number>();
let lastScreen = 0;

/**
 * Tracks imported markets after close. Indexed source state only decides when to ask; each attestor re-reads
 * the finalized chain itself at the block we read, and every certificate is checked against the market's
 * attestor set and binding.
 */
export async function resolutionTick(d: SourceDeps): Promise<void> {
    await screenOpenMarkets(d).catch((err) => d.log("early resolution screen failed", { error: String(err) }));
    const due = all<MarketRow>(d.db,
        "SELECT * FROM markets WHERE kind = 'polymarket' AND oracle_policy != 'redstone' AND terms IS NOT NULL AND vault_phase = 'open' AND close_at <= ?", Math.floor(Date.now() / 1000))
        .filter((m) => { const t = marketTerms(m); return t && quorums(d.db, m.id, t).length === 0; });
    for (const m of due) {
        if (Date.now() - (lastPoll.get(m.id) ?? 0) < d.cfg.RESOLUTION_INTERVAL_SECONDS * 1000) continue;
        lastPoll.set(m.id, Date.now());
        const snapshot = JSON.parse(m.source_snapshot!) as Snapshot;
        const provider = providerOf(d, m);
        if (!provider) continue;
        try {
            const evidence = await provider.fetchResolutionEvidence(snapshot);
            run(d.db, "UPDATE markets SET resolution_status = ?, resolution_detail = ?, updated_at = ? WHERE id = ?", evidence.status, evidence.detail.slice(0, 500), now(), m.id);
            if (evidence.status === "final") await requestCertificates(d, m, snapshot, evidence.chain?.blockNumber);
        } catch (err) {
            d.log("resolution check failed", { market: m.id, error: String(err) });
            run(d.db, "UPDATE markets SET resolution_status = 'source-unavailable', resolution_detail = ?, updated_at = ? WHERE id = ?", String(err).slice(0, 300), now(), m.id);
        }
    }
}

/** Sources can resolve long before their end date. Certificates still wait for close: the covenant refuses earlier. */
async function screenOpenMarkets(d: SourceDeps): Promise<void> {
    if (Date.now() - lastScreen < d.cfg.RESOLUTION_INTERVAL_SECONDS * 1000) return;
    // Historical replays mirror an already-resolved source by design.
    const open = all<MarketRow>(d.db,
        `SELECT * FROM markets WHERE kind = 'polymarket' AND oracle_policy != 'redstone' AND terms IS NOT NULL AND vault_phase = 'open' AND close_at > ?
         AND resolution_status != 'source-final' AND source_id NOT LIKE '%#replay-%'
         AND NOT EXISTS (SELECT 1 FROM certificates c WHERE c.market_id = markets.id)`, Math.floor(Date.now() / 1000));
    if (open.length === 0) return;
    lastScreen = Date.now();
    const resolved = new Set<string>();
    for (const provider of d.providers) {
        const mine = open.filter((m) => m.source_provider === provider.name).map((m) => JSON.parse(m.source_snapshot!) as Snapshot);
        if (mine.length > 0) for (const id of await provider.screenResolved(mine)) resolved.add(`${provider.name}:${id}`);
    }
    for (const m of open) {
        const snapshot = JSON.parse(m.source_snapshot!) as Snapshot;
        const provider = providerOf(d, m);
        if (!provider || !resolved.has(`${provider.name}:${snapshot.protocol.conditionId}`)) continue;
        try {
            const evidence = await provider.fetchResolutionEvidence(snapshot);
            const verified = provider.verifyFinalResolution(snapshot, evidence, m.profile ?? "");
            if (!verified.ok) {
                d.log("early resolution not confirmed", { market: m.id, reason: verified.reason });
                continue;
            }
            const [n0, n1] = evidence.vector!.numerators;
            const outcome = n0 === n1 ? "50-50" : (JSON.parse(m.outcomes) as string[])[n0! > n1! ? 0 : 1];
            const block = evidence.chain ? { number: evidence.chain.blockNumber, hash: evidence.chain.blockHash } : null;
            run(d.db, "UPDATE markets SET resolution_status = 'source-final', resolution_detail = ?, updated_at = ? WHERE id = ?",
                `${PROVIDER_LABEL[provider.name]} resolved early: ${outcome}${block ? ` at Polygon block ${block.number}` : ""}`, now(), m.id);
            d.bus.publish("market", m.id, { resolution: "source-final", outcome, sourceBlock: block });
        } catch (err) {
            d.log("early resolution check failed", { market: m.id, error: String(err) });
        }
    }
}

/** Asks every configured attestor to sign at `atBlock`; returns how many certificates were accepted. */
export async function requestCertificates(d: Deps & { log: (m: string, e?: Record<string, unknown>) => void }, m: MarketRow, snapshot: { binding: MarketDefinition["source"] }, atBlock?: string): Promise<number> {
    const terms = marketTerms(m)!;
    if (d.cfg.ORACLE_URLS.length === 0) throw new Error("no attestor URL configured (ORACLE_URLS)");
    const definition: MarketDefinition = {
        question: m.question, rules: m.rules, outcomes: JSON.parse(m.outcomes), category: m.category,
        closeAtUnix: String(m.close_at), timeoutAtUnix: String(m.timeout_at), source: snapshot.binding,
    };
    const request = JSON.stringify({
        marketId: m.id, definition, assets: terms.assets, unitSats: terms.unitSats.toString(), epoch: m.oracle_epoch,
        deployment: { network: d.cfg.APM_NETWORK, arkSigner: hex.encode(d.net.ark.serverKey), emulatorSigner: hex.encode(d.net.ark.emulatorKey!) },
        oracle: { keys: terms.oracleKeys.map((k) => hex.encode(k)), threshold: terms.oracleThreshold },
        atBlock,
    });
    let accepted = 0;
    for (const url of d.cfg.ORACLE_URLS) {
        try {
            const res = await fetch(`${url}/attest`, { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120_000), body: request });
            const body = (await res.json()) as { certificate?: CertificateJson; evidence?: unknown; status?: string; detail?: string; error?: string };
            if (!res.ok || !body.certificate) throw new Error(`attestor refused: ${body.error ?? body.status ?? res.status} ${body.detail ?? ""}`);
            acceptCertificate(d, m.id, terms, body.certificate, body.evidence);
            accepted++;
        } catch (err) {
            d.log("attestation request failed", { market: m.id, attestor: new URL(url).host, error: String(err).slice(0, 300) });
        }
    }
    return accepted;
}
