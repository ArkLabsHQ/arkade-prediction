import { bn254 } from "@noble/curves/bn254.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

/** An SP1 Groth16 verifying key: the constants of Succinct's Groth16Verifier.sol for one circuit version. */
export interface Sp1Groth16Vk {
    alpha: [bigint, bigint];
    betaNeg: [bigint, bigint, bigint, bigint];
    gammaNeg: [bigint, bigint, bigint, bigint];
    deltaNeg: [bigint, bigint, bigint, bigint];
    constant: [bigint, bigint];
    pub: [bigint, bigint][];
    /** Recursion verifying-key root and proof selector the SP1 wrapper (SP1VerifierGroth16.sol) pins. */
    vkRoot: bigint;
    selector: string;
}

/**
 * Reads a verifying key out of Groth16Verifier.sol (uint256 constants; G2 coordinates as X_1, X_0, Y_1, Y_0) and the
 * pinned VK_ROOT and VERIFIER_HASH out of the matching SP1VerifierGroth16.sol.
 */
export function vkFromSolidity(sol: string, wrapperSol: string): Sp1Groth16Vk {
    const b32 = (fn: string) => {
        const m = new RegExp(String.raw`function ${fn}\(\) public pure returns \(bytes32\) \{\s*return 0x([0-9a-f]{64});`).exec(wrapperSol);
        if (!m) throw new Error(`wrapper ${fn} not found`);
        return m[1]!;
    };
    const k = (name: string) => {
        const m = new RegExp(`uint256 constant ${name} = ([0-9]+);`).exec(sol);
        if (!m) throw new Error(`verifier constant ${name} not found`);
        return BigInt(m[1]!);
    };
    const g2 = (p: string): [bigint, bigint, bigint, bigint] => [k(`${p}_X_1`), k(`${p}_X_0`), k(`${p}_Y_1`), k(`${p}_Y_0`)];
    return {
        alpha: [k("ALPHA_X"), k("ALPHA_Y")], betaNeg: g2("BETA_NEG"), gammaNeg: g2("GAMMA_NEG"), deltaNeg: g2("DELTA_NEG"),
        constant: [k("CONSTANT_X"), k("CONSTANT_Y")], pub: [0, 1, 2, 3, 4].map((i) => [k(`PUB_${i}_X`), k(`PUB_${i}_Y`)]),
        vkRoot: BigInt(`0x${b32("VK_ROOT")}`), selector: b32("VERIFIER_HASH").slice(0, 8),
    };
}

const { G1, G2 } = { G1: bn254.G1.Point, G2: bn254.G2.Point };
const P = bn254.fields.Fp.ORDER;
const R = bn254.fields.Fr.ORDER;
const inField = (...xs: bigint[]) => xs.every((x) => x >= 0n && x < P);
// fromAffine does not check the curve or subgroup; an off-curve point must fail, not reach the pairing.
const g1 = ([x, y]: [bigint, bigint]) => {
    if (!inField(x, y)) throw new Error("coordinate out of field");
    const p = G1.fromAffine({ x, y });
    p.assertValidity();
    return p;
};
const g2 = ([x1, x0, y1, y0]: [bigint, bigint, bigint, bigint]) => {
    if (!inField(x1, x0, y1, y0)) throw new Error("coordinate out of field");
    const p = G2.fromAffine({ x: bn254.fields.Fp2.create({ c0: x0, c1: x1 }), y: bn254.fields.Fp2.create({ c0: y0, c1: y1 }) });
    p.assertValidity();
    return p;
};
const bytes = (h: string) => hex.decode(h.replace(/^0x/, ""));

/**
 * Verifies an SP1 Groth16 proof (selector ‖ exitCode ‖ vkRoot ‖ nonce ‖ 8 proof words) for `publicValues` under
 * program key `vkey`: the same four-pair check the covenant runs. False for any malformed or invalid input.
 */
export function verifySp1Groth16(vk: Sp1Groth16Vk, proof: string, publicValues: string, vkey: string): boolean {
    try {
        const pb = bytes(proof);
        if (pb.length !== 4 + 11 * 32 || hex.encode(pb.slice(0, 4)) !== vk.selector) return false;
        const w = Array.from({ length: 11 }, (_, i) => BigInt(`0x${hex.encode(pb.slice(4 + i * 32, 36 + i * 32))}`));
        const [exitCode, vkRoot, nonce, ax, ay, bx1, bx0, by1, by0, cx, cy] = w as [bigint, ...bigint[]];
        // Same pins as SP1VerifierGroth16.sol: a clean exit under the circuit's own recursion root, scalars in Fr.
        if (exitCode !== 0n || vkRoot !== vk.vkRoot) return false;
        const digest = BigInt(`0x${hex.encode(sha256(bytes(publicValues)))}`) & ((1n << 253n) - 1n);
        const programKey = BigInt(vkey);
        if (![programKey, digest, nonce!].every((x) => x < R)) return false;
        let vkx = g1(vk.constant);
        for (const [i, s] of [programKey, digest, exitCode, vkRoot!, nonce!].entries()) if (s !== 0n) vkx = vkx.add(g1(vk.pub[i]!).multiply(s));
        const product = bn254.pairingBatch([
            { g1: g1([ax!, ay!]), g2: g2([bx1!, bx0!, by1!, by0!]) },
            { g1: g1([cx!, cy!]), g2: g2(vk.deltaNeg) },
            { g1: g1(vk.alpha), g2: g2(vk.betaNeg) },
            { g1: vkx, g2: g2(vk.gammaNeg) },
        ]);
        return bn254.fields.Fp12.eql(product, bn254.fields.Fp12.ONE);
    } catch {
        return false;
    }
}
