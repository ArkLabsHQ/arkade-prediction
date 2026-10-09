import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bn254 } from "@noble/curves/bn254.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";
import { execute, type Ctx } from "../../src/core/actions.js";
import { loadProgram, type ContractArtifact } from "../../src/core/programs.js";
import { connectArkade, expectCovenantRejection, faucet, indexerProvider, newWallet, waitFor } from "./env.js";
import { coinAt, network, scriptOf, walletSend } from "./market.js";

// Fixtures from succinctlabs/sp1-contracts (MIT): the v6.0.0 Groth16 verifying key and its test proof.
const fixture = (name: string) => readFileSync(new URL(`../fixtures/zk/${name}`, import.meta.url), "utf8");
const sol = fixture("Groth16Verifier.v6.0.0.sol");
const K = (name: string) => BigInt(new RegExp(`uint256 constant ${name} = (\\d+);`).exec(sol)![1]!);
const t = fixture("SP1VerifierGroth16V6.t.sol");
const proofBytes = hex.decode(/PROOF_BYTES =\s*hex"([0-9a-f]+)"/.exec(t)![1]!);
const publicValues = hex.decode(/PUBLIC_VALUES =\s*hex"([0-9a-f]+)"/.exec(t)![1]!);
const programVKey = BigInt(/PROGRAM_VKEY =\s*bytes32\((0x[0-9a-f]+)\)/.exec(t)![1]!);

// The pinned SDK has no ECPoint/G2Point types; the compiler already flattens them to per-field slots.
const FIELDS: Record<string, string[]> = { ECPoint: ["x", "y"], G2Point: ["xC1", "xC0", "yC1", "yC0"] };
const flatten = (inputs: { name: string; type: string }[]) => inputs.flatMap((i) => (FIELDS[i.type] ? FIELDS[i.type]!.map((f) => ({ name: `${i.name}.${f}`, type: "int" })) : [i]));
function flatArtifact(): ContractArtifact {
    const a = JSON.parse(fixture("sp1_groth16.json"));
    a.constructorInputs = flatten(a.constructorInputs);
    for (const f of a.functions) f.arkade.inputs = flatten(f.arkade.inputs);
    return a;
}

const words = Array.from({ length: (proofBytes.length - 4) / 32 }, (_, i) => BigInt(`0x${hex.encode(proofBytes.slice(4 + i * 32, 36 + i * 32))}`));
const [exitCode, vkRoot, nonce, ...p] = words as [bigint, bigint, bigint, ...bigint[]];
const point = (P: { toAffine(): { x: bigint; y: bigint } }, name: string) => ({ [`${name}.x`]: P.toAffine().x, [`${name}.y`]: P.toAffine().y });
const g2 = (name: string, x1: bigint, x0: bigint, y1: bigint, y0: bigint) => ({ [`${name}.xC1`]: x1, [`${name}.xC0`]: x0, [`${name}.yC1`]: y1, [`${name}.yC0`]: y0 });
const pub = (i: number) => bn254.G1.Point.fromAffine({ x: K(`PUB_${i}_X`), y: K(`PUB_${i}_Y`) });
const base = bn254.G1.Point.fromAffine({ x: K("CONSTANT_X"), y: K("CONSTANT_Y") })
    .add(pub(0).multiplyUnsafe(programVKey)).add(pub(3).multiplyUnsafe(vkRoot)).add(pub(4).multiplyUnsafe(nonce));

describe("SP1 Groth16 proof verified in an Arkade covenant", () => {
    it("spends on Succinct's v6.0.0 fixture proof and refuses other public values and a tampered proof", { timeout: 600_000 }, async () => {
        expect(exitCode).toBe(0n);
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const contract = ark.contract(loadProgram(flatArtifact()), {
            "alpha.x": K("ALPHA_X"), "alpha.y": K("ALPHA_Y"),
            ...g2("betaNeg", K("BETA_NEG_X_1"), K("BETA_NEG_X_0"), K("BETA_NEG_Y_1"), K("BETA_NEG_Y_0")),
            ...g2("gammaNeg", K("GAMMA_NEG_X_1"), K("GAMMA_NEG_X_0"), K("GAMMA_NEG_Y_1"), K("GAMMA_NEG_Y_0")),
            ...g2("deltaNeg", K("DELTA_NEG_X_1"), K("DELTA_NEG_X_0"), K("DELTA_NEG_Y_1"), K("DELTA_NEG_Y_0")),
            ...point(base, "base"), ...point(pub(1), "pub1"),
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
        console.log(`SP1 v6.0.0 Groth16 proof verified in-covenant: ${txid}`);
        expect(txid).toMatch(/^[0-9a-f]{64}$/);
    });
});
