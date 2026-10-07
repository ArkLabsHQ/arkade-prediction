import { asset } from "@arkade-os/sdk";
import { hex } from "@scure/base";

/** Covenant args for an asset id. Asset opcodes match the txid byte-reversed vs AssetId serialization. */
export function assetScriptArgs(assetId: string): { txid: Uint8Array; gidx: bigint } {
    const parsed = asset.AssetId.fromString(assetId);
    return { txid: Uint8Array.from(parsed.txid).reverse(), gidx: BigInt(parsed.groupIndex) };
}

export function assetIdOf(txid: string, groupIndex: number): string {
    return asset.AssetId.create(txid, groupIndex).toString();
}

export function isAssetId(value: string): boolean {
    try {
        asset.AssetId.fromString(value);
        return /^[0-9a-f]{68}$/.test(value);
    } catch {
        return false;
    }
}

export const hexOf = (b: Uint8Array) => hex.encode(b);
