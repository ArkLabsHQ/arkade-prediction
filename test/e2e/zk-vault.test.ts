import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bn254 } from "@noble/curves/bn254.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { buildArkadeTx, submitArkadeTx } from "../../src/core/arkadeTx.js";
import { marketContracts, type ArkadeClient, type VaultTerms } from "../../src/core/market.js";
import { loadProgram, type ContractArtifact } from "../../src/core/programs.js";
import { connectArkade, expectCovenantRejection, faucet, newWallet, waitFor } from "./env.js";
import { coinAt, createMarket, network } from "./market.js";

// Spike S5: market_vault plus proof-resolved leaves (test/fixtures/zk/zk_market_vault.ark). Our CTF payout proof's
// public values are blockHash ‖ conditionId ‖ 1 ‖ 1 ‖ 0, so with zkAnchor = blockHash it proves YES.
const fixture = (name: string) => readFileSync(new URL(`../fixtures/zk/${name}`, import.meta.url), "utf8");
const sol = fixture("Groth16Verifier.v6.1.0.sol");
const K = (name: string) => BigInt(new RegExp(`uint256 constant ${name} = ([0-9]+);`).exec(sol)![1]!);
const proof = JSON.parse(fixture("ctf-payout-groth16.json")) as { proof: string; publicValues: string; vkey: string };
const ZK_VAULT = loadProgram(JSON.parse(fixture("zk_market_vault.json")) as ContractArtifact);

const bytes = (h: string) => hex.decode(h.replace(/^0x/, ""));
const pb = bytes(proof.proof);
const words = Array.from({ length: 11 }, (_, i) => BigInt(`0x${hex.encode(pb.slice(4 + i * 32, 36 + i * 32))}`));
const [, vkRoot, nonce, ...p] = words as [bigint, bigint, bigint, ...bigint[]];
const pv = bytes(proof.publicValues);
const pub = (i: number) => bn254.G1.Point.fromAffine({ x: K(`PUB_${i}_X`), y: K(`PUB_${i}_Y`) });
const point = (P: { toAffine(): { x: bigint; y: bigint } }, name: string) => ({ [`${name}.x`]: P.toAffine().x, [`${name}.y`]: P.toAffine().y });
const g2 = (name: string, x1: bigint, x0: bigint, y1: bigint, y0: bigint) => ({ [`${name}.xC1`]: x1, [`${name}.xC0`]: x0, [`${name}.yC1`]: y1, [`${name}.yC0`]: y0 });
const vkArgs = {
    "alpha.x": K("ALPHA_X"), "alpha.y": K("ALPHA_Y"),
    ...g2("betaNeg", K("BETA_NEG_X_1"), K("BETA_NEG_X_0"), K("BETA_NEG_Y_1"), K("BETA_NEG_Y_0")),
    ...g2("gammaNeg", K("GAMMA_NEG_X_1"), K("GAMMA_NEG_X_0"), K("GAMMA_NEG_Y_1"), K("GAMMA_NEG_Y_0")),
    ...g2("deltaNeg", K("DELTA_NEG_X_1"), K("DELTA_NEG_X_0"), K("DELTA_NEG_Y_1"), K("DELTA_NEG_Y_0")),
    ...point(bn254.G1.Point.fromAffine({ x: K("CONSTANT_X"), y: K("CONSTANT_Y") }).add(pub(0).multiplyUnsafe(BigInt(proof.vkey))).add(pub(3).multiplyUnsafe(vkRoot)), "base"),
    ...point(pub(1), "pub1"), ...point(pub(4), "pub4"),
};

const zkContracts = (conditionId: Uint8Array) => (ark: ArkadeClient, terms: VaultTerms) => {
    const { vault, resolved } = marketContracts(ark, terms);
    return { vault: ark.contract(ZK_VAULT, { ...vault.args, zkAnchor: pv.slice(0, 32), conditionId, ...vkArgs }), resolved };
};

function witness() {
    const h = sha256(pv);
    return {
        "a.x": p[0]!, "a.y": p[1]!, ...g2("b", p[2]!, p[3]!, p[4]!, p[5]!), "c.x": p[6]!, "c.y": p[7]!,
        nonce, publicValues: pv, digest: BigInt(`0x${hex.encode(h)}`) & ((1n << 253n) - 1n), hi: BigInt(h[0]! >> 5),
    };
}

describe("market vault resolved by an SP1 proof (spike S5)", () => {
    it("settles YES on the proof of the market's own condition and refuses the wrong side or another condition", { timeout: 900_000 }, async () => {
        const ark = await connectArkade();
        const creator = await newWallet();
        await faucet(await creator.wallet.getAddress(), 50_000);
        await waitFor(async () => (await creator.wallet.getBalance()).available >= 50_000, { what: "creator funds" });
        const resolve = (m: Awaited<ReturnType<typeof createMarket>>, fn: string, to: "yes" | "no") =>
            buildArkadeTx(network(ark), [{ kind: "covenant", coin: m.vaultCoin, contract: m.vault, fn, args: witness() }], [
                { script: m.resolved[to].pkScript, amount: BigInt(m.vaultCoin.value), assets: [{ assetId: m.assets.ctrl, amount: 1n }] },
            ]).then((built) => submitArkadeTx(network(ark), built));

        const other = await createMarket(ark, creator, { unchecked: { slots: [0, 0, 0], contracts: zkContracts(new Uint8Array(32).fill(7)) } });
        await expectCovenantRejection(resolve(other, "resolveZkYes", "yes"), "proof of a different condition");

        const m = await createMarket(ark, creator, { unchecked: { slots: [0, 0, 0], contracts: zkContracts(pv.slice(32, 64)) } });
        await expectCovenantRejection(resolve(m, "resolveZkNo", "no"), "NO on a proof of YES");
        const { txid } = await resolve(m, "resolveZkYes", "yes");
        const resolved = await coinAt(m.resolved.yes.pkScript, "resolved YES vault", txid);
        expect(resolved.assets).toEqual([{ assetId: m.assets.ctrl, amount: 1n }]);
        console.log(`ZK market vault resolved YES from the CTF payout proof: ${txid}`);
    });
});
