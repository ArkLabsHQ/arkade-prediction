import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Transaction } from "@arkade-os/sdk";
import { base64, hex } from "@scure/base";
import { all, openDb, run, type Db } from "../../../src/server/db.js";
import type { Deps } from "../../../src/server/markets.js";
import { recordTrade, refreshOffer } from "../../../src/server/offers.js";
import type { CoinJson, OfferTermsJson } from "../../../src/shared/api.js";

const OFFER = "5120" + "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const MAKER = "5120" + "c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const VAULT = "5120" + "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";
const TAKER = "5120" + "50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const ASSET = "dd".repeat(32) + "0100";

let seq = 0;
const nextId = () => (++seq).toString(16).padStart(4, "0").repeat(16);

interface Fake {
    txid: string;
    vout: number;
    value: number;
    script: string;
    assets?: { assetId: string; amount: bigint }[];
    isSpent?: boolean;
    isSwept?: boolean;
    spentBy?: string;
    arkTxId?: string;
    settledBy?: string;
    commitmentTxIds?: string[];
    expiresAt?: Date;
}

class Idx {
    vtxoCalls = 0;
    txCalls = 0;
    coins: Fake[] = [];
    txs: Record<string, string> = {};
    /** Lets a test land the next transaction exactly when a coin was last observed live. */
    afterRead?: (seen: Fake[]) => void;

    getVtxos = async (q: { scripts?: string[]; outpoints?: { txid: string; vout: number }[]; spendableOnly?: boolean }) => {
        this.vtxoCalls++;
        const seen = q.outpoints
            ? q.outpoints.flatMap((o) => this.coins.filter((c) => c.txid === o.txid && c.vout === o.vout))
            : this.coins.filter((c) => q.scripts!.includes(c.script) && (!q.spendableOnly || (!c.isSpent && !c.settledBy && !c.isSwept)));
        const vtxos = seen.map((c) => ({ ...c, assets: c.assets?.map((a) => ({ ...a })) }));
        this.afterRead?.(seen);
        return { vtxos };
    };

    getVirtualTxs = async (ids: string[]) => {
        this.txCalls++;
        return { txs: ids.map((i) => this.txs[i]).filter((x): x is string => x !== undefined) };
    };

    add(c: Fake): Fake {
        this.coins.push(c);
        return c;
    }

    /** Spends `coin` with an Arkade tx whose input `vin` is the checkpoint that consumed it. */
    spend(coin: Fake, outputs: [string, bigint][], o: { vin?: number; inputs?: number } = {}): string {
        const vin = o.vin ?? 0;
        const checkpoints = Array.from({ length: o.inputs ?? vin + 1 }, nextId);
        const t = new Transaction({ version: 3, allowUnknownOutputs: true });
        for (const cp of checkpoints) t.addInput({ txid: hex.decode(cp), index: 0, witnessUtxo: { script: hex.decode(OFFER), amount: 1000n } });
        for (const [script, amount] of outputs) t.addOutput({ script: hex.decode(script), amount });
        coin.isSpent = true;
        coin.spentBy = checkpoints[vin]!;
        coin.arkTxId = t.id;
        this.txs[t.id] = base64.encode(t.toPSBT());
        return t.id;
    }
}

const nowS = Math.floor(Date.now() / 1000);
const deps = (db: Db, idx: Idx) => ({ db, bus: { publish() {} }, net: { indexer: idx }, cfg: {} }) as unknown as Deps;
const tradeRows = (db: Db) => all<{ txid: string; qty: string; kind: string }>(db, "SELECT txid, qty, kind FROM trades ORDER BY rowid");
const offerRow = (db: Db) => all<{ coin: string | null; status: string; remaining: string }>(db, "SELECT coin, status, remaining FROM offers")[0]!;

function offerDb(side: "sell" | "buy", coin: CoinJson, remaining: string, extra: Partial<OfferTermsJson> = {}): Db {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "apm-offers-")), "apm.sqlite"));
    const at = new Date().toISOString();
    run(db, `INSERT INTO markets(id, kind, status, question, rules, outcomes, close_at, timeout_at, oracle_policy, oracle_keys, oracle_threshold, oracle_epoch, definition_hash, created_at, updated_at)
             VALUES ('m','custom','open','q','r','["Y","N"]',0,0,'external-key','[]',1,0,'h',?,?)`, at, at);
    const t: OfferTermsJson = {
        side, maker: "ee".repeat(32), makerScript: MAKER, assetId: ASSET, priceSats: "600",
        minFill: "1", expiresAtUnix: "0", reserveSats: "330", exitDelaySeconds: "512", ...extra,
    };
    run(db, `INSERT INTO offers(id, market_id, outcome, side, terms, script, maker_script, coin, status, remaining, funding_txid, created_at, updated_at)
             VALUES ('o1','m','yes',?,?,?,?,?,'open',?,'f',?,?)`, side, JSON.stringify(t), OFFER, MAKER, JSON.stringify(coin), remaining, at, at);
    return db;
}

