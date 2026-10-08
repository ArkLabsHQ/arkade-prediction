import { afterAll, describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { execute, resolveMarket, type Ctx } from "../../src/core/actions.js";
import { assetScriptArgs } from "../../src/core/assets.js";
import { attestationMessage, evidenceDigest, signAttestation } from "../../src/core/attestation.js";
import { NUMS_KEY, PROGRAMS, resolvedVault, type ArkadeClient, type VaultTerms } from "../../src/core/market.js";
import { BINARY_VECTORS } from "../../src/core/payout.js";
import type { CertificateJson, MarketJson } from "../../src/shared/api.js";
import { connectArkade, expectCovenantRejection, faucet, indexerProvider, newWallet, waitFor } from "./env.js";
import { faucetTrader, registeredMarket } from "./flows.js";
import { coinAt, createMarket, network } from "./market.js";
import { startServer, type TestServer } from "./server.js";

describe("2-of-3 attestor quorum in the vault covenant", () => {
    it("refuses one attestor, one attestor in two slots and a quorum over another outcome; resolves with two", { timeout: 600_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const creator = await newWallet();
        await faucet(await creator.wallet.getAddress(), 30_000);
        await waitFor(async () => (await creator.wallet.getBalance()).available >= 30_000, { what: "creator funds" });
        const m = await createMarket(ark, creator, { attestors: 3, threshold: 2 });

        const evidence = evidenceDigest({ drill: "threshold", block: 1 });
        const sign = (i: number, outcome: "yes" | "no") => signAttestation(m.oracleSecrets[i]!, attestationMessage(m.binding, evidence, BINARY_VECTORS[outcome]));
        const empty = new Uint8Array(0);
        await expectCovenantRejection(resolveMarket(ctx, m.terms, "yes", evidence, [sign(0, "yes"), empty, empty]), "one of three attestors");
        await expectCovenantRejection(resolveMarket(ctx, m.terms, "yes", evidence, [sign(0, "yes"), sign(0, "yes"), empty]), "one attestor in two slots");
        await expectCovenantRejection(resolveMarket(ctx, m.terms, "no", evidence, [sign(0, "yes"), empty, sign(2, "yes")]), "quorum over another outcome");

        const { txid } = await resolveMarket(ctx, m.terms, "yes", evidence, [sign(0, "yes"), empty, sign(2, "yes")]);
        await coinAt(m.resolved.yes.pkScript, "vault resolved YES by attestors 1 and 3", txid);
        console.log(`2-of-3 resolution ${txid}`);
    });
});

/** The vault arguments of marketContracts, minus its attestor-set validation. */
function uncheckedContracts(ark: ArkadeClient, terms: VaultTerms) {
    const resolved = { yes: resolvedVault(ark, terms, "yes"), no: resolvedVault(ark, terms, "no"), invalid: resolvedVault(ark, terms, "invalid") };
    const [ctrl, yes, no] = [terms.assets.ctrl, terms.assets.yes, terms.assets.no].map(assetScriptArgs);
    const vault = ark.contract(PROGRAMS.marketVault, {
        ctrlTxid: ctrl!.txid, ctrlGidx: ctrl!.gidx, yesTxid: yes!.txid, yesGidx: yes!.gidx, noTxid: no!.txid, noGidx: no!.gidx,
        unit: terms.unitSats, capValue: terms.capSats,
        "oracles.0": terms.oracleKeys[0]!, "oracles.1": terms.oracleKeys[1]!, "oracles.2": terms.oracleKeys[2]!, threshold: BigInt(terms.oracleThreshold),
        binding: terms.binding, closeAt: terms.closeAt, timeoutAt: terms.timeoutAt,
        resolvedYes: resolved.yes.pkScript.slice(2), resolvedNo: resolved.no.pkScript.slice(2), resolvedInvalid: resolved.invalid.pkScript.slice(2),
        noExitKey: NUMS_KEY, exit: terms.exitDelaySeconds,
    });
    return { vault, resolved };
}

describe("repeated attestor keys above threshold 1", () => {
    it("are refused by the vault, so one attestor cannot fill two slots of a forged set", { timeout: 600_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const creator = await newWallet();
        await faucet(await creator.wallet.getAddress(), 30_000);
        await waitFor(async () => (await creator.wallet.getBalance()).available >= 30_000, { what: "creator funds" });
        // Slots [A, B, B] with threshold 2: without the attestor-set rule, B alone would count twice.
        const m = await createMarket(ark, creator, { attestors: 2, threshold: 2, unchecked: { slots: [0, 1, 1], contracts: uncheckedContracts } });
        const evidence = evidenceDigest({ drill: "repeated keys" });
        const sigB = signAttestation(m.oracleSecrets[1]!, attestationMessage(m.binding, evidence, BINARY_VECTORS.yes));
        await expectCovenantRejection(execute(ctx, [{ kind: "covenant", coin: m.vaultCoin, contract: m.vault, fn: "resolveYes",
            args: { evidence, "oracleSigs.0": new Uint8Array(0), "oracleSigs.1": sigB, "oracleSigs.2": sigB } }], [
            { script: m.resolved.yes.pkScript, amount: BigInt(m.vaultCoin.value), assets: [{ assetId: m.assets.ctrl, amount: 1n }] },
        ]), "one attestor in two slots of a repeated-key set");
    });
});

const servers: TestServer[] = [];
afterAll(async () => {
    for (const s of servers) await s.stop();
});

describe("server aggregation of a 2-of-3 attestor quorum", () => {
    it("certifies only at quorum, and the keeper resolves with the aggregated signatures", { timeout: 900_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const s = await startServer({ port: 37413 });
        servers.push(s);
        const ov = await s.api<{ wallets: { operator: { address: string } } }>("/api/admin/overview", { admin: true });
        await faucet(ov.body.wallets.operator.address, 100_000);
        const alice = await faucetTrader(s, 40_000);
        const m = await registeredMarket(s, ctx, alice, 120, { attestors: 3, threshold: 2 });
        const market = async () => (await s.api<MarketJson>(`/api/markets/${m.marketId}`)).body;
        await new Promise((r) => setTimeout(r, Math.max(0, Number(m.terms.closeAt) * 1000 - Date.now() + 2000)));

        const evidence = evidenceDigest({ drill: "server quorum" });
        const post = (i: number) => s.api<{ quorum: boolean }>(`/api/markets/${m.marketId}/certificates`, {
            method: "POST",
            body: JSON.stringify({
                outcome: "yes", numerators: ["1", "0"], denominator: "1", evidenceDigest: hex.encode(evidence),
                signature: hex.encode(signAttestation(m.oracleSecrets[i]!, attestationMessage(m.terms.binding, evidence, BINARY_VECTORS.yes))),
                signer: hex.encode(schnorr.getPublicKey(m.oracleSecrets[i]!)), sourceBlock: null, issuedAt: new Date().toISOString(),
            } satisfies CertificateJson),
        });
        expect((await post(1)).body.quorum).toBe(false);
        expect((await market()).resolution.status).toBe("attesting");
        await new Promise((r) => setTimeout(r, 10_000));
        expect((await market()).vault.phase).toBe("open");

        expect((await post(2)).body.quorum).toBe(true);
        const done = await waitFor(async () => {
            const body = await market();
            return body.vault.phase === "resolved" && body;
        }, { what: "keeper resolution at quorum", timeoutMs: 180_000, intervalMs: 3000 });
        expect(done.vault.outcome).toBe("yes");
    });
});
