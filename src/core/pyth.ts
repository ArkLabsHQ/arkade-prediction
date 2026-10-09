import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";

/** Pyth Pro (Lazer) "evm" format, as PythLazer.sol / PythLazerLib.sol parse it. All integers big-endian. */
export const EVM_MAGIC = 706910618;
export const PAYLOAD_MAGIC = 2479346549;
const PRICE_PROPERTY = 0;

export interface PythUpdate {
    /** The 28-byte single-feed, price-only payload the vault accepts. */
    payload: Uint8Array;
    /** r || s, as OP_CHECKSIGFROMSTACK takes it. */
    signature: Uint8Array;
    timestampUs: bigint;
    feedId: number;
    price: bigint;
}

const view = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);

export function parseEvmUpdate(update: Uint8Array): PythUpdate & { recovery: number } {
    const v = view(update);
    if (update.length < 71 || v.getUint32(0) !== EVM_MAGIC) throw new Error("not a Pyth Pro evm update");
    const payload = update.slice(71, 71 + v.getUint16(69));
    const p = view(payload);
    if (payload.length !== 28 || p.getUint32(0) !== PAYLOAD_MAGIC || p.getUint8(13) !== 1 || p.getUint8(18) !== 1 || p.getUint8(19) !== PRICE_PROPERTY) {
        throw new Error("the vault takes single-feed, price-only payloads");
    }
    return {
        payload, signature: update.slice(4, 68), recovery: update[68]!, timestampUs: p.getBigUint64(4), feedId: p.getUint32(14), price: p.getBigInt64(20),
    };
}

/** Builds a payload and its evm envelope; the vault and parser tests sign with a local key in place of Pyth's. */
export function evmUpdate(secret: Uint8Array, feedId: number, timestampUs: bigint, price: bigint, channel = 1): Uint8Array {
    const payload = new Uint8Array(28);
    const p = view(payload);
    p.setUint32(0, PAYLOAD_MAGIC);
    p.setBigUint64(4, timestampUs);
    p.setUint8(12, channel);
    p.setUint8(13, 1);
    p.setUint32(14, feedId);
    p.setUint8(18, 1);
    p.setUint8(19, PRICE_PROPERTY);
    p.setBigInt64(20, price);
    const sig = secp256k1.sign(keccak_256(payload), secret, { prehash: false, format: "recovered" });
    const out = new Uint8Array(71 + 28);
    const o = view(out);
    o.setUint32(0, EVM_MAGIC);
    out.set(sig.slice(1, 65), 4);
    out[68] = sig[0]!;
    o.setUint16(69, 28);
    out.set(payload, 71);
    return out;
}

/** The signer of an update as a 0x10 key, recovered from its own signature (the vault has no ecrecover). */
export function updateSignerKey(update: Uint8Array): Uint8Array {
    const u = parseEvmUpdate(update);
    const key = secp256k1.Signature.fromBytes(u.signature, "compact").addRecoveryBit(u.recovery).recoverPublicKey(keccak_256(u.payload));
    return Uint8Array.from([0x10, ...key.toBytes(true)]);
}
