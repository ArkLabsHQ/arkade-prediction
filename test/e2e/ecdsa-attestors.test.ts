import { describe, expect, it } from "vitest";
import { hex } from "@scure/base";
import { issueMarketAssets, openVault, resolveMarket, walletParty, type Ctx } from "../../src/core/actions.js";
import { attestationMessage, attestorPublicKey, evidenceDigest, signAttestation, type AttestorScheme } from "../../src/core/attestation.js";
import { bindingOf, type MarketDefinition } from "../../src/core/definition.js";
import { marketContracts, oracleSlots, slotSignatures, templateFor, TEMPLATE, type VaultTerms } from "../../src/core/market.js";
import { BINARY_VECTORS } from "../../src/core/payout.js";
import { connectArkade, expectCovenantRejection, faucet, indexerProvider, newWallet, spendableAt, waitFor } from "./env.js";
import { network } from "./market.js";

describe("ECDSA attestors", () => {
    it("resolves a vault whose 2-of-3 set mixes Schnorr, ECDSA/secp256k1 and ECDSA/P-256", { timeout: 600_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const w = await newWallet();
        await faucet(await w.wallet.getAddress(), 20_000);
        await waitFor(async () => (await w.wallet.getBalance()).available >= 20_000, { what: "funded" });
        const creator = await walletParty(w.wallet, w.identity);

        const schemes: AttestorScheme[] = ["schnorr", "ecdsa-secp256k1", "ecdsa-p256"];
        const secrets = schemes.map(() => crypto.getRandomValues(new Uint8Array(32)));
        const keys = schemes.map((s, i) => attestorPublicKey(s, secrets[i]!));
        const marketId = hex.encode(crypto.getRandomValues(new Uint8Array(16)));
        const closeAt = BigInt(Math.floor(Date.now() / 1000) - 120);
        const definition: MarketDefinition = {
            question: "ECDSA attestors?", rules: "Resolved by a mixed attestor set.", outcomes: ["YES", "NO"], category: "test",
            closeAtUnix: String(closeAt), timeoutAtUnix: String(closeAt + 86_400n), source: null,
        };
        const { assets } = await issueMarketAssets(ctx, creator, marketId, 1n);
        await waitFor(async () => (await creator.coins()).some((c) => c.assets?.some((a) => a.assetId === assets.ctrl)), { what: "genesis" });
        const slots = oracleSlots(keys, 2);
        const terms: VaultTerms = {
            assets, unitSats: 1000n, capSats: 101_000n, oracleKeys: slots, oracleThreshold: 2,
            binding: bindingOf({ network: "regtest", arkSigner: ark.serverKey, emulatorSigner: ark.emulatorKey!, marketId, definition, unitSats: 1000n, assets, oracleKeys: slots.map((k) => hex.encode(k)), oracleThreshold: 2, oracleEpoch: 1 }),
            closeAt, timeoutAt: closeAt + 86_400n, exitDelaySeconds: 512n,
        };
        expect(templateFor(slots).marketVault).not.toBe(TEMPLATE.marketVault);
        const { vault, resolved } = marketContracts(ark, terms);
        await openVault(ctx, creator, terms, 1n, 1000n);
        await waitFor(async () => (await spendableAt(vault.pkScript)).length > 0, { what: "vault" });

        const evidence = evidenceDigest({ drill: "ecdsa", outcome: "YES" });
        const message = attestationMessage(terms.binding, evidence, BINARY_VECTORS.yes);
        const signed = (i: number) => ({ signer: hex.encode(keys[i]!), signature: signAttestation(secrets[i]!, message, schemes[i]!) });
        await expectCovenantRejection(resolveMarket(ctx, terms, "yes", evidence, slotSignatures(terms, [signed(2)])), "one ECDSA signature below a 2-of-3 quorum");
        const { txid } = await resolveMarket(ctx, terms, "yes", evidence, slotSignatures(terms, [signed(1), signed(2)]));
        await waitFor(async () => (await spendableAt(resolved.yes.pkScript)).length > 0, { what: "resolved vault" });
        console.log(`ECDSA attestors resolved ${marketId} in ${txid}`);
        expect(txid).toMatch(/^[0-9a-f]{64}$/);
    });
});
