import { hex } from "@scure/base";
import { claimBoxContract } from "../core/claimBox.js";
import type { BoxJson, RegisterBoxRequest } from "../shared/api.js";
import { all, now, one, run, type Db } from "./db.js";
import { HttpError, getMarket, marketTerms, type Deps } from "./markets.js";

export interface BoxRow {
    script: string;
    market_id: string;
    owner: string;
    owner_script: string;
    status: "watching" | "claimed";
}

/** Registration only makes the keeper watch the box; the box script itself fixes owner and payout address. */
export function registerBox(d: Deps, req: RegisterBoxRequest): BoxRow {
    const market = getMarket(d.db, req.marketId);
    const terms = market && marketTerms(market);
    if (!terms) throw new HttpError(404, "market", "unknown or inactive market");
    if (!/^[0-9a-f]{64}$/.test(req.owner) || !/^5120[0-9a-f]{64}$/.test(req.ownerScript)) throw new HttpError(400, "owner", "owner must be x-only hex and ownerScript a P2TR pkScript");
    const script = hex.encode(claimBoxContract(d.net.ark, terms, { owner: hex.decode(req.owner), ownerScript: hex.decode(req.ownerScript) }).pkScript);
    const t = now();
    run(d.db, "INSERT OR IGNORE INTO boxes(script, market_id, owner, owner_script, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", script, req.marketId, req.owner, req.ownerScript, t, t);
    return one<BoxRow>(d.db, "SELECT * FROM boxes WHERE script = ?", script)!;
}

export const watchedBoxes = (db: Db) => all<BoxRow>(db, "SELECT * FROM boxes WHERE status = 'watching'");
export const boxesByOwner = (db: Db, ownerScript: string) => all<BoxRow>(db, "SELECT * FROM boxes WHERE owner_script = ?", ownerScript);

export async function boxJson(d: Deps, b: BoxRow): Promise<BoxJson> {
    const { vtxos } = await d.net.indexer.getVtxos({ scripts: [b.script], spendableOnly: true });
    return {
        script: b.script, marketId: b.market_id, owner: b.owner, ownerScript: b.owner_script, status: b.status,
        coins: vtxos.filter((v) => !v.isSpent).map((v) => ({
            txid: v.txid, vout: v.vout, valueSats: String(v.value),
            assets: (v.assets ?? []).map((a) => ({ assetId: a.assetId, amount: a.amount.toString() })),
            expiresAt: v.expiresAt?.toISOString() ?? null,
        })),
    };
}
