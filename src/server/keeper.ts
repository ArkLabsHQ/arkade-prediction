import { SingleKey, networks } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { assetIdOf } from "../core/assets.js";
import { sha256Hex } from "../core/encoding.js";
import {
    cancelOffer, issueMarketAssets, mintMatch, mintSets, openVault, postOffer, redeemAll, resolveMarket, resolvePriceMarket, settleExpiredOffer,
    timeoutMarket, type Ctx, type LiveOffer, type Party,
} from "../core/actions.js";
import { bindingOf, type MarketDefinition } from "../core/definition.js";
import { marketContracts, oracleSlots, PRICE_SIGNER_SLOTS, type PriceTerms, type VaultTerms } from "../core/market.js";
import { REDSTONE_PRIMARY_SIGNERS, feedIdBytes, latestPackages, packageSignerKey, priceReport } from "../core/redstone.js";
import { storedRound } from "./rounds.js";
import { isBusy } from "./sources/busy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { MIN_BET_SATS, fillAllowed, minFillFor, offerContract, type OfferTerms } from "../core/offers.js";
import { renewCovenantVtxos, type RenewTarget } from "../core/renewal.js";
import { coinFromJson, offerTermsFromJson, offerTermsToJson, termsToJson, type CoinJson, type OfferTermsJson } from "../shared/api.js";
import { all, now, run, type Db } from "./db.js";
import type { WriterLease } from "./lease.js";
import { auditGenesis, getMarket, marketTerms, reconcileVault, type Deps, type MarketRow } from "./markets.js";
import { getOffer, openOffers, recordTrade, refreshOffer, registerOffer } from "./offers.js";
import { watchedBoxes } from "./boxes.js";
import { quorums } from "./certificates.js";
import { autoClaim, claimBoxContract } from "../core/claimBox.js";
import { backoffMs, type Workflow, type Workflows } from "./workflows.js";

export interface KeeperDeps extends Deps {
    wf: Workflows;
    lease: WriterLease;
    operator?: Party;
    lp?: Party;
    keeperScript: Uint8Array;
    log: (msg: string, extra?: Record<string, unknown>) => void;
}

type Outcome = "landed" | "not-submitted" | "lost" | "unknown";

/** Kinds whose handler runs several sub-transactions: a landed step is progress, never completion. */
const MULTI_STEP = new Set(["activate", "lp-liquidity", "lp-reprice"]);
const MATCH_CANDIDATES = 5;
const RENEW_DEADLINE_MS = 10 * 60_000;
const LP_MIN_WINDOW_SECONDS = 60;
const RETRYABLE_ACTIVATION = /insufficient funds|below the \d+-sat carrier|not visible|timed out|fetch failed|ECONNRESET/i;

/** Classifies an ambiguous submission from authoritative indexer state; a timeout alone never means failure. */
export async function reconcileSubmission(d: Deps, txid: string | null, inputs: string[]): Promise<Outcome> {
    if (inputs.length === 0) return txid && (await outputsVisible(d, txid)) ? "landed" : "unknown";
    const outpoints = inputs.map((o) => ({ txid: o.split(":")[0]!, vout: Number(o.split(":")[1]) }));
    const { vtxos } = await d.net.indexer.getVtxos({ outpoints });
    if (vtxos.length < outpoints.length) return "unknown";
    // arkd also lists a submission it recorded and then failed, so the inputs decide, not the tx's presence.
    if (vtxos.every((v) => !v.isSpent && !v.settledBy)) return "not-submitted";
    if (txid && vtxos.some((v) => v.arkTxId === txid)) return (await outputsVisible(d, txid)) ? "landed" : "unknown";
    return "lost";
}

/** arkd spends the inputs when it accepts a transaction but creates the outputs only when it is finalized. */
async function outputsVisible(d: Deps, txid: string): Promise<boolean> {
    return (await d.net.indexer.getVtxos({ outpoints: [{ txid, vout: 0 }] })).vtxos.length > 0;
}

/** Regtest-only crash injection at workflow boundaries: APM_FAULT=<before-submit|before-finalize|after-submit>:<kind>. */
function maybeCrash(cfg: { APM_NETWORK: string }, phase: "before-submit" | "before-finalize" | "after-submit", kind: string): void {
    if (cfg.APM_NETWORK !== "regtest" || process.env.APM_FAULT !== `${phase}:${kind}`) return;
    console.log(JSON.stringify({ level: "warn", msg: "injected crash", phase, kind }));
    process.exit(137);
}

export class Keeper {
    private running = false;

    constructor(private readonly d: KeeperDeps) {}

    /** One pass: refresh authoritative state, plan idempotent workflows, then run due ones in order. */
    async tick(): Promise<void> {
        if (this.running || !this.d.lease.heartbeat()) return;
        this.running = true;
        try {
            await this.refresh();
            await this.plan();
            for (const wf of this.d.wf.due(20)) {
                if (!this.d.lease.held) break;
                await this.execute(wf);
            }
        } finally {
            this.running = false;
        }
    }

    private async refresh(): Promise<void> {
        // Dropping 'halted' here would freeze the market's vault state: never 'resolved', so no auto-claims.
        for (const m of all<MarketRow>(this.d.db, "SELECT * FROM markets WHERE terms IS NOT NULL AND status IN ('open','halted','closed','resolving','resolved')")) {
            await reconcileVault(this.d, m).catch((e) => this.d.log("vault reconcile failed", { market: m.id, error: String(e) }));
        }
        for (const o of openOffers(this.d.db)) {
            await refreshOffer(this.d, o.id).catch((e) => this.d.log("offer refresh failed", { offer: o.id, error: String(e) }));
        }
    }

