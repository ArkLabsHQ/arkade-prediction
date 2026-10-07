import { Transaction } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import type { Coin } from "../core/arkadeTx.js";
import { offerContract } from "../core/offers.js";
import {
    offerTermsFromJson,
    type CoinJson,
    type OfferJson,
    type OfferStatus,
    type OfferTermsJson,
    type Outcome,
    type PostOfferRequest,
    type TradeJson,
} from "../shared/api.js";
import { all, now, one, run, tx, type Db } from "./db.js";
import { HttpError, getMarket, marketTerms, type Deps } from "./markets.js";

interface OfferRow {
    id: string;
    market_id: string;
    outcome: Outcome;
    side: "sell" | "buy";
    terms: string;
    script: string;
    maker_script: string;
    coin: string | null;
    status: OfferStatus;
    remaining: string;
    funding_txid: string;
    created_at: string;
    updated_at: string;
}

const coinJson = (c: Coin & { expiresAt?: Date }): CoinJson => ({
    txid: c.txid, vout: c.vout, valueSats: String(c.value),
    assets: (c.assets ?? []).map((a) => ({ assetId: a.assetId, amount: a.amount.toString() })),
    expiresAt: c.expiresAt?.toISOString() ?? null,
});

export function offerJson(r: OfferRow): OfferJson {
    return {
        id: r.id, marketId: r.market_id, outcome: r.outcome, terms: JSON.parse(r.terms), script: r.script,
        coin: r.coin ? JSON.parse(r.coin) : null, remaining: r.remaining, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
    };
}

function remainingOf(t: OfferTermsJson, c: Coin): bigint {
    if (t.side === "sell") return (c.assets ?? []).filter((a) => a.assetId === t.assetId).reduce((s, a) => s + a.amount, 0n);
    const budget = BigInt(c.value) - BigInt(t.reserveSats);
    return budget > 0n ? budget / BigInt(t.priceSats) : 0n;
}

export const getOffer = (db: Db, id: string) => one<OfferRow>(db, "SELECT * FROM offers WHERE id = ?", id);
export const listOffers = (db: Db, marketId: string, status?: string) =>
    all<OfferRow>(db, "SELECT * FROM offers WHERE market_id = ? AND (? IS NULL OR status = ?) ORDER BY CAST(json_extract(terms, '$.priceSats') AS INTEGER)", marketId, status ?? null, status ?? null);
export const offersByMaker = (db: Db, makerScript: string) =>
    all<OfferRow>(db, "SELECT * FROM offers WHERE maker_script = ? ORDER BY updated_at DESC LIMIT 200", makerScript);
export const openOffers = (db: Db, limit = 500) => all<OfferRow>(db, "SELECT * FROM offers WHERE status = 'open' ORDER BY updated_at LIMIT ?", limit);

