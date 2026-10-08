import { hex } from "@scure/base";
import { attestationMessage, verifyAttestation } from "../core/attestation.js";
import type { MarketDefinition } from "../core/definition.js";
import { BINARY_VECTORS, type BinaryOutcome } from "../core/payout.js";
import type { CertificateJson } from "../shared/api.js";
import { all, now, run } from "./db.js";
import { marketTerms, type Deps, type MarketRow } from "./markets.js";
import type { MarketSourceProvider, SourceMarket } from "./sources/types.js";

type SourceDeps = Deps & { provider: MarketSourceProvider; log: (m: string, e?: Record<string, unknown>) => void };
type Snapshot = SourceMarket & { binding: MarketDefinition["source"] };

const lastPoll = new Map<string, number>();
let lastScreen = 0;

/**
 * Tracks imported markets after close. Indexed source state only decides when to ask; the attestor re-reads
 * the finalized chain itself, and the certificate is checked here against the pinned key and our binding.
 */
export async function resolutionTick(d: SourceDeps): Promise<void> {
    await screenOpenMarkets(d).catch((err) => d.log("early resolution screen failed", { error: String(err) }));
    const due = all<MarketRow>(d.db,
        `SELECT * FROM markets WHERE kind = 'polymarket' AND terms IS NOT NULL AND vault_phase = 'open' AND close_at <= ?
         AND NOT EXISTS (SELECT 1 FROM certificates c WHERE c.market_id = markets.id)`, Math.floor(Date.now() / 1000));
    for (const m of due) {
        if (Date.now() - (lastPoll.get(m.id) ?? 0) < d.cfg.RESOLUTION_INTERVAL_SECONDS * 1000) continue;
        lastPoll.set(m.id, Date.now());
        const snapshot = JSON.parse(m.source_snapshot!) as Snapshot;
        try {
            const evidence = await d.provider.fetchResolutionEvidence(snapshot);
            run(d.db, "UPDATE markets SET resolution_status = ?, resolution_detail = ?, updated_at = ? WHERE id = ?", evidence.status, evidence.detail.slice(0, 500), now(), m.id);
            if (evidence.status === "final") await requestCertificate(d, m, snapshot);
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
        `SELECT * FROM markets WHERE kind = 'polymarket' AND terms IS NOT NULL AND vault_phase = 'open' AND close_at > ?
         AND resolution_status != 'source-final' AND source_id NOT LIKE '%#replay-%'
         AND NOT EXISTS (SELECT 1 FROM certificates c WHERE c.market_id = markets.id)`, Math.floor(Date.now() / 1000));
    if (open.length === 0) return;
    lastScreen = Date.now();
    const snapshots = open.map((m) => JSON.parse(m.source_snapshot!) as Snapshot);
    const resolved = new Set(await d.provider.screenResolved(snapshots));
    for (const [i, m] of open.entries()) {
        const snapshot = snapshots[i]!;
        if (!resolved.has(snapshot.protocol.conditionId)) continue;
        try {
            const evidence = await d.provider.fetchResolutionEvidence(snapshot);
            const verified = d.provider.verifyFinalResolution(snapshot, evidence, m.profile ?? "");
            if (!verified.ok) {
                d.log("early resolution not confirmed", { market: m.id, reason: verified.reason });
                continue;
            }
            const [n0, n1] = evidence.vector!.numerators;
            const outcome = n0 === n1 ? "50-50" : (JSON.parse(m.outcomes) as string[])[n0! > n1! ? 0 : 1];
            const block = { number: evidence.chain!.blockNumber, hash: evidence.chain!.blockHash };
            run(d.db, "UPDATE markets SET resolution_status = 'source-final', resolution_detail = ?, updated_at = ? WHERE id = ?",
                `Polymarket resolved early: ${outcome} at Polygon block ${block.number}`, now(), m.id);
            d.bus.publish("market", m.id, { resolution: "source-final", outcome, sourceBlock: block });
        } catch (err) {
            d.log("early resolution check failed", { market: m.id, error: String(err) });
        }
    }
}

export async function requestCertificate(d: Deps, m: MarketRow, snapshot: { binding: MarketDefinition["source"] }): Promise<CertificateJson> {
    const terms = marketTerms(m)!;
    if (!d.cfg.ORACLE_URL) throw new Error("ORACLE_URL not configured");
    const definition: MarketDefinition = {
        question: m.question, rules: m.rules, outcomes: JSON.parse(m.outcomes), category: m.category,
        closeAtUnix: String(m.close_at), timeoutAtUnix: String(m.timeout_at), source: snapshot.binding,
    };
    const res = await fetch(`${d.cfg.ORACLE_URL}/attest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify({
            marketId: m.id, definition, assets: terms.assets, unitSats: terms.unitSats.toString(), epoch: m.oracle_epoch,
            deployment: { network: d.cfg.APM_NETWORK, arkSigner: hex.encode(d.net.ark.serverKey), emulatorSigner: hex.encode(d.net.ark.emulatorKey!) },
        }),
    });
    const body = (await res.json()) as { certificate?: CertificateJson; status?: string; detail?: string; error?: string };
    if (!res.ok || !body.certificate) throw new Error(`attestor refused: ${body.error ?? body.status ?? res.status} ${body.detail ?? ""}`);
    const cert = body.certificate;
    if (!d.cfg.ORACLE_PUBKEYS.includes(cert.signer) || cert.signer !== hex.encode(terms.oracleKey)) throw new Error("certificate signer is not the market's pinned attestor");
    const vector = BINARY_VECTORS[cert.outcome as BinaryOutcome];
    if (!vector || !verifyAttestation(hex.decode(cert.signature), terms.oracleKey, attestationMessage(terms.binding, hex.decode(cert.evidenceDigest), vector))) {
        throw new Error("certificate does not verify against this market's binding");
    }
    run(d.db, "INSERT OR IGNORE INTO certificates(market_id, outcome, numerators, denominator, evidence_digest, evidence, signature, signer, source_block, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        m.id, cert.outcome, JSON.stringify(cert.numerators), cert.denominator, cert.evidenceDigest, JSON.stringify((body as { evidence?: unknown }).evidence ?? null),
        cert.signature, cert.signer, cert.sourceBlock ? JSON.stringify(cert.sourceBlock) : null, now());
    run(d.db, "UPDATE markets SET resolution_status = 'certified', resolution_detail = ?, updated_at = ? WHERE id = ?", `attestor certified ${cert.outcome} at block ${cert.sourceBlock?.number ?? "?"}`, now(), m.id);
    d.bus.publish("resolution", m.id, { outcome: cert.outcome, sourceBlock: cert.sourceBlock });
    return cert;
}