    private async plan(): Promise<void> {
        const { db, wf } = this.d;
        const nowS = Math.floor(Date.now() / 1000);
        // Nothing else re-enqueues activation, and a stuck 'activating' row still counts against IMPORT_MAX_ACTIVE.
        if (this.d.operator) {
            for (const m of all<MarketRow>(db, "SELECT id FROM markets WHERE status = 'activating'")) wf.enqueue(`activate:${m.id}`, "activate", m.id, {});
        }
        for (const m of all<MarketRow>(db, "SELECT * FROM markets WHERE vault_phase = 'open' AND terms IS NOT NULL AND close_at <= ?", nowS)) {
            const terms = marketTerms(m);
            const reached = terms && !terms.price && quorums(db, m.id, terms)[0];
            if (terms?.price?.kind === "updown" && signedRounds(db, terms)) wf.enqueue(`resolve-price:${m.id}`, "resolve-price", m.id, {});
            else if (reached) wf.enqueue(`resolve:${m.id}`, "resolve", m.id, { outcome: reached.outcome });
            else if (terms && m.timeout_at > 0 && m.timeout_at <= nowS) wf.enqueue(`timeout:${m.id}`, "timeout", m.id, {});
        }
        const offers = openOffers(db);
        for (const o of offers) {
            const t: OfferTermsJson = JSON.parse(o.terms);
            if (o.coin && t.expiresAtUnix !== "0" && Number(t.expiresAtUnix) < nowS - 5) {
                wf.enqueue(`settle:${o.id}:${JSON.parse(o.coin).txid}`, "settle", o.market_id, { offerId: o.id });
            }
        }
        this.planMatches(offers);
        this.planCancels(offers);
        this.planReprices(offers, nowS);
        this.retryLpBootstraps(nowS);
        this.retryActivations(nowS);
        this.planLpBootstraps(nowS);
        this.planLpBids(offers, nowS);
        await this.planOwnRedemptions(offers);
        const boxes = await this.boxCoins();
        this.planRenewals(offers, nowS, boxes);
        for (const b of boxes) {
            const m = getMarket(db, b.box.market_id);
            if (m?.vault_phase === "resolved" && b.coin.assets?.length) {
                wf.enqueue(`autoclaim:${b.coin.txid}:${b.coin.vout}`, "autoclaim", m.id, { box: b.box.script, outpoint: `${b.coin.txid}:${b.coin.vout}` });
            }
        }
    }

    /** One indexer read for every watched box. */
    private async boxCoins() {
        const boxes = watchedBoxes(this.d.db);
        if (boxes.length === 0) return [];
        const { vtxos } = await this.d.net.indexer.getVtxos({ scripts: boxes.map((b) => b.script), spendableOnly: true });
        return vtxos.filter((v) => !v.isSpent).map((v) => ({
            box: boxes.find((b) => b.script === v.script)!,
            coin: { txid: v.txid, vout: v.vout, value: v.value, assets: v.assets, expiresAt: v.expiresAt },
        }));
    }

    private planMatches(offers: ReturnType<typeof openOffers>): void {
        const byMarket = new Map<string, Bid[]>();
        for (const o of offers) if (o.side === "buy" && o.coin) byMarket.set(o.market_id, [...(byMarket.get(o.market_id) ?? []), asBid(o)]);
        for (const [marketId, bids] of byMarket) {
            const m = getMarket(this.d.db, marketId);
            const terms = m && marketTerms(m);
            if (!m || !terms || m.vault_phase !== "open" || m.status !== "open" || m.vault_value === null) continue;
            const room = (terms.capSats - BigInt(m.vault_value)) / terms.unitSats;
            const pair = room > 0n ? bestMintMatch(bids, terms.unitSats, room) : undefined;
            if (!pair) continue;
            this.d.wf.enqueue(`match:${pair.yes.txid}:${pair.no.txid}`, "mint-match", marketId, { yes: pair.yes.id, no: pair.no.id, qty: pair.qty.toString() });
        }
    }

    private planCancels(offers: ReturnType<typeof openOffers>): void {
        const lp = this.d.lp && hex.encode(this.d.lp.script);
        if (!lp) return;
        for (const o of offers) {
            if (o.maker_script !== lp || getMarket(this.d.db, o.market_id)?.status !== "halted") continue;
            this.d.wf.enqueue(`cancel:${o.id}`, "cancel-offer", o.market_id, { offerId: o.id });
        }
    }

    /** Moves LP asks on mirrored markets to the refreshed source odds once they drift by REPRICE_BPS of the unit. */
    /** A bootstrap that failed (usually an underfunded LP) is enqueued again; Workflows re-arms it after a widening cooldown. */
    private retryLpBootstraps(nowS: number): void {
        const failed = all<{ id: string; market_id: string }>(this.d.db,
            "SELECT id, market_id FROM workflows WHERE kind = 'lp-liquidity' AND state = 'failed' AND id LIKE '%:bootstrap' AND market_id IS NOT NULL");
        for (const wf of failed) {
            const m = getMarket(this.d.db, wf.market_id);
            if (m?.status === "open" && quotesUntil(m) - nowS >= LP_MIN_WINDOW_SECONDS && this.lpWanted(m)) this.d.wf.enqueue(wf.id, "lp-liquidity", wf.market_id, {});
        }
    }

    /**
     * Activation is enqueued once, at import, so one that failed on an underfunded operator would never resume.
     * Only funding and timing failures come back; an audit refusal would only fail the same way again.
     */
    private retryActivations(nowS: number): void {
        const failed = all<{ id: string; market_id: string; error: string | null }>(this.d.db,
            "SELECT id, market_id, error FROM workflows WHERE kind = 'activate' AND state = 'failed' AND market_id IS NOT NULL");
        for (const wf of failed) {
            if (!RETRYABLE_ACTIVATION.test(wf.error ?? "")) continue;
            const m = getMarket(this.d.db, wf.market_id);
            if (m?.status === "activating" && m.close_at - nowS > LP_MIN_WINDOW_SECONDS) this.d.wf.enqueue(wf.id, "activate", wf.market_id, {});
        }
    }

    /** With LP_BUSY_ONLY, a mirrored market whose refreshed volume turns busy gets the bootstrap activation withheld. */
    private planLpBootstraps(nowS: number): void {
        if (!this.d.cfg.LP_BUSY_ONLY || this.d.cfg.LP_BOOTSTRAP_SETS <= 0 || !this.d.lp) return;
        for (const m of all<MarketRow>(this.d.db, "SELECT * FROM markets WHERE kind = 'polymarket' AND status = 'open' AND terms IS NOT NULL AND source_snapshot IS NOT NULL")) {
            const terms = marketTerms(m);
            if (!terms || this.d.wf.get(`lp:${m.id}:bootstrap`) || quotesUntil(m) - nowS < LP_MIN_WINDOW_SECONDS || !this.lpWanted(m)) continue;
            this.enqueueLpBootstrap(m, terms.unitSats);
        }
    }

    private planReprices(offers: ReturnType<typeof openOffers>, nowS: number): void {
        const lp = this.d.lp && hex.encode(this.d.lp.script);
        if (!lp) return;
        for (const o of offers) {
            if (o.maker_script !== lp || !o.coin) continue;
            const m = getMarket(this.d.db, o.market_id);
            const terms = m && marketTerms(m);
            if (!m || !terms || m.kind !== "polymarket" || m.oracle_policy === "redstone" || m.status !== "open" || m.close_at - nowS < LP_MIN_WINDOW_SECONDS || !m.source_snapshot) continue;
            if (o.side === "buy" && !bidQuotable(m, Date.now())) continue;
            const ref = JSON.parse(m.source_snapshot).referencePrices;
            const outcome = o.outcome as "yes" | "no";
            const none = { yes: 0n, no: 0n };
            const target = o.side === "sell"
                ? lpAsks(ref, JSON.parse(m.outcomes) as string[], terms.unitSats, none)[outcome]
                : (lpBids(ref, JSON.parse(m.outcomes) as string[], terms.unitSats) ?? none)[outcome];
            const price = BigInt((JSON.parse(o.terms) as OfferTermsJson).priceSats);
            const gap = target > price ? target - price : price - target;
            const legacy = !!(JSON.parse(o.terms) as OfferTermsJson).legacy;
            if (target === 0n || (!legacy && gap * 10_000n < terms.unitSats * REPRICE_BPS) || BigInt(o.remaining) * target < MIN_BET_SATS) continue;
            // Quotes move one at a time: wait for the LP's other quotes to move rather than cross them.
            if (crossesLp(offers, lp, { id: o.id, marketId: o.market_id, outcome, side: o.side, price: target }, terms.unitSats)) continue;
            this.d.wf.enqueue(`reprice:${o.id}`, "lp-reprice", o.market_id, { offerId: o.id, price: target.toString() });
        }
    }