/** First writer wins per (txid, offer): the keeper records mint-matches before generic fill inference runs. */
export function recordTrade(db: Db, t: { txid: string; offerId: string; marketId: string; outcome: string; kind: "fill" | "mint-match"; makerSide: string; qty: bigint; priceSats: string }): void {
    run(db, "INSERT OR IGNORE INTO trades(txid, offer_id, market_id, outcome, kind, maker_side, qty, price_sats, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        t.txid, t.offerId, t.marketId, t.outcome, t.kind, t.makerSide, t.qty.toString(), t.priceSats, now());
}

export function trades(db: Db, f: { marketId?: string; offerIds?: string[]; limit: number }): TradeJson[] {
    const rows = f.offerIds
        ? all<Record<string, string>>(db, `SELECT * FROM trades WHERE offer_id IN (SELECT value FROM json_each(?)) ORDER BY at DESC LIMIT ?`, JSON.stringify(f.offerIds), f.limit)
        : all<Record<string, string>>(db, "SELECT * FROM trades WHERE market_id = ? ORDER BY at DESC LIMIT ?", f.marketId ?? "", f.limit);
    return rows.map((r) => ({
        txid: r.txid!, marketId: r.market_id!, offerId: r.offer_id ?? null, outcome: r.outcome as Outcome, kind: r.kind as TradeJson["kind"],
        makerSide: r.maker_side as TradeJson["makerSide"], qty: r.qty!, priceSats: r.price_sats!, at: r.at!,
    }));
}

export async function registerOffer(d: Deps, req: PostOfferRequest): Promise<OfferJson> {
    const market = getMarket(d.db, req.marketId);
    const terms = market && marketTerms(market);
    if (!market || !terms) throw new HttpError(404, "market", "unknown or inactive market");
    if (market.status !== "open") throw new HttpError(409, "market-closed", "market is not open for trading");
    const t = req.terms;
    const outcome: Outcome | undefined = t.assetId === terms.assets.yes ? "yes" : t.assetId === terms.assets.no ? "no" : undefined;
    if (!outcome) throw new HttpError(400, "asset", "offer asset is not a claim of this market");
    let parsed;
    try {
        parsed = offerTermsFromJson(t);
    } catch {
        throw new HttpError(400, "terms", "malformed offer terms");
    }
    if (parsed.priceSats <= 0n || parsed.priceSats >= terms.unitSats) throw new HttpError(400, "price", "price must be between 1 and unit-1 sats");
    if (parsed.minFill <= 0n) throw new HttpError(400, "min-fill", "min fill must be positive");
    if (parsed.exitDelaySeconds < d.net.exitDelaySeconds) throw new HttpError(400, "exit-delay", "exit delay below the operator minimum");
    if (parsed.side === "buy" && parsed.reserveSats < 330n) throw new HttpError(400, "reserve", "buy offers keep at least 330 sats in reserve");
    const nowS = BigInt(Math.floor(Date.now() / 1000));
    if (parsed.expiresAt !== 0n && parsed.expiresAt <= nowS) throw new HttpError(400, "expiry", "offer already expired");
    const contract = offerContract(d.net.ark, parsed);
    const script = hex.encode(contract.pkScript);
    if (one(d.db, "SELECT 1 FROM offers WHERE script = ? AND status = 'open'", script)) throw new HttpError(409, "duplicate", "an identical live offer exists; vary the expiry");
    const { vtxos } = await d.net.indexer.getVtxos({ scripts: [script], spendableOnly: true });
    const funded = vtxos.find((v) => v.txid === req.fundingTxid && !v.isSpent);
    if (!funded) throw new HttpError(404, "funding", "no live coin from the funding tx at the offer script");
    const coin = { txid: funded.txid, vout: funded.vout, value: funded.value, assets: funded.assets, expiresAt: funded.expiresAt };
    const foreign = (coin.assets ?? []).some((a) => a.assetId !== parsed.assetId);
    if (foreign) throw new HttpError(400, "assets", "offer coin carries unrelated assets");
    const remaining = remainingOf(t, coin);
    if (remaining <= 0n) throw new HttpError(400, "size", "offer is empty");
    const id = `${coin.txid}:${coin.vout}`;
    const at = now();
    run(d.db, "INSERT INTO offers(id, market_id, outcome, side, terms, script, maker_script, coin, status, remaining, funding_txid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)",
        id, market.id, outcome, t.side, JSON.stringify(t), script, t.makerScript, JSON.stringify(coinJson(coin)), remaining.toString(), req.fundingTxid, at, at);
    d.bus.publish("offer", market.id, { id, status: "open" });
    return offerJson(getOffer(d.db, id)!);
}

/**
 * Re-reads the offer from the indexer. A changed coin means a fill (remaining decreased for asks, held units
 * increased for bids) or a renewal (same remaining). A vanished coin is classified from the spending tx.
 */
export async function refreshOffer(d: Deps, id: string): Promise<OfferJson> {
    const row = getOffer(d.db, id);
    if (!row) throw new HttpError(404, "offer", "unknown offer");
    if (row.status !== "open") return offerJson(row);
    const t: OfferTermsJson = JSON.parse(row.terms);
    const prev: CoinJson | null = row.coin ? JSON.parse(row.coin) : null;
    const { vtxos } = await d.net.indexer.getVtxos({ scripts: [row.script], spendableOnly: true });
    const live = vtxos.find((v) => !v.isSpent);
    const prevRemaining = BigInt(row.remaining);
    const heldBefore = prev ? prev.assets.filter((a) => a.assetId === t.assetId).reduce((s, a) => s + BigInt(a.amount), 0n) : 0n;
    let status: OfferStatus = "open";
    let coin: CoinJson | null = prev;
    let remaining = prevRemaining;
    let traded: { txid: string; qty: bigint } | undefined;

    if (live) {
        const c = { txid: live.txid, vout: live.vout, value: live.value, assets: live.assets, expiresAt: live.expiresAt };
        coin = coinJson(c);
        remaining = remainingOf(t, c);
        const heldNow = (c.assets ?? []).filter((a) => a.assetId === t.assetId).reduce((s, a) => s + a.amount, 0n);
        const qty = t.side === "sell" ? prevRemaining - remaining : heldNow - heldBefore;
        if (qty > 0n) traded = { txid: c.txid, qty };
    } else if (prev) {
        const { vtxos: old } = await d.net.indexer.getVtxos({ outpoints: [{ txid: prev.txid, vout: prev.vout }] });
        const spender = old[0]?.arkTxId;
        if (!spender) return offerJson(row);
        const { txs } = await d.net.indexer.getVirtualTxs([spender]);
        const spendTx = txs.map((p) => Transaction.fromPSBT(base64.decode(p))).find((x) => x.id === spender);
        if (!spendTx) return offerJson(row);
        // A continuation the indexer has not listed yet: a partial fill, not a terminal state.
        for (let i = 0; i < spendTx.outputsLength; i++) {
            const s = spendTx.getOutput(i).script;
            if (s && hex.encode(s) === row.script) return offerJson(row);
        }
        const expired = BigInt(t.expiresAtUnix) !== 0n && BigInt(t.expiresAtUnix) <= BigInt(Math.floor(Date.now() / 1000));
        status = expired ? "settled" : "cancelled";
        {
            for (let i = 0; i < spendTx.outputsLength; i++) {
                const out = spendTx.getOutput(i);
                if (!out.script || hex.encode(out.script) !== t.makerScript) continue;
                const paid = (out.amount ?? 0n) - BigInt(prev.valueSats);
                if (t.side === "sell" && paid === prevRemaining * BigInt(t.priceSats)) {
                    status = "filled";
                    traded = { txid: spender, qty: prevRemaining };
                } else if (t.side === "buy" && paid < 0n && !expired) {
                    status = "filled";
                    traded = { txid: spender, qty: -paid / BigInt(t.priceSats) };
                }
            }
        }
        remaining = 0n;
        coin = null;
    }

    tx(d.db, () => {
        if (traded) {
            recordTrade(d.db, { txid: traded.txid, offerId: id, marketId: row.market_id, outcome: row.outcome, kind: "fill", makerSide: row.side, qty: traded.qty, priceSats: t.priceSats });
        }
        run(d.db, "UPDATE offers SET coin = ?, status = ?, remaining = ?, updated_at = ? WHERE id = ? AND status = 'open'",
            coin ? JSON.stringify(coin) : null, status, remaining.toString(), now(), id);
    });
    if (traded || status !== "open" || coin?.txid !== prev?.txid) {
        d.bus.publish(traded ? "trade" : "offer", row.market_id, { id, status, remaining: remaining.toString(), txid: traded?.txid });
    }
    return offerJson(getOffer(d.db, id)!);
}
