import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { hex } from "@scure/base";
import { attestationMessage, evidenceDigest, signAttestation } from "../../../src/core/attestation.js";
import { oracleSlots, slotSignatures } from "../../../src/core/market.js";
import { BINARY_VECTORS } from "../../../src/core/payout.js";
import type { CertificateJson } from "../../../src/shared/api.js";
import { acceptCertificate, quorums } from "../../../src/server/certificates.js";
import { evidenceRecord } from "../../../src/server/sources/polymarket/index.js";
import type { ResolutionEvidence, SourceMarket } from "../../../src/server/sources/types.js";
import { one, run } from "../../../src/server/db.js";
import { harness, inner, insertMarket, marketTermsJson } from "./harness.js";

const attestor = () => {
    const secret = randomBytes(32);
    return { secret, key: schnorr.getPublicKey(secret) };
};

describe("attestor slots", () => {
    const [a, b, c] = [attestor().key, attestor().key, attestor().key];

    it("pads a single attestor and accepts any threshold-1 set", () => {
        expect(oracleSlots([a!], 1).map((k) => hex.encode(k))).toEqual([a, a, a].map((k) => hex.encode(k!)));
        expect(oracleSlots([a!, b!], 1)).toHaveLength(3);
    });

    it("needs three distinct keys above threshold 1, because the vault counts slots", () => {
        expect(oracleSlots([a!, b!, c!], 2)).toHaveLength(3);
        expect(oracleSlots([a!, b!, c!], 3)).toHaveLength(3);
        expect(() => oracleSlots([a!, b!, b!], 2)).toThrow(/distinct/);
        expect(() => oracleSlots([a!, b!], 2)).toThrow(/distinct/);
        expect(() => oracleSlots([a!, b!, c!], 4)).toThrow(/threshold/);
        expect(() => oracleSlots([a!, b!, c!], 0)).toThrow(/threshold/);
        expect(() => oracleSlots([a!, b!, c!, a!], 1)).toThrow(/1 to 3/);
    });

    it("puts each signature in its signer's slot once, even when the key repeats", () => {
        const sigA = randomBytes(64);
        const sigC = randomBytes(64);
        const distinct = slotSignatures({ oracleKeys: [a!, b!, c!] }, [{ signer: hex.encode(c!), signature: sigC }, { signer: hex.encode(a!), signature: sigA }]);
        expect(distinct.map((s) => s.length)).toEqual([64, 0, 64]);
        expect(hex.encode(distinct[2]!)).toBe(hex.encode(sigC));
        const repeated = slotSignatures({ oracleKeys: [a!, a!, a!] }, [{ signer: hex.encode(a!), signature: sigA }]);
        expect(repeated.map((s) => s.length)).toEqual([64, 0, 0]);
    });
});