    /** One bid per outcome on each wanted mirror, so holders can sell back before resolution; re-armed after a failure. */
    private planLpBids(offers: ReturnType<typeof openOffers>, nowS: number): void {
        const lp = this.d.lp && hex.encode(this.d.lp.script);
        if (!lp) return;
        // A bid priced from a stale or decided source would buy losing shares from anyone who knows better.
        for (const o of offers) {
            if (o.maker_script !== lp || o.side !== "buy" || !o.coin) continue;
            const m = getMarket(this.d.db, o.market_id);
            if (m?.status === "open" && !bidQuotable(m, Date.now())) this.d.wf.enqueue(`cancel:${o.id}:unquotable`, "cancel-offer", o.market_id, { offerId: o.id });
        }
        if (!(this.d.cfg.LP_BID_SETS > 0)) return;
        const busyLp = new Set(all<{ market_id: string }>(this.d.db,
            "SELECT market_id FROM workflows WHERE kind IN ('lp-liquidity', 'lp-reprice') AND state IN ('pending', 'submitting') AND market_id IS NOT NULL").map((r) => r.market_id));
        for (const m of all<MarketRow>(this.d.db, "SELECT * FROM markets WHERE kind = 'polymarket' AND status = 'open' AND terms IS NOT NULL AND source_snapshot IS NOT NULL AND oracle_policy IS NOT 'redstone'")) {
            const terms = marketTerms(m);
            const done = this.d.wf.get(`lp:${m.id}:bids`)?.state;
            if (!terms || (done && done !== "failed") || quotesUntil(m) - nowS < LP_MIN_WINDOW_SECONDS || !this.lpWanted(m)) continue;
            if (busyLp.has(m.id) || !bidQuotable(m, Date.now())) continue;
            const bids = lpBids(JSON.parse(m.source_snapshot!).referencePrices, JSON.parse(m.outcomes) as string[], terms.unitSats);
            if (!bids || (["yes", "no"] as const).some((outcome) => crossesLp(offers, lp, { marketId: m.id, outcome, side: "buy", price: bids[outcome] }, terms.unitSats))) continue;
            this.d.wf.enqueue(`lp:${m.id}:bids`, "lp-liquidity", m.id, { side: "buy", sets: String(this.d.cfg.LP_BID_SETS), yesBid: String(bids.yes), noBid: String(bids.no) });
        }
    }

/** Our own wallets' leftover YES/NO (seed set, unsold LP shares) are redeemed once the market resolves. */
    private async planOwnRedemptions(offers: ReturnType<typeof openOffers>): Promise<void> {
        const parties = ([["operator", this.d.operator], ["lp", this.d.lp]] as const).filter((x): x is readonly ["operator" | "lp", Party] => !!x[1]);
        if (parties.length === 0) return;
        const since = new Date(Date.now() - OWN_REDEEM_WINDOW_MS).toISOString();
        const resolved = all<MarketRow>(this.d.db, "SELECT * FROM markets WHERE vault_phase = 'resolved' AND vault_outcome IS NOT NULL AND updated_at > ?", since);
        if (resolved.length === 0) return;
        const held = new Map<string, Set<string>>();
        for (const [who, party] of parties) {
            const ids = new Set((await party.coins()).flatMap((c) => (c.assets ?? []).filter((x) => x.amount > 0n).map((x) => x.assetId)));
            held.set(who, ids);
        }
        const lpScript = this.d.lp && hex.encode(this.d.lp.script);
        for (const m of resolved) {
            const terms = marketTerms(m);
            if (!terms) continue;
            for (const [who] of parties) {
                const id = `redeem:${m.id}:${who}`;
                if (this.d.wf.get(id)) continue;
                // An LP offer still open on this market returns its shares first, through the settle workflow.
                if (who === "lp" && offers.some((o) => o.market_id === m.id && o.maker_script === lpScript)) continue;
                const ids = held.get(who)!;
                if (ids.has(terms.assets.yes) || ids.has(terms.assets.no)) this.d.wf.enqueue(id, "redeem-own", m.id, { who });
            }
        }
    }

    private planRenewals(offers: ReturnType<typeof openOffers>, nowS: number, boxes: Awaited<ReturnType<Keeper["boxCoins"]>>): void {
        const horizon = nowS + this.d.cfg.RENEW_THRESHOLD_SECONDS;
        const due: { kind: "vault" | "offer" | "box"; id: string; outpoint: string }[] = [];
        for (const b of boxes) {
            if (b.coin.expiresAt && b.coin.expiresAt.getTime() / 1000 < horizon) due.push({ kind: "box", id: b.box.script, outpoint: `${b.coin.txid}:${b.coin.vout}` });
        }
        for (const m of all<MarketRow>(this.d.db, "SELECT * FROM markets WHERE vault_outpoint IS NOT NULL AND vault_expires_at IS NOT NULL")) {
            if (Date.parse(m.vault_expires_at!) / 1000 < horizon) due.push({ kind: "vault", id: m.id, outpoint: m.vault_outpoint! });
        }
        for (const o of offers) {
            const c: CoinJson | null = o.coin ? JSON.parse(o.coin) : null;
            const exp = c?.expiresAt;
            if (c && exp && Date.parse(exp) / 1000 < horizon) due.push({ kind: "offer", id: o.id, outpoint: `${c.txid}:${c.vout}` });
        }
        if (due.length === 0) return;
        const key = sha256Hex(due.map((x) => x.outpoint).sort().join(",")).slice(0, 24);
        this.d.wf.enqueue(`renew:${key}`, "renew", null, { targets: due.slice(0, 32) });
    }

