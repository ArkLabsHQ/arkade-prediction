import { SingleKey, networks } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { assetIdOf } from "../core/assets.js";
import { sha256Hex } from "../core/encoding.js";
import {
    issueMarketAssets, mintMatch, mintSets, openVault, postOffer, resolveMarket, settleExpiredOffer, timeoutMarket,
    type Ctx, type LiveOffer, type Party,
} from "../core/actions.js";
import { bindingOf, type MarketDefinition } from "../core/definition.js";
import { marketContracts } from "../core/market.js";
import { offerContract } from "../core/offers.js";
import { renewCovenantVtxos, type RenewTarget } from "../core/renewal.js";
import { coinFromJson, offerTermsFromJson, offerTermsToJson, termsToJson, type CoinJson, type OfferTermsJson } from "../shared/api.js";
import { all, now, run, type Db } from "./db.js";
import type { WriterLease } from "./lease.js";
import { auditGenesis, getMarket, marketTerms, reconcileVault, type Deps, type MarketRow } from "./markets.js";
import { openOffers, recordTrade, refreshOffer, registerOffer } from "./offers.js";
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

/** Classifies an ambiguous submission from authoritative indexer state; a timeout alone never means failure. */
export async function reconcileSubmission(d: Deps, txid: string | null, inputs: string[]): Promise<Outcome> {
    if (txid) {
        const known = await d.net.indexer.getVirtualTxs([txid]).then((r) => r.txs.length > 0, () => undefined);
        if (known) return "landed";
    }
    if (inputs.length === 0) return "unknown";
    const outpoints = inputs.map((o) => ({ txid: o.split(":")[0]!, vout: Number(o.split(":")[1]) }));
    const { vtxos } = await d.net.indexer.getVtxos({ outpoints });
    if (vtxos.length < outpoints.length) return "unknown";
    if (vtxos.every((v) => !v.isSpent && !v.settledBy)) return "not-submitted";
    if (txid && vtxos.some((v) => v.arkTxId === txid)) return "landed";
    return "lost";
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
        for (const m of all<MarketRow>(this.d.db, "SELECT * FROM markets WHERE terms IS NOT NULL AND status IN ('open','closed','resolving','resolved')")) {
            await reconcileVault(this.d, m).catch((e) => this.d.log("vault reconcile failed", { market: m.id, error: String(e) }));
        }
        for (const o of openOffers(this.d.db)) {
            await refreshOffer(this.d, o.id).catch((e) => this.d.log("offer refresh failed", { offer: o.id, error: String(e) }));
        }
    }

    private async plan(): Promise<void> {
        const { db, wf } = this.d;
        const nowS = Math.floor(Date.now() / 1000);
        for (const m of all<MarketRow & { outcome: string }>(db,
            `SELECT m.*, c.outcome FROM markets m JOIN certificates c ON c.market_id = m.id WHERE m.vault_phase = 'open' AND m.terms IS NOT NULL`)) {
            wf.enqueue(`resolve:${m.id}`, "resolve", m.id, { outcome: m.outcome });
        }
        for (const m of all<MarketRow>(db, "SELECT * FROM markets WHERE vault_phase = 'open' AND timeout_at > 0 AND timeout_at <= ? AND NOT EXISTS (SELECT 1 FROM certificates c WHERE c.market_id = markets.id)", nowS)) {
            wf.enqueue(`timeout:${m.id}`, "timeout", m.id, {});
        }
        const offers = openOffers(db);
        for (const o of offers) {
            const t: OfferTermsJson = JSON.parse(o.terms);
            if (o.coin && t.expiresAtUnix !== "0" && Number(t.expiresAtUnix) < nowS - 5) {
                wf.enqueue(`settle:${o.id}:${JSON.parse(o.coin).txid}`, "settle", o.market_id, { offerId: o.id });
            }
        }
        this.planMatches(offers);
        this.planRenewals(offers, nowS);
    }

    /** Best YES bid + best NO bid paying at least one unit per set: mint between them. */
    private planMatches(offers: ReturnType<typeof openOffers>): void {
        const byMarket = new Map<string, typeof offers>();
        for (const o of offers) if (o.side === "buy" && o.coin) byMarket.set(o.market_id, [...(byMarket.get(o.market_id) ?? []), o]);
        for (const [marketId, bids] of byMarket) {
            const m = getMarket(this.d.db, marketId);
            const terms = m && marketTerms(m);
            if (!m || !terms || m.vault_phase !== "open" || m.status !== "open") continue;
            const price = (o: (typeof bids)[number]) => BigInt(JSON.parse(o.terms).priceSats);
            const best = (outcome: string) => bids.filter((b) => b.outcome === outcome && BigInt(b.remaining) > 0n).sort((a, b) => Number(price(b) - price(a)))[0];
            const yes = best("yes");
            const no = best("no");
            if (!yes || !no || price(yes) + price(no) < terms.unitSats) continue;
            const qty = [BigInt(yes.remaining), BigInt(no.remaining)].reduce((a, b) => (a < b ? a : b));
            const coins = [JSON.parse(yes.coin!).txid, JSON.parse(no.coin!).txid];
            this.d.wf.enqueue(`match:${coins.join(":")}`, "mint-match", marketId, { yes: yes.id, no: no.id, qty: qty.toString() });
        }
    }

    private planRenewals(offers: ReturnType<typeof openOffers>, nowS: number): void {
        const horizon = nowS + this.d.cfg.RENEW_THRESHOLD_SECONDS;
        const due: { kind: "vault" | "offer"; id: string; outpoint: string }[] = [];
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
                const r = await reconcileSubmission(this.d, wf.txid, (wf.payload.inputs as string[] | undefined) ?? []);
                this.d.log("reconciled in-flight workflow", { id: wf.id, outcome: r });
                if (r === "landed") return void this.finish(this.d.wf.transition(wf, "done", { error: null }));
                if (r === "lost") return void this.d.wf.transition(wf, "failed", { error: "inputs spent by another transaction" });
                if (r === "unknown") return void this.d.wf.transition(wf, "submitting", { nextAt: Date.now() + backoffMs(wf.attempts), attempt: true });
                wf = this.d.wf.transition(wf, "pending", { txid: null });
            }
            const txid = await this.handle(wf);
            const latest = this.d.wf.get(wf.id)!;
            this.finish(this.d.wf.transition(latest, "done", { txid: txid ?? latest.txid, error: null }));
        } catch (err) {
            const latest = this.d.wf.get(wf.id)!;
            const message = err instanceof Error ? err.message : String(err);
            const permanent = /not found|does not cross|already|covenant|spent|expired|no claims/i.test(message) && latest.state === "pending";
            this.d.log("workflow attempt failed", { id: wf.id, state: latest.state, error: message });
            if (permanent || latest.attempts >= 8) this.d.wf.transition(latest, "failed", { error: message, attempt: true });
            else this.d.wf.transition(latest, latest.state, { error: message, nextAt: Date.now() + backoffMs(latest.attempts), attempt: true });
        }
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
            },
        };
    }

    private async handle(wf: Workflow): Promise<string | undefined> {
        const ctx = this.ctxFor(wf);
        const market = wf.marketId ? getMarket(this.d.db, wf.marketId) : undefined;
        const terms = market && marketTerms(market);
        switch (wf.kind) {
            case "resolve": {
                const cert = all<{ outcome: "yes" | "no" | "invalid"; evidence_digest: string; signature: string }>(this.d.db,
                    "SELECT outcome, evidence_digest, signature FROM certificates WHERE market_id = ? ORDER BY issued_at LIMIT 1", wf.marketId)[0];
                if (!cert || !terms) throw new Error("certificate or market not found");
                const { txid } = await resolveMarket(ctx, terms, cert.outcome, hex.decode(cert.evidence_digest), hex.decode(cert.signature));
                run(this.d.db, "UPDATE markets SET resolution_status = 'resolved', resolution_detail = ?, updated_at = ? WHERE id = ?", `resolved ${cert.outcome} in ${txid}`, now(), wf.marketId);
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
            case "mint-match": {
                if (!terms) throw new Error("market not found");
                const [yes, no] = await Promise.all([refreshOffer(this.d, wf.payload.yes as string), refreshOffer(this.d, wf.payload.no as string)]);
                if (yes.status !== "open" || no.status !== "open" || !yes.coin || !no.coin) throw new Error("bids already gone");
                const live = (o: typeof yes): LiveOffer => ({ terms: offerTermsFromJson(o.terms), coin: coinFromJson(o.coin!) });
                const qty = [BigInt(wf.payload.qty as string), BigInt(yes.remaining), BigInt(no.remaining)].reduce((a, b) => (a < b ? a : b));
                if (qty <= 0n) throw new Error("bids already filled");
                const { txid } = await mintMatch(ctx, terms, live(yes), live(no), qty, this.d.keeperScript);
                for (const o of [yes, no]) {
                    recordTrade(this.d.db, { txid, offerId: o.id, marketId: o.marketId, outcome: o.outcome, kind: "mint-match", makerSide: "buy", qty, priceSats: o.terms.priceSats });
                }
                await Promise.all([refreshOffer(this.d, yes.id), refreshOffer(this.d, no.id)]);
                return txid;
            }
            case "renew":
                return this.renew(wf);
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
        );
        this.d.log("renewed covenant vtxos", { commitmentTxid, count: targets.length });
        return commitmentTxid;
    }

    private async liquidity(wf: Workflow, ctx: Ctx): Promise<string | undefined> {
        const lp = this.d.lp;
        const market = wf.marketId ? getMarket(this.d.db, wf.marketId) : undefined;
        const terms = market && marketTerms(market);
        if (!lp || !terms || !market) throw new Error("LP wallet or market not found");
        const p = wf.payload as { sets: string; yesAsk: string; noAsk: string; minted?: string; posted?: string[] };
        if (!p.minted) {
            const { txid } = await mintSets(ctx, lp, terms, BigInt(p.sets));
            this.d.wf.transition(this.d.wf.get(wf.id)!, "pending", { payload: { minted: txid }, txid: null });
        }
        const posted = p.posted ?? [];
        const lpKey = await lp.identity.xOnlyPublicKey();
        for (const [outcome, price] of [["yes", p.yesAsk], ["no", p.noAsk]] as const) {
            if (posted.includes(outcome) || BigInt(price) <= 0n) continue;
            const offerTerms = {
                side: "sell" as const, maker: lpKey, makerScript: lp.script, assetId: terms.assets[outcome], priceSats: BigInt(price),
                minFill: 1n, expiresAt: BigInt(Math.floor(Date.now() / 1000) + 30 * 86400 + Math.floor(Math.random() * 3600)), reserveSats: 330n,
                exitDelaySeconds: this.d.net.exitDelaySeconds,
            };
            await waitForAsset(lp, terms.assets[outcome], BigInt(p.sets));
            const { txid } = await postOffer(ctx, lp, offerTerms, BigInt(p.sets));
            this.d.wf.transition(this.d.wf.get(wf.id)!, "pending", { payload: { posted: [...posted, outcome] }, txid: null });
            posted.push(outcome);
            await waitForCoin(this, offerContract(this.d.net.ark, offerTerms).pkScript, txid);
            await registerOffer(this.d, { marketId: market.id, terms: offerTermsToJson(offerTerms), fundingTxid: txid });
        }
        return undefined;
    }

    /** Operator genesis for an admitted imported market: T0 (assets), T1 (vault), then open trading. */
    private async activate(wf: Workflow, ctx: Ctx): Promise<string | undefined> {
        const operator = this.d.operator;
        const market = wf.marketId ? getMarket(this.d.db, wf.marketId) : undefined;
        if (!operator || !market) throw new Error("operator wallet or market missing");
        const oracleKey = this.d.cfg.ORACLE_PUBKEYS[0];
        if (!oracleKey) throw new Error("ORACLE_PUBKEYS is empty");
        let p = wf.payload as { genesisTxid?: string; vaultTxid?: string; inputs?: string[] };
        if (!p.genesisTxid) {
            const { genesisTxid } = await issueMarketAssets(ctx, operator, market.id, 1n);
            this.d.wf.transition(this.d.wf.get(wf.id)!, "pending", { payload: { genesisTxid }, txid: null });
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
            marketId: market.id, definition, unitSats: unit, assets, oracleKeys: [oracleKey], oracleEpoch: this.d.cfg.ORACLE_EPOCH,
        });
        const terms = {
            assets, unitSats: unit, capSats: BigInt(this.d.cfg.MARKET_BASE_SATS) + unit * BigInt(this.d.cfg.MARKET_CAP_SETS),
            oracleKey: hex.decode(oracleKey), binding, closeAt: BigInt(market.close_at), timeoutAt: BigInt(market.timeout_at),
            exitDelaySeconds: this.d.net.exitDelaySeconds,
        };
        if (!p.vaultTxid) {
            await waitForAsset(operator, assets.ctrl, 1n);
            const { txid } = await openVault(ctx, operator, terms, 1n, BigInt(this.d.cfg.MARKET_BASE_SATS));
            this.d.wf.transition(this.d.wf.get(wf.id)!, "pending", { payload: { vaultTxid: txid }, txid: null });
            p = { ...p, vaultTxid: txid };
        }
        const { baseSats } = await auditGenesis(this.d.net, terms, p.genesisTxid!, p.vaultTxid!);
        run(this.d.db, "UPDATE markets SET status = 'open', terms = ?, base_sats = ?, genesis_txid = ?, vault_txid = ?, oracle_keys = ?, oracle_epoch = ?, updated_at = ? WHERE id = ? AND status = 'activating'",
            JSON.stringify(termsToJson(terms)), String(baseSats), p.genesisTxid!, p.vaultTxid!, JSON.stringify([oracleKey]), this.d.cfg.ORACLE_EPOCH, now(), market.id);
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