const sellCoin = (txid: string, units: bigint, valueSats = "330"): CoinJson =>
    ({ txid, vout: 0, valueSats, assets: [{ assetId: ASSET, amount: units.toString() }], expiresAt: null });

describe("refreshOffer follows the offer's coin lineage", () => {
    it("ignores a stray coin paid to the offer script and costs one indexer call", async () => {
        const c1 = sellCoin(nextId(), 10n);
        const db = offerDb("sell", c1, "10");
        const idx = new Idx();
        idx.add({ txid: nextId(), vout: 0, value: 330, script: OFFER, assets: [] });
        idx.add({ txid: c1.txid, vout: 0, value: 330, script: OFFER, assets: [{ assetId: ASSET, amount: 10n }] });

        const o = await refreshOffer(deps(db, idx), "o1");

        expect(o.status).toBe("open");
        expect(o.remaining).toBe("10");
        expect(o.coin?.txid).toBe(c1.txid);
        expect(tradeRows(db)).toEqual([]);
        expect(idx.vtxoCalls).toBe(1);
        expect(idx.txCalls).toBe(0);
    });

    it("records both hops when a partial fill and the final fill land between refreshes", async () => {
        const c1 = sellCoin(nextId(), 10n);
        const db = offerDb("sell", c1, "10");
        const idx = new Idx();
        const live = idx.add({ txid: c1.txid, vout: 0, value: 330, script: OFFER, assets: [{ assetId: ASSET, amount: 10n }] });
        const fill1 = idx.spend(live, [[OFFER, 2130n], [TAKER, 330n]]);
        const cont = idx.add({ txid: fill1, vout: 0, value: 2130, script: OFFER, assets: [{ assetId: ASSET, amount: 7n }] });
        const fill2 = idx.spend(cont, [[MAKER, 6330n], [TAKER, 330n]]);

        const o = await refreshOffer(deps(db, idx), "o1");

        expect(o.status).toBe("filled");
        expect(o.remaining).toBe("0");
        expect(o.coin).toBe(null);
        expect(tradeRows(db)).toEqual([
            { txid: fill1, qty: "3", kind: "fill" },
            { txid: fill2, qty: "7", kind: "fill" },
        ]);
    });

    it("records the partial fill and cancels when the maker takes the remainder back", async () => {
        const c1 = sellCoin(nextId(), 10n);
        const db = offerDb("sell", c1, "10");
        const idx = new Idx();
        const live = idx.add({ txid: c1.txid, vout: 0, value: 330, script: OFFER, assets: [{ assetId: ASSET, amount: 10n }] });
        const fill1 = idx.spend(live, [[OFFER, 2130n], [TAKER, 330n]]);
        const cont = idx.add({ txid: fill1, vout: 0, value: 2130, script: OFFER, assets: [{ assetId: ASSET, amount: 7n }] });
        idx.spend(cont, [[MAKER, 2130n]]);

        const o = await refreshOffer(deps(db, idx), "o1");

        expect(o.status).toBe("cancelled");
        expect(o.coin).toBe(null);
        expect(tradeRows(db)).toEqual([{ txid: fill1, qty: "3", kind: "fill" }]);
    });

    it("follows a renewal without recording a trade, and waits while the batch output is invisible", async () => {
        const c1 = sellCoin(nextId(), 10n);
        const db = offerDb("sell", c1, "10");
        const idx = new Idx();
        const live = idx.add({ txid: c1.txid, vout: 0, value: 330, script: OFFER, assets: [{ assetId: ASSET, amount: 10n }] });
        const commitment = nextId();
        live.settledBy = commitment;
        live.spentBy = nextId();

        const pending = await refreshOffer(deps(db, idx), "o1");
        expect(pending.status).toBe("open");
        expect(pending.coin?.txid).toBe(c1.txid);

        const renewed = idx.add({
            txid: nextId(), vout: 0, value: 330, script: OFFER, assets: [{ assetId: ASSET, amount: 10n }],
            commitmentTxIds: [commitment], expiresAt: new Date(Date.now() + 7_168_000),
        });
        const o = await refreshOffer(deps(db, idx), "o1");

        expect(o.status).toBe("open");
        expect(o.remaining).toBe("10");
        expect(o.coin?.txid).toBe(renewed.txid);
        expect(o.coin?.expiresAt).toBe(renewed.expiresAt!.toISOString());
        expect(tradeRows(db)).toEqual([]);
    });

    it("does not double-count when two refreshes race a landing fill", async () => {
        const c1 = sellCoin(nextId(), 10n);
        const db = offerDb("sell", c1, "10", { priceSats: "100" });
        const idx = new Idx();
        const live = idx.add({ txid: c1.txid, vout: 0, value: 330, script: OFFER, assets: [{ assetId: ASSET, amount: 10n }] });
        const fill1 = idx.spend(live, [[OFFER, 1030n], [TAKER, 330n]]);
        const cont = idx.add({ txid: fill1, vout: 0, value: 1030, script: OFFER, assets: [{ assetId: ASSET, amount: 7n }] });
        let landed = false;
        idx.afterRead = (seen) => {
            if (landed || !seen.some((c) => c.txid === cont.txid && !c.isSpent)) return;
            landed = true;
            const fill2 = idx.spend(cont, [[OFFER, 1230n], [TAKER, 330n]]);
            idx.add({ txid: fill2, vout: 0, value: 1230, script: OFFER, assets: [{ assetId: ASSET, amount: 5n }] });
        };

        const d = deps(db, idx);
        await Promise.all([refreshOffer(d, "o1"), refreshOffer(d, "o1")]);

        const racedQty = tradeRows(db).reduce((s, t) => s + Number(t.qty), 0);
        expect(racedQty).toBe(3);
        expect(JSON.parse(offerRow(db).coin!).txid).toBe(cont.txid);

        const o = await refreshOffer(d, "o1");
        expect(tradeRows(db).reduce((s, t) => s + Number(t.qty), 0)).toBe(5);
        expect(o.remaining).toBe("5");
        expect(o.status).toBe("open");
    });

    it("reports a buy offer filled before its expiry as filled with a trade", async () => {
        const b1: CoinJson = { txid: nextId(), vout: 0, valueSats: "3830", assets: [], expiresAt: null };
        const db = offerDb("buy", b1, "10", { priceSats: "350", expiresAtUnix: String(nowS - 5) });
        const idx = new Idx();
        const live = idx.add({ txid: b1.txid, vout: 0, value: 3830, script: OFFER, assets: [] });
        const fill = idx.spend(live, [[MAKER, 330n], [TAKER, 3500n]]);
        idx.add({ txid: fill, vout: 0, value: 330, script: MAKER, assets: [{ assetId: ASSET, amount: 10n }] });

        const o = await refreshOffer(deps(db, idx), "o1");

        expect(o.status).toBe("filled");
        expect(tradeRows(db)).toEqual([{ txid: fill, qty: "10", kind: "fill" }]);
    });

    it("settles an expired offer returned to the maker untouched", async () => {
        const g: CoinJson = { txid: nextId(), vout: 0, valueSats: "1330", assets: [], expiresAt: null };
        const db = offerDb("buy", g, "10", { priceSats: "100", expiresAtUnix: String(nowS - 5) });
        const idx = new Idx();
        const live = idx.add({ txid: g.txid, vout: 0, value: 1330, script: OFFER, assets: [] });
        const settle = idx.spend(live, [[MAKER, 1330n]]);
        idx.add({ txid: settle, vout: 0, value: 1330, script: MAKER, assets: [] });

        const o = await refreshOffer(deps(db, idx), "o1");

        expect(o.status).toBe("settled");
        expect(tradeRows(db)).toEqual([]);
    });

    it("marks a swept offer gone", async () => {
        const c1 = sellCoin(nextId(), 10n);
        const db = offerDb("sell", c1, "10");
        const idx = new Idx();
        idx.add({ txid: c1.txid, vout: 0, value: 330, script: OFFER, assets: [{ assetId: ASSET, amount: 10n }], isSwept: true });

        const o = await refreshOffer(deps(db, idx), "o1");

        expect(o.status).toBe("gone");
        expect(o.coin).toBe(null);
        expect(tradeRows(db)).toEqual([]);
    });

    it("keeps the keeper's mint-match trade and reads the continuation at the offer's own input index", async () => {
        const b1: CoinJson = { txid: nextId(), vout: 0, valueSats: "7330", assets: [], expiresAt: null };
        const db = offerDb("buy", b1, "10", { priceSats: "700" });
        const idx = new Idx();
        const live = idx.add({ txid: b1.txid, vout: 0, value: 7330, script: OFFER, assets: [] });
        const match = idx.spend(live, [[VAULT, 26_000n], [OFFER, 3830n], [TAKER, 500n]], { vin: 1, inputs: 3 });
        idx.add({ txid: match, vout: 1, value: 3830, script: OFFER, assets: [{ assetId: ASSET, amount: 5n }] });
        recordTrade(db, { txid: match, offerId: "o1", marketId: "m", outcome: "yes", kind: "mint-match", makerSide: "buy", qty: 5n, priceSats: "700" });

        const o = await refreshOffer(deps(db, idx), "o1");

        expect(o.status).toBe("open");
        expect(o.coin?.vout).toBe(1);
        expect(o.remaining).toBe("5");
        expect(tradeRows(db)).toEqual([{ txid: match, qty: "5", kind: "mint-match" }]);
    });
});
