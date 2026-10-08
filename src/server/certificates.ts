import { hex } from "@scure/base";
import { attestationMessage, verifyAttestation } from "../core/attestation.js";
import { slotSignatures, type VaultTerms } from "../core/market.js";
import { BINARY_VECTORS, type BinaryOutcome } from "../core/payout.js";
import type { CertificateJson } from "../shared/api.js";
import { all, now, run, type Db } from "./db.js";
import { HttpError, type Deps } from "./markets.js";

interface CertRow {
    outcome: BinaryOutcome;
    evidence_digest: string;
    signer: string;
    signature: string;
}

export interface Quorum {
    outcome: BinaryOutcome;
    evidence: string;
    signers: number;
    /** In the vault's attestor-slot order, ready for `resolveMarket`. */
    signatures: Uint8Array[];
}

/** One entry per (outcome, evidence) signed by at least `oracleThreshold` distinct attestors of the market. */
export function quorums(db: Db, marketId: string, terms: VaultTerms): Quorum[] {
    const groups = new Map<string, CertRow[]>();
    for (const r of all<CertRow>(db, "SELECT outcome, evidence_digest, signer, signature FROM certificates WHERE market_id = ? ORDER BY issued_at", marketId)) {
        const key = `${r.outcome}:${r.evidence_digest}`;
        groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups.values()]
        .map((g) => ({ g, signers: new Set(g.map((r) => r.signer)).size }))
        .filter(({ signers }) => signers >= terms.oracleThreshold)
        .map(({ g, signers }) => ({
            outcome: g[0]!.outcome, evidence: g[0]!.evidence_digest, signers,
            signatures: slotSignatures(terms, g.map((r) => ({ signer: r.signer, signature: hex.decode(r.signature) }))),
        }));
}

/** Verifies a certificate against the market's attestor slots and binding, stores it and updates the status. */
export function acceptCertificate(d: Deps, marketId: string, terms: VaultTerms, cert: CertificateJson, evidence?: unknown): { quorum: boolean } {
    if (!(cert.outcome in BINARY_VECTORS)) throw new HttpError(400, "outcome", "outcome must be yes, no or invalid");
    const vector = BINARY_VECTORS[cert.outcome as BinaryOutcome];
    if (cert.denominator !== vector.denominator.toString() || cert.numerators.join(",") !== vector.numerators.join(",")) {
        throw new HttpError(400, "vector", "payout vector does not match the outcome");
    }
    if (!/^[0-9a-f]{64}$/.test(cert.evidenceDigest) || !/^[0-9a-f]{128}$/.test(cert.signature)) throw new HttpError(400, "encoding", "bad digest or signature encoding");
    const key = terms.oracleKeys.find((k) => hex.encode(k) === cert.signer);
    if (!key) throw new HttpError(400, "signer", "signer is not one of this market's attestor keys");
    const message = attestationMessage(terms.binding, hex.decode(cert.evidenceDigest), vector);
    if (!verifyAttestation(hex.decode(cert.signature), key, message)) throw new HttpError(400, "signature", "certificate signature does not verify");
    run(d.db, "INSERT OR IGNORE INTO certificates(market_id, outcome, numerators, denominator, evidence_digest, evidence, signature, signer, source_block, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        marketId, cert.outcome, JSON.stringify(cert.numerators), cert.denominator, cert.evidenceDigest, evidence === undefined ? null : JSON.stringify(evidence),
        cert.signature, cert.signer, cert.sourceBlock ? JSON.stringify(cert.sourceBlock) : null, now());

    const outcomes = all<{ outcome: string; n: number }>(d.db, "SELECT outcome, COUNT(DISTINCT signer) n FROM certificates WHERE market_id = ? GROUP BY outcome", marketId);
    const reached = quorums(d.db, marketId, terms)[0];
    const [status, detail] = outcomes.length > 1
        ? ["conflicting-certificates", "attestors signed more than one outcome; the first resolution submitted wins on-contract"]
        : reached
            ? ["certified", `certified ${reached.outcome} by ${reached.signers} of ${terms.oracleThreshold} required attestors`]
            : ["attesting", `${outcomes[0]?.n ?? 0} of ${terms.oracleThreshold} required attestations for ${cert.outcome}`];
    run(d.db, "UPDATE markets SET resolution_status = ?, resolution_detail = ?, updated_at = ? WHERE id = ? AND resolution_status != 'resolved'", status, detail, now(), marketId);
    d.bus.publish("resolution", marketId, { outcome: cert.outcome, signer: cert.signer, status });
    return { quorum: !!reached };
}