    async execute(wf: Workflow): Promise<void> {
        try {
            if (wf.state === "submitting") {
                await this.finalizePending(wf);
                const r = await reconcileSubmission(this.d, wf.txid, (wf.payload.inputs as string[] | undefined) ?? []);
                this.d.log("reconciled in-flight workflow", { id: wf.id, outcome: r });
                if (r === "unknown") return void this.d.wf.transition(wf, "submitting", { nextAt: Date.now() + backoffMs(wf.attempts), attempt: true });
                if (r === "landed" && !MULTI_STEP.has(wf.kind)) return void this.finish(this.d.wf.transition(wf, "done", { error: null }));
                // `lost` (another tx spent our inputs) rebuilds rather than gives up; a landed multi-step tx is
                // recorded under its step's field so the handler resumes at the next one.
                const step = r === "landed" ? (wf.payload.step as string | undefined) : undefined;
                wf = this.d.wf.transition(wf, "pending", {
                    payload: { ...(step ? { [step]: wf.txid } : {}), step: null, inputs: null, finalCheckpoints: null },
                    txid: null, error: r === "lost" ? "inputs spent by another transaction" : null, attempt: r === "lost",
                });
            }
            const txid = await this.handle(wf);
            maybeCrash(this.d.cfg, "after-submit", wf.kind);
            const latest = this.d.wf.get(wf.id)!;
            this.finish(this.d.wf.transition(latest, "done", { txid: txid ?? latest.txid, error: null }));
        } catch (err) {
            const latest = this.d.wf.get(wf.id)!;
            const message = err instanceof Error ? err.message : String(err);
            const permanent = /does not cross|already|covenant|spent|expired|no claims/i.test(message) && latest.state === "pending";
            this.d.log("workflow attempt failed", { id: wf.id, state: latest.state, error: message });
            // A submission in flight only ever settles through reconciliation: failing it lets a re-arm submit twice.
            if (latest.state !== "submitting" && (permanent || latest.attempts >= 8)) this.d.wf.transition(latest, "failed", { error: message, attempt: true });
            else this.d.wf.transition(latest, latest.state, { error: message, nextAt: Date.now() + backoffMs(latest.attempts), attempt: true });
        }
    }

    /** arkd spends the inputs on submission but creates the outputs on finalize: until then the value is stranded. */
    private async finalizePending(wf: Workflow): Promise<void> {
        const checkpoints = wf.payload.finalCheckpoints as string[] | undefined;
        if (!wf.txid || !checkpoints?.length) return;
        await this.d.net.arkProvider.finalizeTx(wf.txid, checkpoints).then(
            () => this.d.log("finalized an interrupted submission", { id: wf.id, txid: wf.txid }),
            (e) => this.d.log("could not finalize an interrupted submission", { id: wf.id, txid: wf.txid, error: String(e) }),
        );
    }

    private mark(wf: Workflow, patch: Record<string, unknown>): void {
        this.d.wf.transition(this.d.wf.get(wf.id)!, "pending", { payload: patch, txid: null });
    }

    private finish(wf: Workflow): void {
        this.d.bus.publish("workflow", wf.marketId, { id: wf.id, kind: wf.kind, state: wf.state, txid: wf.txid });
    }

    /** Ctx whose write-ahead hook records the txid and spent outpoints before anything is submitted. */
    private ctxFor(wf: Workflow): Ctx {
        let current = wf;
        return {
            ...this.d.net.ctx,
            beforeSubmit: ({ txid, inputs }) => {
                current = this.d.wf.transition(this.d.wf.get(current.id)!, "submitting", { txid, payload: { inputs } });
                maybeCrash(this.d.cfg, "before-submit", current.kind);
            },
            beforeFinalize: ({ txid, checkpoints }) => {
                current = this.d.wf.transition(this.d.wf.get(current.id)!, "submitting", { txid, payload: { finalCheckpoints: checkpoints } });
                maybeCrash(this.d.cfg, "before-finalize", current.kind);
            },
        };
    }

    private async handle(wf: Workflow): Promise<string | undefined> {
        const ctx = this.ctxFor(wf);
        const market = wf.marketId ? getMarket(this.d.db, wf.marketId) : undefined;
        const terms = market && marketTerms(market);
        switch (wf.kind) {
            case "resolve": {
                const q = terms && quorums(this.d.db, wf.marketId!, terms)[0];
                if (!q || !terms) throw new Error("attestation quorum or market not found");
                const { txid } = await resolveMarket(ctx, terms, q.outcome, hex.decode(q.evidence), q.signatures);
                run(this.d.db, "UPDATE markets SET resolution_status = 'resolved', resolution_detail = ?, updated_at = ? WHERE id = ?", `resolved ${q.outcome} in ${txid}`, now(), wf.marketId);
                return txid;
            }
            case "redeem-own": {
                const party = wf.payload.who === "lp" ? this.d.lp : this.d.operator;
                const outcome = market?.vault_outcome as "yes" | "no" | "invalid" | null;
                if (!party || !terms || !outcome) throw new Error("own wallet or resolved market not found");
                const r = await redeemAll(ctx, party, terms, outcome).catch((e: unknown) => {
                    if (String(e).includes("no claims to redeem")) return undefined;
                    throw e;
                });
                if (r) this.d.log("redeemed own claims", { market: market!.id, who: wf.payload.who, payout: r.payout.toString() });
                return r?.txid;
            }
            case "resolve-price": {
                const rounds = terms && signedRounds(this.d.db, terms);
                if (!rounds || !terms) throw new Error("captured RedStone rounds or market not found");
                const { txid, outcome } = await resolvePriceMarket(ctx, terms, rounds.end, rounds.start);
                run(this.d.db, "UPDATE markets SET resolution_status = 'resolved', resolution_detail = ?, updated_at = ? WHERE id = ?",
                    `resolved ${outcome === "yes" ? "Up" : "Down"} on RedStone rounds in ${txid}`, now(), wf.marketId);
                return txid;
            }
            case "timeout": {
                if (!terms) throw new Error("market not found");
                const { txid } = await timeoutMarket(ctx, terms);
                run(this.d.db, "UPDATE markets SET resolution_status = 'timeout', resolution_detail = ?, updated_at = ? WHERE id = ?", `timed out to 50/50 in ${txid}`, now(), wf.marketId);
                return txid;
            }
            case "settle": {
                const offer = await refreshOffer(this.d, wf.payload.offerId as string);
                if (offer.status !== "open" || !offer.coin) return undefined;
                return (await settleExpiredOffer(ctx, { terms: offerTermsFromJson(offer.terms), coin: coinFromJson(offer.coin) })).txid;
            }
            case "cancel-offer": {
                const lp = this.d.lp;
                if (!lp) throw new Error("LP wallet not configured");
                const offer = await refreshOffer(this.d, wf.payload.offerId as string);
                if (offer.status !== "open" || !offer.coin) return undefined;
                return (await cancelOffer(ctx, lp, { terms: offerTermsFromJson(offer.terms), coin: coinFromJson(offer.coin) })).txid;
            }
            case "mint-match": {
                if (!terms) throw new Error("market not found");
                const [yes, no] = await Promise.all([refreshOffer(this.d, wf.payload.yes as string), refreshOffer(this.d, wf.payload.no as string)]);
                if (yes.status !== "open" || no.status !== "open" || !yes.coin || !no.coin) throw new Error("bids already gone");
                const live = (o: typeof yes): LiveOffer => ({ terms: offerTermsFromJson(o.terms), coin: coinFromJson(o.coin!) });
                const qty = [BigInt(wf.payload.qty as string), BigInt(yes.remaining), BigInt(no.remaining)].reduce((a, b) => (a < b ? a : b));
                if (qty <= 0n) throw new Error("bids already filled");
                // A fill shrunk by a refresh can fall under a bid's min fill; re-plan instead of being refused.
                for (const o of [yes, no]) if (!bidTakes(asBid(getOffer(this.d.db, o.id)!), qty)) throw new Error("fill below the bid's min fill");
                const { txid } = await mintMatch(ctx, terms, live(yes), live(no), qty, this.d.keeperScript);
                for (const o of [yes, no]) {
                    recordTrade(this.d.db, { txid, offerId: o.id, marketId: o.marketId, outcome: o.outcome, kind: "mint-match", makerSide: "buy", qty, priceSats: o.terms.priceSats });
                }
                await Promise.all([refreshOffer(this.d, yes.id), refreshOffer(this.d, no.id)]);
                return txid;
            }
            case "renew":
                return this.renew(wf);
            case "autoclaim": {
                const b = all<{ market_id: string; owner: string; owner_script: string }>(this.d.db, "SELECT * FROM boxes WHERE script = ?", wf.payload.box as string)[0];
                if (!b || !terms || !market?.vault_outcome) throw new Error("box or resolved market not found");
                const [txid, vout] = (wf.payload.outpoint as string).split(":");
                const { vtxos } = await this.d.net.indexer.getVtxos({ outpoints: [{ txid: txid!, vout: Number(vout) }] });
                const v = vtxos[0];
                if (!v || v.isSpent) return undefined;
                const owner = { owner: hex.decode(b.owner), ownerScript: hex.decode(b.owner_script) };
                const res = await autoClaim(ctx, terms, market.vault_outcome, owner, { txid: v.txid, vout: v.vout, value: v.value, assets: v.assets });
                run(this.d.db, "UPDATE boxes SET status = 'claimed', updated_at = ? WHERE script = ?", now(), wf.payload.box as string);
                this.d.bus.publish("resolution", market.id, { box: wf.payload.box, payout: res.payout.toString(), txid: res.txid });
                return res.txid;
            }
            case "lp-liquidity":
                return this.liquidity(wf, ctx);
            case "lp-reprice":
                return this.reprice(wf, ctx);
            case "activate":
                return this.activate(wf, ctx);
            default:
                throw new Error(`unknown workflow kind ${wf.kind}`);
        }
    }

