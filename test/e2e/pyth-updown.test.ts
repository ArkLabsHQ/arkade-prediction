import { describe, expect, it } from "vitest";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { hex } from "@scure/base";
import { contractCoin, execute, issueMarketAssets, openVault, resolvePythMarket, walletParty, type Ctx } from "../../src/core/actions.js";
import { marketContracts, type VaultTerms } from "../../src/core/market.js";
import { evmUpdate, parseEvmUpdate, updateSignerKey } from "../../src/core/pyth.js";
import { connectArkade, expectCovenantRejection, faucet, indexerProvider, newWallet, spendableAt, waitFor } from "./env.js";
import { network } from "./market.js";

// A local key stands in for Pyth's signer: the bytes are the documented evm format, the key is not Pyth's.
describe("Pyth Pro Up/Down vault (documented format, local signer)", () => {
    it("settles Up on two signed updates and refuses Down, another timestamp and another signer", { timeout: 600_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const w = await newWallet();
        await faucet(await w.wallet.getAddress(), 30_000);
        await waitFor(async () => (await w.wallet.getBalance()).available >= 30_000, { what: "funded" });
        const party = await walletParty(w.wallet, w.identity);

        const pyth = secp256k1.utils.randomSecretKey();
        const FEED = 1398;
        const T0 = 1791600000000000n;
        const T1 = T0 + 86_400_000_000n;
        const start = parseEvmUpdate(evmUpdate(pyth, FEED, T0, 24_500_000_000n));
        const end = parseEvmUpdate(evmUpdate(pyth, FEED, T1, 24_600_000_000n));
        const { assets } = await issueMarketAssets(ctx, party, hex.encode(crypto.getRandomValues(new Uint8Array(16))), 1n);
        await waitFor(async () => (await party.coins()).some((c) => c.assets?.some((a) => a.assetId === assets.ctrl)), { what: "genesis" });
        const closeAt = BigInt(Math.floor(Date.now() / 1000) - 60);
        const terms: VaultTerms = {
            assets, unitSats: 1000n, capSats: 101_000n, oracleKeys: [], oracleThreshold: 1, binding: new Uint8Array(32),
            closeAt, timeoutAt: closeAt + 86_400n, exitDelaySeconds: 512n,
            pyth: { feedId: FEED, signer: updateSignerKey(evmUpdate(pyth, FEED, T0, 1n)), startTsUs: T0, endTsUs: T1 },
        };
        const { vault, resolved } = marketContracts(ark, terms);
        await openVault(ctx, party, terms, 1n, 1000n);
        await waitFor(async () => (await spendableAt(vault.pkScript)).length > 0, { what: "vault" });

        const attempt = async (fn: string, e: typeof end, s: typeof start, to: Uint8Array) => {
            const coin = (await contractCoin(ctx, vault, assets.ctrl))!;
            return execute(ctx, [{ kind: "covenant", coin, contract: vault, fn, args: { endPayload: e.payload, endSig: e.signature, startPayload: s.payload, startSig: s.signature } }],
                [{ script: to, amount: BigInt(coin.value), assets: [{ assetId: assets.ctrl, amount: 1n }] }]);
        };
        await expectCovenantRejection(attempt("resolveNo", end, start, resolved.no.pkScript), "Down while the price rose");
        const early = parseEvmUpdate(evmUpdate(pyth, FEED, T1 - 1_000_000n, 24_600_000_000n));
        await expectCovenantRejection(attempt("resolveYes", early, start, resolved.yes.pkScript), "an end update one second off");
        const forged = parseEvmUpdate(evmUpdate(secp256k1.utils.randomSecretKey(), FEED, T1, 24_900_000_000n));
        await expectCovenantRejection(attempt("resolveYes", forged, start, resolved.yes.pkScript), "an update from another signer");

        const { txid, outcome } = await resolvePythMarket(ctx, terms, end, start);
        expect(outcome).toBe("yes");
        await waitFor(async () => (await spendableAt(resolved.yes.pkScript)).length > 0, { what: "resolved vault" });
        console.log(`Pyth-format Up/Down settled Up in ${txid}`);
    });
});
