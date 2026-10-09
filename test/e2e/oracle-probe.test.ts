import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { p256 } from "@noble/curves/nist.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { execute, type Ctx } from "../../src/core/actions.js";
import { loadProgram } from "../../src/core/programs.js";
import { connectArkade, expectCovenantRejection, faucet, indexerProvider, newWallet, waitFor } from "./env.js";
import { coinAt, network, scriptOf, walletSend } from "./market.js";

const program = loadProgram(JSON.parse(readFileSync(new URL("../fixtures/probe/oracle_probe.json", import.meta.url), "utf8")));
// Emulator extended keys: 0x10 = ECDSA/secp256k1, 0x11 = ECDSA/P-256, each followed by the 33-byte compressed key.
const extKey = (prefix: number, compressed: Uint8Array) => Uint8Array.from([prefix, ...compressed]);
const word = (n: number) => Uint8Array.from([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, 0]);

describe("other-chain oracle signatures in a covenant", () => {
    it("settles on an ECDSA/secp256k1 signature over keccak256 and on an ECDSA/P-256 signature over sha256", { timeout: 600_000 }, async () => {
        const ark = await connectArkade();
        const ctx: Ctx = { ark, net: network(ark), indexer: indexerProvider };
        const evmSecret = secp256k1.utils.randomSecretKey();
        const p256Secret = p256.utils.randomSecretKey();
        const contract = ark.contract(program, {
            evmSigner: extKey(0x10, secp256k1.getPublicKey(evmSecret, true)),
            p256Signer: extKey(0x11, p256.getPublicKey(p256Secret, true)),
            threshold: 100n,
        });
        const w = await newWallet();
        await faucet(await w.wallet.getAddress(), 20_000);
        await waitFor(async () => (await w.wallet.getBalance()).available >= 20_000, { what: "funded" });
        const back = await scriptOf(w);
        const fund = async () => coinAt(contract.pkScript, "probe", await walletSend(ark, w, [{ script: contract.pkScript, amount: 2000n }]));

        // An EVM-style report: value 150 >= threshold 100, signed as an EVM oracle would sign keccak256(report).
        const report = Uint8Array.from([...word(150), ...randomBytes(28)]);
        const evmSig = secp256k1.sign(keccak_256(report), evmSecret, { prehash: false });
        let coin = await fund();
        const lowReport = Uint8Array.from([...word(50), ...report.slice(4)]);
        const lowSig = secp256k1.sign(keccak_256(lowReport), evmSecret, { prehash: false });
        await expectCovenantRejection(execute(ctx, [{ kind: "covenant", coin, contract, fn: "evm", args: { payload: lowReport, sig: lowSig } }], [{ script: back, amount: 2000n }]), "value below threshold");
        await expectCovenantRejection(execute(ctx, [{ kind: "covenant", coin, contract, fn: "evm", args: { payload: report, sig: lowSig } }], [{ script: back, amount: 2000n }]), "signature over another report");
        const evm = await execute(ctx, [{ kind: "covenant", coin, contract, fn: "evm", args: { payload: report, sig: evmSig } }], [{ script: back, amount: 2000n }]);

        const attestation = randomBytes(64);
        const p256Sig = p256.sign(sha256(attestation), p256Secret, { prehash: false });
        coin = await fund();
        const p256Path = await execute(ctx, [{ kind: "covenant", coin, contract, fn: "p256", args: { payload: attestation, sig: p256Sig } }], [{ script: back, amount: 2000n }]);
        console.log(`keccak+secp256k1 ECDSA spend ${evm.txid}; sha256+P-256 ECDSA spend ${p256Path.txid}`);
        expect(evm.txid).toMatch(/^[0-9a-f]{64}$/);
    });
});