    private async renew(wf: Workflow): Promise<string | undefined> {
        const targets: RenewTarget[] = [];
        for (const t of wf.payload.targets as { kind: string; id: string; outpoint: string }[]) {
            const [txid, vout] = t.outpoint.split(":");
            const { vtxos } = await this.d.net.indexer.getVtxos({ outpoints: [{ txid: txid!, vout: Number(vout) }] });
            const v = vtxos[0];
            if (!v || v.isSpent) continue;
            const coin = { txid: v.txid, vout: v.vout, value: v.value, assets: v.assets, isSwept: v.isSwept };
            if (t.kind === "vault") {
                const m = getMarket(this.d.db, t.id);
                const terms = m && marketTerms(m);
                if (!terms) continue;
                const { vault, resolved } = marketContracts(this.d.net.ark, terms);
                const contract = [vault, resolved.yes, resolved.no, resolved.invalid].find((c) => hex.encode(c.pkScript) === v.script);
                if (contract) targets.push({ coin, contract });
            } else if (t.kind === "box") {
                const b = all<{ market_id: string; owner: string; owner_script: string }>(this.d.db, "SELECT * FROM boxes WHERE script = ?", t.id)[0];
                const m = b && getMarket(this.d.db, b.market_id);
                const terms = m && marketTerms(m);
                if (b && terms) targets.push({ coin, contract: claimBoxContract(this.d.net.ark, terms, { owner: hex.decode(b.owner), ownerScript: hex.decode(b.owner_script) }) });
            } else {
                const o = all<{ terms: string }>(this.d.db, "SELECT terms FROM offers WHERE id = ?", t.id)[0];
                if (o) targets.push({ coin, contract: offerContract(this.d.net.ark, offerTermsFromJson(JSON.parse(o.terms))) });
            }
        }
        if (targets.length === 0) return undefined;
        this.d.wf.transition(this.d.wf.get(wf.id)!, "submitting", { payload: { inputs: targets.map((t) => `${t.coin.txid}:${t.coin.vout}`) } });
        const { commitmentTxid } = await renewCovenantVtxos(
            { ark: this.d.net.arkProvider, emulator: this.d.net.emulator, indexer: this.d.net.indexer, network: networks[this.d.cfg.APM_NETWORK] },
            targets,
            SingleKey.fromRandomBytes().signerSession(),
            { signal: AbortSignal.timeout(RENEW_DEADLINE_MS) },
        );
        this.d.log("renewed covenant vtxos", { commitmentTxid, count: targets.length });
        return commitmentTxid;
    }

