import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { hex } from "@scure/base";
import { buildArkadeTx, signInputs, submitArkadeTx, type InputSpec, type OutputSpec } from "../../src/core/arkadeTx.js";
import { attestationMessage, bindingHash, evidenceDigest, signAttestation } from "../../src/core/attestation.js";
import { TEMPLATE, marketContracts, type VaultTerms } from "../../src/core/market.js";
import { BINARY_VECTORS, redemptionPayout } from "../../src/core/payout.js";
import { connectArkade, expectCovenantRejection, faucet, newWallet, waitFor } from "./env.js";
import { assetBalance, coinAt, issueGenesis, network, scriptOf, sumValue, walletInputs, type TestWallet } from "./market.js";

const UNIT = 1000n;
const BASE = 1000n;
const CARRIER = 330n;

describe("market vault lifecycle", () => {
    it("issues, mints, merges, resolves and redeems with exact accounting", { timeout: 600_000 }, async () => {
        const ark = await connectArkade();
        const net = network(ark);
        const creator = await newWallet();
        const alice = await newWallet();
        faucet(await creator.wallet.getAddress(), 50_000);
        faucet(await alice.wallet.getAddress(), 100_000);
        await waitFor(async () => (await creator.wallet.getBalance()).available >= 50_000, { what: "creator funds" });
        await waitFor(async () => (await alice.wallet.getBalance()).available >= 100_000, { what: "alice funds" });

        const send = async (inputs: InputSpec[], outputs: OutputSpec[], signer?: TestWallet) => {
            const built = await buildArkadeTx(net, inputs, outputs);
            if (signer) await signInputs(built, signer.identity, built.signerInputs);
            return submitArkadeTx(net, built, signer ? (cp) => signer.identity.sign(cp, [0]) : undefined);
        };

        // Genesis: CTRL + 1 YES + 1 NO, then CTRL locked in the vault next to 1 set of collateral.
        const marketId = `test-${hex.encode(randomBytes(4))}`;
        const assets = await issueGenesis(creator, marketId, 1n);
        const oracleSecret = randomBytes(32);
        const oracleKey = schnorr.getPublicKey(oracleSecret);
        const nowS = BigInt(Math.floor(Date.now() / 1000));
        const binding = bindingHash({
            schema: 1,
            deployment: { network: "regtest", arkSigner: hex.encode(ark.serverKey), emulatorSigner: hex.encode(ark.emulatorKey!) },
            template: TEMPLATE,
            marketId,
            definitionHash: "00".repeat(32),
            collateral: { kind: "BTC", unitSats: UNIT },
            claims: { ctrl: assets.ctrl, outcomes: [assets.yes, assets.no] },
            outcomeLabels: ["YES", "NO"],
            source: null,
            oracle: { keys: [hex.encode(oracleKey)], threshold: 1, epoch: 1 },
            timing: { closeAt: nowS - 60n, timeoutAt: 0n },
        });
        const terms: VaultTerms = {
            assets, unitSats: UNIT, capSats: BASE + 50n * UNIT, oracleKey, binding, closeAt: nowS - 60n, timeoutAt: 0n,
        };
        const { vault, resolved } = marketContracts(ark, terms);
        const creatorScript = await scriptOf(creator);
        const aliceScript = await scriptOf(alice);

        const creatorIn = await walletInputs(creator);
        const createVault = await send(creatorIn, [
            { script: vault.pkScript, amount: BASE + UNIT, assets: [{ assetId: assets.ctrl, amount: 1n }] },
            { script: creatorScript, amount: CARRIER, assets: [{ assetId: assets.yes, amount: 1n }, { assetId: assets.no, amount: 1n }] },
            { script: creatorScript, amount: sumValue(creatorIn) - BASE - UNIT - CARRIER },
        ], creator);
        let vaultCoin = await coinAt(vault.pkScript, "vault", createVault.txid);
        expect(BigInt(vaultCoin.value)).toBe(BASE + UNIT);
        console.log(`genesis=${assets.txid} vault=${createVault.txid}`);

        // Mint 10 sets.
        const mint = (n: bigint, tweak: Partial<{ vaultValue: bigint; noAmount: bigint; ctrlTo: "alice" }> = {}) =>
            walletInputs(alice, (c) => !c.assets?.length).then((aliceIn) => {
                const inputs: InputSpec[] = [{ kind: "covenant", coin: vaultCoin, contract: vault, fn: "mint", args: { n } }, ...aliceIn];
                const vaultValue = tweak.vaultValue ?? BigInt(vaultCoin.value) + n * UNIT;
                const aliceAssets = [{ assetId: assets.yes, amount: n }, { assetId: assets.no, amount: tweak.noAmount ?? n }];
                if (tweak.ctrlTo) aliceAssets.push({ assetId: assets.ctrl, amount: 1n });
                return send(inputs, [
                    { script: vault.pkScript, amount: vaultValue, assets: tweak.ctrlTo ? [] : [{ assetId: assets.ctrl, amount: 1n }] },
                    { script: aliceScript, amount: CARRIER, assets: aliceAssets },
                    { script: aliceScript, amount: BigInt(vaultCoin.value) + sumValue(aliceIn) - vaultValue - CARRIER },
                ], alice);
            });
        await expectCovenantRejection(mint(10n, { vaultValue: BigInt(vaultCoin.value) + 10n * UNIT - 1n }), "short collateral");
        await expectCovenantRejection(mint(10n, { noAmount: 9n }), "unbalanced set");
        await expectCovenantRejection(mint(10n, { ctrlTo: "alice" }), "control asset stolen");
        await expectCovenantRejection(mint(60n), "open-interest cap");
        const minted = await mint(10n);
        await waitFor(async () => (await assetBalance(alice, assets.yes)) === 10n, { what: "minted claims" });
        vaultCoin = await coinAt(vault.pkScript, "vault after mint", minted.txid);
        expect(BigInt(vaultCoin.value)).toBe(BASE + 11n * UNIT);

        // Merge 3 sets back into collateral.
        const aliceClaims = await walletInputs(alice, (c) => !!c.assets?.length);
        const merge = (n: bigint, released: bigint) =>
            send([{ kind: "covenant", coin: vaultCoin, contract: vault, fn: "merge", args: { n } }, ...aliceClaims], [
                { script: vault.pkScript, amount: BigInt(vaultCoin.value) - released, assets: [{ assetId: assets.ctrl, amount: 1n }] },
                { script: aliceScript, amount: CARRIER + released, assets: [{ assetId: assets.yes, amount: 10n - n }, { assetId: assets.no, amount: 10n - n }] },
            ], alice);
        await expectCovenantRejection(merge(3n, 3n * UNIT + 1n), "merge over-release");
        const merged = await merge(3n, 3n * UNIT);
        vaultCoin = await coinAt(vault.pkScript, "vault after merge", merged.txid);
        expect(BigInt(vaultCoin.value)).toBe(BASE + 8n * UNIT);

        // Resolve YES with a bound attestation.
        const evidence = evidenceDigest({ fixture: "regtest-dev-oracle", outcome: "YES" });
        const sigFor = (outcome: keyof typeof BINARY_VECTORS, key = oracleSecret) =>
            signAttestation(key, attestationMessage(binding, evidence, BINARY_VECTORS[outcome]));
        const resolve = (fn: string, sig: Uint8Array, target = resolved.yes) =>
            send([{ kind: "covenant", coin: vaultCoin, contract: vault, fn, args: { evidence, oracleSig: sig } }], [
                { script: target.pkScript, amount: BigInt(vaultCoin.value), assets: [{ assetId: assets.ctrl, amount: 1n }] },
            ]);
        await expectCovenantRejection(resolve("resolveYes", sigFor("no")), "NO attestation used for YES");
        await expectCovenantRejection(resolve("resolveYes", sigFor("yes", randomBytes(32))), "unauthorized oracle key");
        await expectCovenantRejection(resolve("resolveYes", sigFor("yes"), resolved.no), "YES attestation to NO vault");
        const resolvedTx = await resolve("resolveYes", sigFor("yes"));
        let resolvedCoin = await coinAt(resolved.yes.pkScript, "resolved vault", resolvedTx.txid);
        expect(BigInt(resolvedCoin.value)).toBe(BASE + 8n * UNIT);

        // Redeem: alice burns 7 YES + 7 NO; YES pays UNIT each.
        const aliceClaims2 = await walletInputs(alice, (c) => !!c.assets?.length);
        const redeem = (yesBurn: bigint, noBurn: bigint, payout: bigint) =>
            send([{ kind: "covenant", coin: resolvedCoin, contract: resolved.yes, fn: "redeem", args: { yesBurn, noBurn } }, ...aliceClaims2], [
                { script: resolved.yes.pkScript, amount: BigInt(resolvedCoin.value) - payout, assets: [{ assetId: assets.ctrl, amount: 1n }] },
                {
                    script: aliceScript,
                    amount: sumValue(aliceClaims2) + payout,
                    assets: [
                        ...(7n - yesBurn > 0n ? [{ assetId: assets.yes, amount: 7n - yesBurn }] : []),
                        ...(7n - noBurn > 0n ? [{ assetId: assets.no, amount: 7n - noBurn }] : []),
                    ],
                },
            ], alice);
        const payout = redemptionPayout([7n, 7n], BINARY_VECTORS.yes, UNIT);
        expect(payout).toBe(7000n);
        await expectCovenantRejection(redeem(7n, 7n, payout + 1n), "over-redeem");
        await expectCovenantRejection(redeem(6n, 7n, payout), "redeem without burning");
        const redeemed = await redeem(7n, 7n, payout);
        resolvedCoin = await coinAt(resolved.yes.pkScript, "vault after redeem", redeemed.txid);
        expect(BigInt(resolvedCoin.value)).toBe(BASE + 1n * UNIT);
        expect(await assetBalance(alice, assets.yes)).toBe(0n);
        console.log(`mint=${minted.txid} merge=${merged.txid} resolve=${resolvedTx.txid} redeem=${redeemed.txid}`);
    });
});
