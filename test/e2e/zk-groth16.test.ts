import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bn254 } from "@noble/curves/bn254.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { execute, type Ctx } from "../../src/core/actions.js";
import { loadProgram, type ContractArtifact } from "../../src/core/programs.js";
import { connectArkade, expectCovenantRejection, faucet, indexerProvider, newWallet, waitFor } from "./env.js";
import { coinAt, network, scriptOf, walletSend } from "./market.js";

// Fixtures from succinctlabs/sp1-contracts (MIT): the v6.0.0 Groth16 verifying key and its test proof; the v6.1.0
// verifying key ships with SP1's circuit artifacts.
const fixture = (name: string) => readFileSync(new URL(`../fixtures/zk/${name}`, import.meta.url), "utf8");
const vk = (sol: string) => (name: string) => BigInt(new RegExp(`uint256 constant ${name} = (\\d+);`).exec(sol)![1]!);
const t = fixture("SP1VerifierGroth16V6.t.sol");
const succinct = {
    proof: /PROOF_BYTES =\s*hex"([0-9a-f]+)"/.exec(t)![1]!,
    publicValues: /PUBLIC_VALUES =\s*hex"([0-9a-f]+)"/.exec(t)![1]!,
    vkey: /PROGRAM_VKEY =\s*bytes32\((0x[0-9a-f]+)\)/.exec(t)![1]!,
    K: vk(fixture("Groth16Verifier.v6.0.0.sol")),
};
// Our zk/ctf-payout proof of the Buccaneers vs. Cowboys CTF payout, on circuit v6.1.0.
const ours = { ...(JSON.parse(fixture("ctf-payout-groth16.json")) as Omit<typeof succinct, "K">), K: vk(fixture("Groth16Verifier.v6.1.0.sol")) };

const point = (P: { toAffine(): { x: bigint; y: bigint } }, name: string) => ({ [`${name}.x`]: P.toAffine().x, [`${name}.y`]: P.toAffine().y });
const g2 = (name: string, x1: bigint, x0: bigint, y1: bigint, y0: bigint) => ({ [`${name}.xC1`]: x1, [`${name}.xC0`]: x0, [`${name}.yC1`]: y1, [`${name}.yC0`]: y0 });
const bytes = (h: string) => hex.decode(h.replace(/^0x/, ""));

describe("SP1 Groth16 proof verified in an Arkade covenant", () => {
    it.each([
        ["Succinct's v6.0.0 fixture proof", succinct],
        ["our CTF payout proof", ours],
    ])("spends on %s and refuses other public values and a tampered proof", { timeout: 600_000 }, async (label, f) => {
        const K = f.K;
        const pub = (i: number) => bn254.G1.Point.fromAffine({ x: K(`PUB_${i}_X`), y: K(`PUB_${i}_Y`) });
        const proofBytes = bytes(f.proof);
        const publicValues = bytes(f.publicValues);
        const words = Array.from({ length: (proofBytes.length - 4) / 32 }, (_, i) => BigInt(`0x${hex.encode(proofBytes.slice(4 + i * 32, 36 + i * 32))}`));
        const [exitCode, vkRoot, nonce, ...p] = words as [bigint, bigint, bigint, ...bigint[]];
        expect(exitCode).toBe(0n);
        const base = bn254.G1.Point.fromAffine({ x: K("CONSTANT_X"), y: K("CONSTANT_Y") })
            .add(pub(0).multiplyUnsafe(BigInt(f.vkey))).add(pub(3).multiplyUnsafe(vkRoot));

        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const contract = ark.contract(loadProgram(JSON.parse(fixture("sp1_groth16.json")) as ContractArtifact), {
            "alpha.x": K("ALPHA_X"), "alpha.y": K("ALPHA_Y"),
            ...g2("betaNeg", K("BETA_NEG_X_1"), K("BETA_NEG_X_0"), K("BETA_NEG_Y_1"), K("BETA_NEG_Y_0")),
            ...g2("gammaNeg", K("GAMMA_NEG_X_1"), K("GAMMA_NEG_X_0"), K("GAMMA_NEG_Y_1"), K("GAMMA_NEG_Y_0")),
            ...g2("deltaNeg", K("DELTA_NEG_X_1"), K("DELTA_NEG_X_0"), K("DELTA_NEG_Y_1"), K("DELTA_NEG_Y_0")),
            ...point(base, "base"), ...point(pub(1), "pub1"), ...point(pub(4), "pub4"),
        });
        const w = await newWallet();
        await faucet(await w.wallet.getAddress(), 20_000);
        await waitFor(async () => (await w.wallet.getBalance()).available >= 20_000, { what: "funded" });
        const back = await scriptOf(w);

        const witness = (pv: Uint8Array, c: { x: bigint; y: bigint }) => {
            const h = sha256(pv);
            const digest = BigInt(`0x${hex.encode(h)}`) & ((1n << 253n) - 1n);
            return {
                "a.x": p[0]!, "a.y": p[1]!, ...g2("b", p[2]!, p[3]!, p[4]!, p[5]!), "c.x": c.x, "c.y": c.y,
                nonce,
                publicValues: pv, digest, hi: BigInt(h[0]! >> 5),
            };
        };
        const spend = async (args: Record<string, bigint | Uint8Array>) => {
            const coin = await coinAt(contract.pkScript, "zk probe", await walletSend(ark, w, [{ script: contract.pkScript, amount: 2000n }]));
            return execute(ctx, [{ kind: "covenant", coin, contract, fn: "verify", args }], [{ script: back, amount: 2000n }]);
        };
        const C = { x: p[6]!, y: p[7]! };
        const otherValues = Uint8Array.from(publicValues);
        otherValues[31] = otherValues[31]! ^ 1;
        await expectCovenantRejection(spend(witness(otherValues, C)), "public values the proof does not commit to");
        const doubled = bn254.G1.Point.fromAffine(C).double().toAffine();
        await expectCovenantRejection(spend(witness(publicValues, doubled)), "a tampered proof");
        const { txid } = await spend(witness(publicValues, C));
        console.log(`${label} verified in-covenant: ${txid}`);
        expect(txid).toMatch(/^[0-9a-f]{64}$/);
    });
});