describe("certificate quorum", () => {
    const attestors = [attestor(), attestor(), attestor()];
    const setup = () => {
        const h = harness();
        const keys = attestors.map((x) => hex.encode(x.key));
        insertMarket(h.db, { id: "m1", closeAt: Math.floor(Date.now() / 1000) - 10, terms: { ...marketTermsJson({ closeAt: 1, timeoutAt: 2 }), oracleKeys: keys, oracleThreshold: 2 } });
        run(h.db, "UPDATE markets SET oracle_keys = ?, oracle_threshold = 2 WHERE id = 'm1'", JSON.stringify(keys));
        const row = one<{ terms: string }>(h.db, "SELECT terms FROM markets WHERE id = 'm1'")!;
        const terms = { ...JSON.parse(row.terms), oracleKeys: attestors.map((x) => x.key), oracleThreshold: 2, binding: hex.decode(JSON.parse(row.terms).binding) };
        return { h, terms };
    };
    const certBy = (i: number, binding: Uint8Array, evidence: Uint8Array, outcome: "yes" | "no" = "yes"): CertificateJson => {
        const v = BINARY_VECTORS[outcome];
        return {
            outcome, numerators: v.numerators.map(String), denominator: v.denominator.toString(), evidenceDigest: hex.encode(evidence),
            signature: hex.encode(signAttestation(attestors[i]!.secret, attestationMessage(binding, evidence, v))),
            signer: hex.encode(attestors[i]!.key), sourceBlock: null, issuedAt: new Date().toISOString(),
        };
    };

    it("certifies only when enough distinct attestors signed the same outcome and evidence", () => {
        const { h, terms } = setup();
        const evidence = evidenceDigest({ block: 1 });
        expect(acceptCertificate(h.deps, "m1", terms, certBy(0, terms.binding, evidence)).quorum).toBe(false);
        expect(one(h.db, "SELECT resolution_status s FROM markets WHERE id = 'm1'")).toEqual({ s: "attesting" });
        // The same attestor again, or a second one over different evidence, does not complete the quorum.
        acceptCertificate(h.deps, "m1", terms, certBy(0, terms.binding, evidence));
        expect(acceptCertificate(h.deps, "m1", terms, certBy(1, terms.binding, evidenceDigest({ block: 2 }))).quorum).toBe(false);
        expect(acceptCertificate(h.deps, "m1", terms, certBy(2, terms.binding, evidence)).quorum).toBe(true);
        expect(one(h.db, "SELECT resolution_status s FROM markets WHERE id = 'm1'")).toEqual({ s: "certified" });
        const [q] = quorums(h.db, "m1", terms);
        expect(q).toMatchObject({ outcome: "yes", evidence: hex.encode(evidence), signers: 2 });
        expect(q!.signatures.map((s) => s.length)).toEqual([64, 0, 64]);
    });

    it("refuses signers outside the attestor set and signatures over another binding", () => {
        const { h, terms } = setup();
        const outsider = attestor();
        const evidence = evidenceDigest({ block: 1 });
        const v = BINARY_VECTORS.yes;
        const foreign = { ...certBy(0, terms.binding, evidence), signer: hex.encode(outsider.key), signature: hex.encode(signAttestation(outsider.secret, attestationMessage(terms.binding, evidence, v))) };
        expect(() => acceptCertificate(h.deps, "m1", terms, foreign)).toThrow(/attestor keys/);
        expect(() => acceptCertificate(h.deps, "m1", terms, certBy(0, randomBytes(32), evidence))).toThrow(/does not verify/);
    });

    it("plans the resolution at quorum and the timeout only without one", async () => {
        const { h, terms } = setup();
        const evidence = evidenceDigest({ block: 1 });
        acceptCertificate(h.deps, "m1", terms, certBy(0, terms.binding, evidence));
        await inner(h.keeper).plan();
        expect(h.wf.list({ state: "pending" }).map((w) => w.kind)).not.toContain("resolve");

        run(h.db, "UPDATE markets SET timeout_at = ? WHERE id = 'm1'", Math.floor(Date.now() / 1000) - 1);
        await inner(h.keeper).plan();
        expect(h.wf.list({ state: "pending" }).map((w) => w.kind)).toContain("timeout");

        const { h: h2, terms: t2 } = setup();
        acceptCertificate(h2.deps, "m1", t2, certBy(1, t2.binding, evidence));
        acceptCertificate(h2.deps, "m1", t2, certBy(2, t2.binding, evidence));
        await inner(h2.keeper).plan();
        expect(h2.wf.list({ state: "pending" }).map((w) => [w.kind, w.payload.outcome])).toEqual([["resolve", "yes"]]);
    });
});

describe("attestation evidence", () => {
    it("is the same for attestors that read one block through different providers", () => {
        const market = {
            sourceId: "1", protocol: { conditionId: `0x${"11".repeat(32)}`, questionId: `0x${"22".repeat(32)}`, resolver: "0xabc" },
        } as unknown as SourceMarket;
        const read = (providers: string[], observedAt: string): ResolutionEvidence => ({
            status: "final", detail: `read via ${providers.join(",")}`, observedAt,
            vector: { numerators: [0n, 1n], denominator: 1n },
            chain: { chainId: 137, blockNumber: "95000000", blockHash: `0x${"33".repeat(32)}`, providers },
            reads: { providers, observedAt },
        });
        const one = evidenceDigest(evidenceRecord(market, read(["rpc-a#1", "rpc-b#2"], "2026-10-08T00:00:00Z")));
        const two = evidenceDigest(evidenceRecord(market, read(["rpc-c#1", "rpc-d#2"], "2026-10-08T00:05:00Z")));
        expect(hex.encode(one)).toBe(hex.encode(two));
    });
});
