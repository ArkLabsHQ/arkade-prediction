import { SingleKey, networks } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { assetIdOf } from "../core/assets.js";
import { sha256Hex } from "../core/encoding.js";
import {
    cancelOffer, issueMarketAssets, mintMatch, mintSets, openVault, postOffer, resolveMarket, settleExpiredOffer,
    timeoutMarket, type Ctx, type LiveOffer, type Party,
} from "../core/actions.js";
import { bindingOf, type MarketDefinition } from "../core/definition.js";
import { marketContracts, oracleSlots } from "../core/market.js";
import { offerContract } from "../core/offers.js";
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
const MULTI_STEP = new Set(["activate", "lp-liquidity"]);
const MATCH_CANDIDATES = 5;
const RENEW_DEADLINE_MS = 10 * 60_000;
const LP_MIN_WINDOW_SECONDS = 60;

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
            const reached = terms && quorums(db, m.id, terms)[0];
            if (reached) wf.enqueue(`resolve:${m.id}`, "resolve", m.id, { outcome: reached.outcome });
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
            if (permanent || latest.attempts >= 8) this.d.wf.transition(latest, "failed", { error: message, attempt: true });
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
        if (market.status !== "open" || market.close_at - nowS < LP_MIN_WINDOW_SECONDS) return undefined;
        const p = wf.payload as Record<string, unknown>;
        const sets = BigInt(p.sets as string);
        if (!p.minted) {
            this.mark(wf, { step: "minted" });
            const { txid } = await mintSets(ctx, lp, terms, sets);
            this.mark(wf, { minted: txid, step: null, inputs: null, finalCheckpoints: null });
        }
        const lpKey = await lp.identity.xOnlyPublicKey();
        for (const outcome of ["yes", "no"] as const) {
            const price = BigInt(p[`${outcome}Ask`] as string);
            const tk = `${outcome}Terms`;
            const fk = `${outcome}FundingTxid`;
            // Same price band registerOffer enforces: a price it would reject must not fund an offer first.
            if (price <= 0n || price >= terms.unitSats || p[`${outcome}Registered`]) continue;
            if (!p[tk]) {
                p[tk] = offerTermsToJson({
                    side: "sell", maker: lpKey, makerScript: lp.script, assetId: terms.assets[outcome], priceSats: price,
                    minFill: 1n, expiresAt: lpExpiry(market.close_at, nowS), reserveSats: 330n, exitDelaySeconds: this.d.net.exitDelaySeconds,
                });
                this.mark(wf, { [tk]: p[tk] });
            }
            const offerTerms = offerTermsFromJson(p[tk] as OfferTermsJson);
            if (!p[fk]) {
                await waitForAsset(lp, offerTerms.assetId, sets);
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

    /** Operator genesis for an admitted imported market: T0 (assets), T1 (vault), then open trading. */
    private async activate(wf: Workflow, ctx: Ctx): Promise<string | undefined> {
        const operator = this.d.operator;
        const market = wf.marketId ? getMarket(this.d.db, wf.marketId) : undefined;
        if (!operator || !market) throw new Error("operator wallet or market missing");
        if (this.d.cfg.ORACLE_PUBKEYS.length === 0) throw new Error("ORACLE_PUBKEYS is empty");
        const oracleKeys = oracleSlots(this.d.cfg.ORACLE_PUBKEYS.map((k) => hex.decode(k)), this.d.cfg.ORACLE_THRESHOLD);
        const oracleThreshold = this.d.cfg.ORACLE_THRESHOLD;
        let p = wf.payload as { genesisTxid?: string; vaultTxid?: string; inputs?: string[] };
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
        const binding = bindingOf({
            network: this.d.cfg.APM_NETWORK, arkSigner: this.d.net.ark.serverKey, emulatorSigner: this.d.net.ark.emulatorKey!,
            marketId: market.id, definition, unitSats: unit, assets, oracleKeys: oracleKeys.map((k) => hex.encode(k)), oracleThreshold, oracleEpoch: this.d.cfg.ORACLE_EPOCH,
        });
        const terms = {
            assets, unitSats: unit, capSats: BigInt(this.d.cfg.MARKET_BASE_SATS) + unit * BigInt(this.d.cfg.MARKET_CAP_SETS),
            oracleKeys, oracleThreshold, binding, closeAt: BigInt(market.close_at), timeoutAt: BigInt(market.timeout_at),
            exitDelaySeconds: this.d.net.exitDelaySeconds,
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
            JSON.stringify(termsToJson(terms)), String(baseSats), p.genesisTxid!, p.vaultTxid!, JSON.stringify(oracleKeys.map((k) => hex.encode(k))), oracleThreshold, this.d.cfg.ORACLE_EPOCH, now(), market.id);
        this.d.bus.publish("market", market.id, { status: "open" });
        if (this.d.cfg.LP_BOOTSTRAP_SETS > 0 && this.d.lp) {
            this.d.wf.enqueue(`lp:${market.id}:bootstrap`, "lp-liquidity", market.id, {
                sets: String(this.d.cfg.LP_BOOTSTRAP_SETS), yesAsk: String(this.d.cfg.LP_ASK_YES_SATS), noAsk: String(this.d.cfg.LP_ASK_NO_SATS),
            });
        }
        return p.vaultTxid;
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
}

function asBid(o: { id: string; outcome: string; terms: string; coin: string | null; remaining: string }): Bid {
    const t: OfferTermsJson = JSON.parse(o.terms);
    const c: CoinJson = JSON.parse(o.coin!);
    return {
        id: o.id, outcome: o.outcome, txid: c.txid, price: BigInt(t.priceSats), minFill: BigInt(t.minFill),
        reserve: BigInt(t.reserveSats), value: BigInt(c.valueSats), remaining: BigInt(o.remaining),
    };
}

/** `fill` in buy_offer.ark: the budget left must stay positive, and min fill is waived only for the last fill. */
function bidTakes(b: Bid, qty: bigint): boolean {
    const left = b.value - qty * b.price - b.reserve;
    return qty > 0n && left >= 0n && (qty >= b.minFill || left < b.minFill * b.price);
}

/** The best-priced pair can be unfillable (min fill above what the other side absorbs), which stalled matching. */
function bestMintMatch(bids: Bid[], unitSats: bigint, room: bigint): { yes: Bid; no: Bid; qty: bigint } | undefined {
    const side = (outcome: string) =>
        bids.filter((b) => b.outcome === outcome && b.remaining > 0n).sort((a, b) => Number(b.price - a.price)).slice(0, MATCH_CANDIDATES);
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
