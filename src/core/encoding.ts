import { sha256 } from "@noble/hashes/sha2.js";
import { hex } from "@scure/base";

const utf8 = new TextEncoder();

/** OP_NUM2BIN: minimal script-number (little-endian, sign bit in the top byte) padded to `size`. */
export function num2bin(n: bigint, size: number): Uint8Array {
    const negative = n < 0n;
    let abs = negative ? -n : n;
    const out = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        out[i] = Number(abs & 0xffn);
        abs >>= 8n;
    }
    if (abs !== 0n || (out[size - 1]! & 0x80) !== 0) throw new Error(`${n} does not fit num2bin(${size})`);
    if (negative) out[size - 1]! |= 0x80;
    return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
    let o = 0;
    for (const p of parts) {
        out.set(p, o);
        o += p.length;
    }
    return out;
}

export const bytesOf = (s: string) => utf8.encode(s);

/** Deterministic JSON: sorted object keys, bigint as decimal string, no undefined. */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value === "boolean" || typeof value === "number") {
        if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("non-integer number in canonical JSON");
        return JSON.stringify(value);
    }
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    if (typeof value === "string") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (typeof value === "object") {
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    throw new Error(`unsupported value in canonical JSON: ${typeof value}`);
}

export function sha256Hex(data: Uint8Array | string): string {
    return hex.encode(sha256(typeof data === "string" ? utf8.encode(data) : data));
}

/** Domain-separated digest of a canonical JSON document. */
export function taggedJsonHash(tag: string, doc: unknown): Uint8Array {
    return sha256(concatBytes(utf8.encode(tag), new Uint8Array([0]), utf8.encode(canonicalJson(doc))));
}
