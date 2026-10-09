import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { base64, hex } from "@scure/base";

/** RedStone's public latest-value gateway for the primary-prod data service (no API key). */
export const REDSTONE_GATEWAY = "https://oracle-gateway-1.a.redstone.finance/v2/data-packages/latest/redstone-primary-prod";

export interface RedStonePackage {
    timestampMilliseconds: number;
    signature: string;
    signerAddress: string;
    dataPoints: { dataFeedId: string; value: number }[];
}

export interface PriceReport {
    /** Per committed signer, in slot order: its own signed value and time, or zeros and an empty signature. */
    values: Uint8Array[];
    stamps: Uint8Array[];
    signatures: Uint8Array[];
    prices: (bigint | undefined)[];
    /** Median of the signed prices present. */
    price: bigint;
}

const be = (n: bigint, len: number) => {
    const out = new Uint8Array(len);
    for (let i = len - 1; i >= 0; i--, n >>= 8n) out[i] = Number(n & 0xffn);
    return out;
};

export function feedIdBytes(feed: string): Uint8Array {
    const b = new TextEncoder().encode(feed);
    if (b.length > 32) throw new Error("feed id longer than 32 bytes");
    const out = new Uint8Array(32);
    out.set(b);
    return out;
}

// ponytail: the gateway only exposes the value as a JSON float; x1e8 rounding reproduces what was signed.
const scaled = (v: number) => BigInt(Math.round(v * 1e8));

/** The 77 bytes a RedStone signer signs for a single data point. */
export function signable(feed: Uint8Array, value: Uint8Array, timestampMs: Uint8Array): Uint8Array {
    return new Uint8Array([...feed, ...value, ...timestampMs, ...be(32n, 4), ...be(1n, 3)]);
}

/** Compressed key of a package's signer, as a 0x10 attestor key, recovered from its own signature. */
export function packageSignerKey(p: RedStonePackage): Uint8Array {
    const dp = p.dataPoints[0]!;
    const sig = base64.decode(p.signature);
    const h = keccak_256(signable(feedIdBytes(dp.dataFeedId), be(scaled(dp.value), 32), be(BigInt(p.timestampMilliseconds), 6)));
    const key = secp256k1.Signature.fromBytes(sig.slice(0, 64), "compact").addRecoveryBit(sig[64]! - 27).recoverPublicKey(h);
    const address = `0x${hex.encode(keccak_256(key.toBytes(false).slice(1)).slice(-20))}`;
    if (address !== p.signerAddress.toLowerCase()) throw new Error(`package signature does not recover ${p.signerAddress}`);
    return Uint8Array.from([0x10, ...key.toBytes(true)]);
}

/** Places each committed signer's package for round settleAtMs in its slot; others get an empty slot. */
export function priceReport(feed: string, packages: RedStonePackage[], signers: Uint8Array[], settleAtMs: bigint): PriceReport {
    const slots = signers.map((k) => hex.encode(k));
    const report: PriceReport = {
        values: signers.map(() => new Uint8Array(32)), stamps: signers.map(() => new Uint8Array(6)),
        signatures: signers.map(() => new Uint8Array(0)), prices: signers.map(() => undefined), price: 0n,
    };
    for (const p of packages) {
        const dp = p.dataPoints.find((d) => d.dataFeedId === feed);
        if (!dp || p.dataPoints.length !== 1 || BigInt(p.timestampMilliseconds) !== settleAtMs) continue;
        let slot: number;
        try {
            slot = slots.indexOf(hex.encode(packageSignerKey(p)));
        } catch {
            continue;
        }
        if (slot < 0 || report.prices[slot] !== undefined) continue;
        report.prices[slot] = scaled(dp.value);
        report.values[slot] = be(scaled(dp.value), 32);
        report.stamps[slot] = be(BigInt(p.timestampMilliseconds), 6);
        report.signatures[slot] = base64.decode(p.signature).slice(0, 64);
    }
    const present = report.prices.filter((x): x is bigint => x !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (present.length === 0) throw new Error(`no package for ${feed} from a committed signer`);
    report.price = present[Math.floor(present.length / 2)]!;
    return report;
}

export async function latestPackages(feed: string, fetchImpl: typeof fetch = fetch): Promise<RedStonePackage[]> {
    const r = await fetchImpl(REDSTONE_GATEWAY, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`RedStone gateway answered ${r.status}`);
    const body = (await r.json()) as Record<string, RedStonePackage[] | undefined>;
    return body[feed] ?? [];
}
