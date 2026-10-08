import { hex } from "@scure/base";
import { ORACLE_SLOTS, oracleSlots } from "../core/market.js";

/** Why this attestor must refuse the request's attestor set or block (undefined if it may proceed). */
export function attestorSetProblem(
    req: { oracle?: { keys?: unknown; threshold?: unknown }; atBlock?: unknown },
    ownKey: string,
): { code: string; error: string } | undefined {
    const keys = Array.isArray(req.oracle?.keys) ? (req.oracle.keys as unknown[]) : [];
    try {
        if (keys.length !== ORACLE_SLOTS || !keys.every((k) => typeof k === "string" && /^[0-9a-f]{64}$/.test(k))) {
            throw new Error(`${ORACLE_SLOTS} 32-byte attestor slots expected`);
        }
        oracleSlots((keys as string[]).map((k) => hex.decode(k)), Number(req.oracle?.threshold));
    } catch (err) {
        return { code: "oracle-set", error: (err as Error).message };
    }
    if (!keys.includes(ownKey)) return { code: "oracle-set", error: "this attestor is not in the market's attestor set" };
    if (req.atBlock !== undefined && !(typeof req.atBlock === "string" && /^[1-9]\d{0,15}$/.test(req.atBlock))) {
        return { code: "block", error: "atBlock must be a block number" };
    }
    return undefined;
}