    /** Each offer's terms are stored before it is funded: the jittered expiry is part of its script. */
    private async liquidity(wf: Workflow, ctx: Ctx): Promise<string | undefined> {
        const lp = this.d.lp;
        const market = wf.marketId ? getMarket(this.d.db, wf.marketId) : undefined;
        const terms = market && marketTerms(market);
        if (!lp || !terms || !market) throw new Error("LP wallet or market not found");
        const nowS = Math.floor(Date.now() / 1000);
        const until = quotesUntil(market);
        if (market.status !== "open" || until - nowS < LP_MIN_WINDOW_SECONDS) return undefined;
        const p = wf.payload as Record<string, unknown>;
        const sets = BigInt(p.sets as string);
        const side = p.side === "buy" ? "buy" : "sell";
        if (side === "sell" && !p.minted) {
            this.mark(wf, { step: "minted" });
            const { txid } = await mintSets(ctx, lp, terms, sets);
            this.mark(wf, { minted: txid, step: null, inputs: null, finalCheckpoints: null });
        }
        const lpKey = await lp.identity.xOnlyPublicKey();
        for (const outcome of ["yes", "no"] as const) {
            const price = BigInt(p[`${outcome}${side === "buy" ? "Bid" : "Ask"}`] as string);
            const tk = `${outcome}Terms`;
            const fk = `${outcome}FundingTxid`;
            // Same price band registerOffer enforces: a price it would reject must not fund an offer first.
            if (price <= 0n || price >= terms.unitSats || sets * price < MIN_BET_SATS || p[`${outcome}Registered`]) continue;
            // Terms written before a failed attempt keep their expiry and price; re-derive them if either has moved and nothing is funded yet.
            const stale = (t: unknown) => !t || BigInt((t as OfferTermsJson).expiresAtUnix) <= BigInt(nowS + LP_MIN_WINDOW_SECONDS) || (t as OfferTermsJson).priceSats !== String(price);
            if (!p[fk] && stale(p[tk])) {
                p[tk] = offerTermsToJson({
                    side, maker: lpKey, makerScript: lp.script, assetId: terms.assets[outcome], priceSats: price,
                    minFill: minFillFor(price), expiresAt: lpExpiry(quotesUntil(market), nowS), reserveSats: 330n, exitDelaySeconds: this.d.net.exitDelaySeconds,
                });
                this.mark(wf, { [tk]: p[tk] });
            }
            const offerTerms = offerTermsFromJson(p[tk] as OfferTermsJson);
            if (!p[fk] && side === "buy") {
                // Checked again at funding time: other LP quotes on this market may have moved since this was planned.
                const fresh = getMarket(this.d.db, market.id)!;
                if (!bidQuotable(fresh, Date.now())) return undefined;
                if (crossesLp(openOffers(this.d.db), hex.encode(lp.script), { marketId: market.id, outcome, side, price }, terms.unitSats)) throw new Error("bid would cross the LP's own quote; retrying later");
            }
            if (!p[fk]) {
                if (side === "sell") await waitForAsset(lp, offerTerms.assetId, sets);
                this.mark(wf, { step: fk });
                const { txid } = await postOffer(ctx, lp, offerTerms, sets);
                p[fk] = txid;
                this.mark(wf, { [fk]: txid, step: null, inputs: null, finalCheckpoints: null });
            }
            await waitForCoin(this, offerContract(this.d.net.ark, offerTerms).pkScript, p[fk] as string);
            // registerOffer answers 409 for an offer it already holds, which is exactly what a retry wants.
            await registerOffer(this.d, { marketId: market.id, terms: p[tk] as OfferTermsJson, fundingTxid: p[fk] as string })
                .catch((e: unknown) => {
                    if (!isDuplicate(e)) throw e;
                });
            this.mark(wf, { [`${outcome}Registered`]: true });
        }
        return undefined;
    }

    /** Cancels one LP quote and re-posts what was left of it at the new price. */
    private async reprice(wf: Workflow, ctx: Ctx): Promise<string | undefined> {
        const lp = this.d.lp;
        const market = wf.marketId ? getMarket(this.d.db, wf.marketId) : undefined;
        const terms = market && marketTerms(market);
        if (!lp || !market || !terms) throw new Error("LP wallet or market not found");
        const p = wf.payload as Record<string, unknown>;
        if (!p.cancelled) {
            const offer = await refreshOffer(this.d, p.offerId as string);
            // A leftover too small to re-post stays on the book at the old price rather than leave it.
            if (offer.status !== "open" || !offer.coin || BigInt(offer.remaining) * BigInt(p.price as string) < MIN_BET_SATS) return undefined;
            const old = offerTermsFromJson(offer.terms);
            this.mark(wf, { qty: offer.remaining, assetId: old.assetId, side: old.side, step: "cancelled" });
            const { txid } = await cancelOffer(ctx, lp, { terms: old, coin: coinFromJson(offer.coin) });
            this.mark(wf, { cancelled: txid, step: null, inputs: null, finalCheckpoints: null });
            Object.assign(p, { qty: offer.remaining, assetId: old.assetId, side: old.side, cancelled: txid });
        }
        const side = p.side === "buy" ? "buy" : "sell";
        const nowS = Math.floor(Date.now() / 1000);
        if (market.status !== "open" || market.close_at - nowS < LP_MIN_WINDOW_SECONDS) return undefined;
        const qty = BigInt(p.qty as string);
        if (!p.funded && (!p.terms || BigInt((p.terms as OfferTermsJson).expiresAtUnix) <= BigInt(nowS + LP_MIN_WINDOW_SECONDS))) {
            p.terms = offerTermsToJson({
                side, maker: await lp.identity.xOnlyPublicKey(), makerScript: lp.script, assetId: p.assetId as string, priceSats: BigInt(p.price as string),
                minFill: minFillFor(BigInt(p.price as string)), expiresAt: lpExpiry(quotesUntil(market), nowS), reserveSats: 330n, exitDelaySeconds: this.d.net.exitDelaySeconds,
            });
            this.mark(wf, { terms: p.terms });
        }
        const offerTerms = offerTermsFromJson(p.terms as OfferTermsJson);
        if (!p.funded) {
            if (side === "sell") await waitForAsset(lp, offerTerms.assetId, qty);
            this.mark(wf, { step: "funded" });
            const { txid } = await postOffer(ctx, lp, offerTerms, qty);
            p.funded = txid;
            this.mark(wf, { funded: txid, step: null, inputs: null, finalCheckpoints: null });
        }
        await waitForCoin(this, offerContract(this.d.net.ark, offerTerms).pkScript, p.funded as string);
        await registerOffer(this.d, { marketId: market.id, terms: p.terms as OfferTermsJson, fundingTxid: p.funded as string })
            .catch((e: unknown) => {
                if (!isDuplicate(e)) throw e;
            });
        return p.funded as string;
    }

