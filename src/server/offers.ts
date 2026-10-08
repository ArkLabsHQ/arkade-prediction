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

/** Hops followed per refresh. Exhausting it keeps the offer open on the last coin reached, so the next tick resumes there. */
const MAX_HOPS = 20;

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

const unitsOf = (assets: { assetId: string; amount: bigint | string }[] | undefined, assetId: string): bigint =>
    (assets ?? []).filter((a) => a.assetId === assetId).reduce((s, a) => s + BigInt(a.amount), 0n);

function remainingOf(t: OfferTermsJson, c: Coin): bigint {
    if (t.side === "sell") return unitsOf(c.assets, t.assetId);
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

type Outpoint = { txid: string; vout: number };
type Hop = { txid: string; qty: bigint };

/** Arkade txs spend checkpoint outputs, so our coin appears as the checkpoint that consumed it. */
function spentInputIndex(spendTx: Transaction, checkpointTxid: string | undefined, tracked: Outpoint): number | undefined {
    for (let i = 0; i < spendTx.inputsLength; i++) {
        const inp = spendTx.getInput(i);
        const prevTxid = inp.txid && hex.encode(inp.txid);
        if (prevTxid && (prevTxid === checkpointTxid || (prevTxid === tracked.txid && inp.index === tracked.vout))) return i;
    }
    return spendTx.inputsLength === 1 ? 0 : undefined;
}

/** A renewal re-creates the coin in a batch: same script, same value, same assets, new outpoint. */
async function renewedInto(d: Deps, script: string, commitmentTxid: string, assetId: string, base: { value: bigint; units: bigint }): Promise<Outpoint | undefined> {
    const { vtxos } = await d.net.indexer.getVtxos({ scripts: [script] });
    const v = vtxos.find((x) => x.commitmentTxIds?.includes(commitmentTxid) && BigInt(x.value) === base.value && unitsOf(x.assets, assetId) === base.units);
    return v && { txid: v.txid, vout: v.vout };
}

/**
 * Covenant rules at `tx.outputs[i]`: a final fill pays the maker the prior value plus the proceeds (sell) or the
 * bought units (buy); `settle` tunnels both unchanged, only past expiry; anything else is the cancel leaf.
 */
async function classifyTerminal(
    d: Deps, t: OfferTermsJson, out: { amount?: bigint }, at: Outpoint, base: { value: bigint; units: bigint }, expired: boolean,
): Promise<{ status: OfferStatus; hop?: Hop } | undefined> {
    const paid = out.amount ?? 0n;
    if (t.side === "sell") {
        if (paid >= base.value + base.units * BigInt(t.priceSats)) return { status: "filled", hop: { txid: at.txid, qty: base.units } };
    } else {
        const { vtxos } = await d.net.indexer.getVtxos({ outpoints: [at] });
        const delivered = vtxos.find((x) => x.txid === at.txid && x.vout === at.vout);
        if (!delivered) return undefined;
        const qty = unitsOf(delivered.assets, t.assetId) - base.units;
        if (qty > 0n) return { status: "filled", hop: { txid: at.txid, qty } };
    }
    return { status: paid === base.value && expired ? "settled" : "cancelled" };
}

/**
 * Follows the offer's own coin from the tracked outpoint, so a coin at the offer script is adopted only when
 * this lineage reaches it. Each hop onto a continuation is a fill sized by the unit delta.
 */
export async function refreshOffer(d: Deps, id: string): Promise<OfferJson> {
    const row = getOffer(d.db, id);
    if (!row) throw new HttpError(404, "offer", "unknown offer");
    if (row.status !== "open") return offerJson(row);
    const t: OfferTermsJson = JSON.parse(row.terms);
    const prev: CoinJson | null = row.coin ? JSON.parse(row.coin) : null;
    if (!prev) return offerJson(row);
    const expired = BigInt(t.expiresAtUnix) !== 0n && BigInt(t.expiresAtUnix) <= BigInt(Math.floor(Date.now() / 1000));
    const hops: Hop[] = [];
    let status: OfferStatus = "open";
    let coin: CoinJson | null = prev;
    let remaining = BigInt(row.remaining);
    let base = { value: BigInt(prev.valueSats), units: unitsOf(prev.assets, t.assetId) };
    let tracked: Outpoint = { txid: prev.txid, vout: prev.vout };

    for (let hop = 0; hop < MAX_HOPS; hop++) {
        const { vtxos } = await d.net.indexer.getVtxos({ outpoints: [tracked] });
        const v = vtxos.find((x) => x.txid === tracked.txid && x.vout === tracked.vout);
        if (!v) break;
        const c = { txid: v.txid, vout: v.vout, value: v.value, assets: v.assets, expiresAt: v.expiresAt };
        const units = unitsOf(v.assets, t.assetId);
        const qty = t.side === "sell" ? base.units - units : units - base.units;
        if (hop > 0 && qty > 0n) hops.push({ txid: v.txid, qty });
        coin = coinJson(c);
        remaining = remainingOf(t, c);
        base = { value: BigInt(v.value), units };

        if (!v.isSpent && !v.settledBy) {
            if (v.isSwept) status = "gone";
            break;
        }
        if (v.settledBy) {
            const renewed = await renewedInto(d, row.script, v.settledBy, t.assetId, base);
            if (!renewed) break;
            tracked = renewed;
            continue;
        }
        if (!v.arkTxId) break;
        const { txs } = await d.net.indexer.getVirtualTxs([v.arkTxId]);
        const spendTx = txs.map((p) => Transaction.fromPSBT(base64.decode(p))).find((x) => x.id === v.arkTxId);
        if (!spendTx) break;
        const i = spentInputIndex(spendTx, v.spentBy, tracked);
        if (i === undefined || i >= spendTx.outputsLength) break;
        const out = spendTx.getOutput(i);
        if (!out.script) break;
        const bound: Outpoint = { txid: spendTx.id, vout: i };
        if (hex.encode(out.script) === row.script) {
            tracked = bound;
            continue;
        }
        const end = await classifyTerminal(d, t, out, bound, base, expired);
        if (!end) break;
        status = end.status;
        if (end.hop) hops.push(end.hop);
        break;
    }
    if (status !== "open") {
        coin = null;
        remaining = 0n;
    }

    // Conditioned on the coin we read: a concurrent refresh that already advanced it owns the hops it saw.
    const applied = tx(d.db, () => {
        const res = run(d.db, "UPDATE offers SET coin = ?, status = ?, remaining = ?, updated_at = ? WHERE id = ? AND status = 'open' AND coin IS ?",
            coin ? JSON.stringify(coin) : null, status, remaining.toString(), now(), id, row.coin);
        if (!res.changes) return false;
        for (const h of hops) {
            recordTrade(d.db, { txid: h.txid, offerId: id, marketId: row.market_id, outcome: row.outcome, kind: "fill", makerSide: row.side, qty: h.qty, priceSats: t.priceSats });
        }
        return true;
    });
    if (!applied) return offerJson(getOffer(d.db, id)!);
    const traded = hops[hops.length - 1];
    if (traded || status !== "open" || coin?.txid !== prev.txid || coin.vout !== prev.vout) {
        d.bus.publish(traded ? "trade" : "offer", row.market_id, { id, status, remaining: remaining.toString(), txid: traded?.txid });
    }
    return offerJson(getOffer(d.db, id)!);
}