    /** Operator genesis for an admitted imported market: T0 (assets), T1 (vault), then open trading. */
    private async activate(wf: Workflow, ctx: Ctx): Promise<string | undefined> {
        const operator = this.d.operator;
        const market = wf.marketId ? getMarket(this.d.db, wf.marketId) : undefined;
        if (!operator || !market) throw new Error("operator wallet or market missing");
        const updown = market.oracle_policy === "redstone" ? (JSON.parse(market.source_snapshot!).updown as UpDownRounds) : undefined;
        if (!updown && this.d.cfg.ORACLE_PUBKEYS.length === 0) throw new Error("ORACLE_PUBKEYS is empty");
        const oracleKeys = updown ? [] : oracleSlots(this.d.cfg.ORACLE_PUBKEYS.map((k) => hex.decode(k)), this.d.cfg.ORACLE_THRESHOLD);
        const oracleThreshold = updown ? PRICE_QUORUM : this.d.cfg.ORACLE_THRESHOLD;
        let p = wf.payload as { genesisTxid?: string; vaultTxid?: string; inputs?: string[]; signers?: string[] };
        // The signer set fixes the vault address, so it is chosen once and kept across retries.
        if (updown && !p.signers) {
            const keys = [...new Set((await latestPackages(updown.feed)).map((pkg) => hex.encode(packageSignerKey(pkg))))].sort();
            if (keys.length !== PRICE_SIGNER_SLOTS) throw new Error(`RedStone serves ${keys.length} signers for ${updown.feed}, expected ${PRICE_SIGNER_SLOTS}`);
            if (keys.some((key) => !REDSTONE_PRIMARY_SIGNERS.includes(key))) throw new Error("RedStone serves a signer outside the pinned primary-prod set; update REDSTONE_PRIMARY_SIGNERS");
            this.mark(wf, { signers: keys });
            p = { ...p, signers: keys };
        }
        if (!p.genesisTxid) {
            this.mark(wf, { step: "genesisTxid" });
            const { genesisTxid } = await issueMarketAssets(ctx, operator, market.id, 1n);
            this.mark(wf, { genesisTxid, step: null, inputs: null, finalCheckpoints: null });
            p = { ...p, genesisTxid };
        }
        const definition: MarketDefinition = {
            question: market.question, rules: market.rules, outcomes: JSON.parse(market.outcomes), category: market.category,
            closeAtUnix: String(market.close_at), timeoutAtUnix: String(market.timeout_at), source: JSON.parse(market.source_snapshot!).binding,
        };
        const assets = { ctrl: assetIdOf(p.genesisTxid!, 0), yes: assetIdOf(p.genesisTxid!, 1), no: assetIdOf(p.genesisTxid!, 2) };
        const unit = BigInt(this.d.cfg.MARKET_UNIT_SATS);
        const price: PriceTerms | undefined = updown && {
            kind: "updown", feedId: feedIdBytes(updown.feed), startAtMs: BigInt(updown.startAtMs), endAtMs: BigInt(updown.endAtMs),
            signers: p.signers!.map((k) => hex.decode(k)), quorum: PRICE_QUORUM,
        };
        // Price vaults check no attestation, so their binding only records what was funded.
        const binding = price
            ? sha256(new TextEncoder().encode(JSON.stringify({ market: market.id, definitionHash: market.definition_hash, signers: p.signers, updown })))
            : bindingOf({
                network: this.d.cfg.APM_NETWORK, arkSigner: this.d.net.ark.serverKey, emulatorSigner: this.d.net.ark.emulatorKey!,
                marketId: market.id, definition, unitSats: unit, assets, oracleKeys: oracleKeys.map((k) => hex.encode(k)), oracleThreshold, oracleEpoch: this.d.cfg.ORACLE_EPOCH,
            });
        const terms: VaultTerms = {
            assets, unitSats: unit, capSats: BigInt(this.d.cfg.MARKET_BASE_SATS) + unit * BigInt(this.d.cfg.MARKET_CAP_SETS),
            oracleKeys, oracleThreshold, binding, closeAt: BigInt(market.close_at), timeoutAt: BigInt(market.timeout_at),
            exitDelaySeconds: this.d.net.exitDelaySeconds, ...(price ? { price } : {}),
        };
        if (!p.vaultTxid) {
            await waitForAsset(operator, assets.ctrl, 1n);
            this.mark(wf, { step: "vaultTxid" });
            const { txid } = await openVault(ctx, operator, terms, 1n, BigInt(this.d.cfg.MARKET_BASE_SATS));
            this.mark(wf, { vaultTxid: txid, step: null, inputs: null, finalCheckpoints: null });
            p = { ...p, vaultTxid: txid };
        }
        const { baseSats } = await auditGenesis(this.d.net, terms, p.genesisTxid!, p.vaultTxid!);
        run(this.d.db, "UPDATE markets SET status = 'open', terms = ?, base_sats = ?, genesis_txid = ?, vault_txid = ?, oracle_keys = ?, oracle_threshold = ?, oracle_epoch = ?, updated_at = ? WHERE id = ? AND status = 'activating'",
            JSON.stringify(termsToJson(terms)), String(baseSats), p.genesisTxid!, p.vaultTxid!, JSON.stringify(p.signers ?? oracleKeys.map((k) => hex.encode(k))), oracleThreshold, this.d.cfg.ORACLE_EPOCH, now(), market.id);
        this.d.bus.publish("market", market.id, { status: "open" });
        if (this.d.cfg.LP_BOOTSTRAP_SETS > 0 && this.d.lp && this.lpWanted(market)) this.enqueueLpBootstrap(market, unit);
        return p.vaultTxid;
    }

    private lpWanted(m: MarketRow): boolean {
        return !this.d.cfg.LP_BUSY_ONLY || (!!m.source_snapshot && isBusy(JSON.parse(m.source_snapshot)));
    }

    private enqueueLpBootstrap(m: MarketRow, unit: bigint): void {
        const ref = m.source_snapshot ? JSON.parse(m.source_snapshot).referencePrices : null;
        const asks = lpAsks(ref, JSON.parse(m.outcomes) as string[], unit, { yes: BigInt(this.d.cfg.LP_ASK_YES_SATS), no: BigInt(this.d.cfg.LP_ASK_NO_SATS) });
        this.d.wf.enqueue(`lp:${m.id}:bootstrap`, "lp-liquidity", m.id, {
            sets: String(this.d.cfg.LP_BOOTSTRAP_SETS), yesAsk: String(asks.yes), noAsk: String(asks.no),
        });
    }

    get db(): Db {
        return this.d.db;
    }

    get deps(): KeeperDeps {
        return this.d;
    }
}

const isDuplicate = (e: unknown) =>
    (e as { code?: string }).code === "duplicate" || /duplicate|identical live offer/i.test(String(e));

/** An LP quote dies with its market. The jitter varies the script so a re-post is not seen as a duplicate. */
export function lpExpiry(closeAt: number, nowS: number, jitter = Math.random()): bigint {
    const span = Math.min(3600, Math.max(1, Math.floor((closeAt - nowS) / 2)));
    return BigInt(closeAt - Math.floor(jitter * span));
}

interface Bid {
    id: string;
    outcome: string;
    txid: string;
    price: bigint;
    minFill: bigint;
    reserve: bigint;
    value: bigint;
    remaining: bigint;
    terms: OfferTerms;
}

function asBid(o: { id: string; outcome: string; terms: string; coin: string | null; remaining: string }): Bid {
    const t: OfferTermsJson = JSON.parse(o.terms);
    const c: CoinJson = JSON.parse(o.coin!);
    return {
        id: o.id, outcome: o.outcome, txid: c.txid, price: BigInt(t.priceSats), minFill: BigInt(t.minFill),
        reserve: BigInt(t.reserveSats), value: BigInt(c.valueSats), remaining: BigInt(o.remaining), terms: offerTermsFromJson(t),
    };
}

const bidTakes = (b: Bid, qty: bigint) => fillAllowed(b.terms, { units: 0n, value: b.value }, qty);

/** The best-priced pair can be unfillable (min fill above what the other side absorbs), which stalled matching. */
function bestMintMatch(bids: Bid[], unitSats: bigint, room: bigint): { yes: Bid; no: Bid; qty: bigint } | undefined {
    const side = (outcome: string) =>
        bids.filter((b) => b.outcome === outcome && b.remaining > 0n && !b.terms.legacy).sort((a, b) => Number(b.price - a.price)).slice(0, MATCH_CANDIDATES);
    const nos = side("no");
    for (const yes of side("yes")) {
        for (const no of nos) {
            if (yes.price + no.price < unitSats) break;
            const qty = [yes.remaining, no.remaining, room].reduce((a, b) => (a < b ? a : b));
            if (bidTakes(yes, qty) && bidTakes(no, qty)) return { yes, no, qty };
        }
    }
    return undefined;
}

async function waitForAsset(party: Party, assetId: string, amount: bigint, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const have = (await party.coins()).reduce((s, c) => s + (c.assets ?? []).filter((a) => a.assetId === assetId).reduce((t, a) => t + a.amount, 0n), 0n);
        if (have >= amount) return;
        if (Date.now() > deadline) throw new Error(`asset ${assetId.slice(0, 12)} not visible in wallet`);
        await new Promise((r) => setTimeout(r, 1000));
    }
}

async function waitForCoin(k: Keeper, script: Uint8Array, txid: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const { vtxos } = await k.deps.net.indexer.getVtxos({ scripts: [hex.encode(script)], spendableOnly: true });
        if (vtxos.some((v) => v.txid === txid)) return;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("offer coin not visible");
}

const LP_HALF_SPREAD_BPS = 200n;
// Bids only stand on a fresh, undecided source price: twice the default import interval, and no side at 95% or more.
const BID_MAX_PRICE_AGE_MS = 20 * 60_000;
const BID_MAX_SIDE = 0.95;

export function bidQuotable(m: Pick<MarketRow, "source_snapshot" | "resolution_status">, nowMs: number): boolean {
    if (!m.source_snapshot || m.resolution_status === "source-final") return false;
    const snap = JSON.parse(m.source_snapshot) as { fetchedAt?: string; referencePrices?: { price: string }[] | null };
    const fetched = snap.fetchedAt ? Date.parse(snap.fetchedAt) : NaN;
    if (!(nowMs - fetched <= BID_MAX_PRICE_AGE_MS)) return false;
    return !!snap.referencePrices?.length && snap.referencePrices.every((r) => Number(r.price) < BID_MAX_SIDE);
}
// ponytail: fixed threshold, each reprice costs a cancel and a post; tune per market if the cost matters.
const REPRICE_BPS = 300n;

/** Opening LP asks: the source's reference price plus a half-spread per side, else the configured fixed asks. */
export function lpAsks(ref: { outcome: string; price: string }[] | null | undefined, outcomes: string[], unit: bigint, fallback: { yes: bigint; no: bigint }) {
    const prices = outcomes.map((o) => ref?.find((r) => r.outcome === o)?.price);
    if (prices.length !== 2 || prices.some((x) => x === undefined || !Number.isFinite(Number(x)))) return fallback;
    const ask = (x: string) => {
        const v = BigInt(Math.round(Number(x) * Number(unit))) + (unit * LP_HALF_SPREAD_BPS) / 10_000n;
        return v < 1n ? 1n : v >= unit ? unit - 1n : v;
    };
    const yes = ask(prices[0]!);
    const no = ask(prices[1]!);
    // Asks summing to the unit or less would let anyone buy both legs and merge them for a profit.
    return yes + no > unit ? { yes, no } : fallback;
}

/**
 * LP bids: the source price minus the half-spread, quoted only beside source-priced asks. Bids summing to the
 * unit would let anyone mint a set and sell both legs to the LP, and let the keeper mint-match the LP with itself.
 */
export function lpBids(ref: { outcome: string; price: string }[] | null | undefined, outcomes: string[], unit: bigint): { yes: bigint; no: bigint } | undefined {
    const asks = lpAsks(ref, outcomes, unit, { yes: 0n, no: 0n });
    if (asks.yes === 0n) return undefined;
    const bid = (x: string) => {
        const v = BigInt(Math.round(Number(x) * Number(unit))) - (unit * LP_HALF_SPREAD_BPS) / 10_000n;
        return v < 1n ? 1n : v >= unit ? unit - 1n : v;
    };
    const yes = bid(ref!.find((r) => r.outcome === outcomes[0])!.price);
    const no = bid(ref!.find((r) => r.outcome === outcomes[1])!.price);
    return yes < asks.yes && no < asks.no && yes + no < unit ? { yes, no } : undefined;
}

/** Whether `q` would cross one of the LP's own live quotes: its ask on the same outcome, or its bid on the other. */
function crossesLp(offers: ReturnType<typeof openOffers>, lp: string, q: { id?: string; marketId: string; outcome: string; side: string; price: bigint }, unit: bigint): boolean {
    return offers.some((o) => {
        if (o.id === q.id || o.maker_script !== lp || o.market_id !== q.marketId || !o.coin) return false;
        const t: OfferTermsJson = JSON.parse(o.terms);
        if (t.legacy) return false;
        const price = BigInt(t.priceSats);
        if (o.outcome === q.outcome) return o.side !== q.side && (q.side === "buy" ? q.price >= price : q.price <= price);
        return q.side === "buy" && o.side === "buy" && q.price + price >= unit;
    });
}

type UpDownRounds = { feed: string; startAtMs: number; endAtMs: number };
const PRICE_QUORUM = 3;
// Redemption of our own leftover claims is planned for markets resolved within this window.
const OWN_REDEEM_WINDOW_MS = 3 * 86_400_000;

/** LP quotes stop at the close, or when the market's event starts (an up/down window, a kickoff): nothing reprices them in play. */
function quotesUntil(market: MarketRow): number {
    const snapshot = market.source_snapshot ? JSON.parse(market.source_snapshot) : {};
    const updown = market.oracle_policy === "redstone" ? (snapshot.updown as UpDownRounds | undefined) : undefined;
    if (updown) return Math.floor(updown.startAtMs / 1000);
    const start = typeof snapshot.gameStartTime === "string" ? Math.floor(Date.parse(snapshot.gameStartTime) / 1000) : NaN;
    return start < market.close_at ? start : market.close_at;
}

/** Both captured rounds of an up/down vault, laid out against its signers, once each has a quorum of them. */
function signedRounds(db: Db, terms: VaultTerms) {
    const p = terms.price;
    if (p?.kind !== "updown") return undefined;
    const feed = new TextDecoder().decode(p.feedId).replace(/\0+$/, "");
    const report = (roundMs: bigint) => {
        const pkgs = storedRound(db, feed, Number(roundMs));
        const r = pkgs && priceReport(feed, pkgs, p.signers, roundMs);
        return r && r.signatures.filter((x) => x.length).length >= p.quorum ? r : undefined;
    };
    const start = report(p.startAtMs);
    const end = report(p.endAtMs);
    return start && end ? { start, end } : undefined;
}
