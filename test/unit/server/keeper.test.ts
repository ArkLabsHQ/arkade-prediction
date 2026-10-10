import { describe, expect, it } from "vitest";
import { all, openDb, run } from "../../../src/server/db.js";
import { WriterLease } from "../../../src/server/lease.js";
import { ASSETS, harness, inner, insertBuyOffer, insertMarket, P2TR, tempDb } from "./harness.js";

const MIN = 60_000;

describe("workflow re-arming", () => {
    it("revives a failed workflow once the cooldown has passed, with the fresh payload", () => {
        const { wf } = harness();
        const w = wf.enqueue("resolve:m1", "resolve", "m1", { outcome: "yes" });
        wf.transition(w, "failed", { error: "inputs spent by another transaction", attempt: true });

        const tooSoon = wf.enqueue("resolve:m1", "resolve", "m1", { outcome: "yes" }, Date.now() + 30_000);
        expect(tooSoon.state).toBe("failed");
        expect(wf.due(10)).toHaveLength(0);

        const later = Date.now() + 3 * MIN;
        const revived = wf.enqueue("resolve:m1", "resolve", "m1", { outcome: "no" }, later);
        expect(revived.state).toBe("pending");
        expect(revived.payload.outcome).toBe("no");
        expect(revived.attempts).toBe(0);
        expect(revived.error).toBeNull();
        expect(wf.due(10, later).map((x) => x.id)).toEqual(["resolve:m1"]);
    });

    it("backs the cooldown off per re-arm and never revives a done workflow", () => {
        const { wf } = harness();
        const w = wf.enqueue("timeout:m2", "timeout", "m2", {});
        wf.transition(w, "failed", { error: "emulator down", attempt: true });
        const first = wf.enqueue("timeout:m2", "timeout", "m2", {}, Date.now() + 3 * MIN);
        expect(first.state).toBe("pending");
        expect(first.payload.rearms).toBe(1);

        wf.transition(first, "failed", { error: "emulator down", attempt: true });
        // Second failure: the 2-minute cooldown is no longer enough.
        expect(wf.enqueue("timeout:m2", "timeout", "m2", {}, Date.now() + 3 * MIN).state).toBe("failed");
        expect(wf.enqueue("timeout:m2", "timeout", "m2", {}, Date.now() + 5 * MIN).state).toBe("pending");

        const done = wf.enqueue("resolve:m3", "resolve", "m3", {});
        wf.transition(done, "done", {});
        expect(wf.enqueue("resolve:m3", "resolve", "m3", {}, Date.now() + 60 * MIN).state).toBe("done");
    });

    it("keeps a multi-step workflow's progress across a re-arm and drops per-attempt fields", () => {
        const { wf } = harness();
        const w = wf.enqueue("activate:m4", "activate", "m4", {});
        const mid = wf.transition(w, "pending", { payload: { genesisTxid: "G", step: "vaultTxid", inputs: ["op:2"], finalCheckpoints: ["cp"] } });
        wf.transition(mid, "failed", { error: "emulator down", attempt: true });
        const revived = wf.enqueue("activate:m4", "activate", "m4", {}, Date.now() + 3 * MIN);
        expect(revived.state).toBe("pending");
        expect(revived.payload).toMatchObject({ genesisTxid: "G", rearms: 1 });
        for (const k of ["step", "inputs", "finalCheckpoints"]) expect(revived.payload).not.toHaveProperty(k);
    });
});

describe("in-flight reconciliation", () => {
    it("rebuilds from fresh state when the inputs were spent by another transaction", async () => {
        const h = harness();
        const w = h.wf.enqueue("resolve:m1", "resolve", "m1", { outcome: "yes" });
        h.wf.transition(w, "submitting", { txid: "T_RESOLVE", payload: { inputs: ["V:0"] } });
        h.fakes.vtxos = [{ txid: "V", vout: 0, isSpent: true, arkTxId: "T_USER_MERGE" }];
        const retried: (string | null)[] = [];
        inner(h.keeper).handle = async (next) => {
            const row = next as { state: string; txid: string | null };
            retried.push(row.txid);
            expect(row.state).toBe("pending");
            throw new Error("fetch failed");
        };

        await h.keeper.execute(h.wf.get("resolve:m1")!);
        // The handler re-ran against a cleared write-ahead instead of the row being abandoned as failed.
        expect(retried).toEqual([null]);
        const after = h.wf.get("resolve:m1")!;
        expect(after.state).toBe("pending");
        expect(after.attempts).toBeGreaterThanOrEqual(1);
        expect(h.wf.due(10, Date.now() + 10 * MIN).map((x) => x.id)).toEqual(["resolve:m1"]);
    });

    it("keeps a landed single-step workflow terminal", async () => {
        const h = harness();
        const w = h.wf.enqueue("match:a:b", "mint-match", "m1", { yes: "a", no: "b", qty: "1" });
        h.wf.transition(w, "submitting", { txid: "T_MATCH", payload: { inputs: ["A:0"] } });
        h.fakes.virtualTxs = ["psbt"];
        h.fakes.vtxos = [{ txid: "A", vout: 0, isSpent: true, arkTxId: "T_MATCH" }, { txid: "T_MATCH", vout: 0, isSpent: false }];

        await h.keeper.execute(h.wf.get("match:a:b")!);
        expect(h.wf.get("match:a:b")!.state).toBe("done");
    });

    it("rebuilds a submission arkd recorded but failed, whose inputs are still unspent", async () => {
        const h = harness();
        const w = h.wf.enqueue("match:a:b", "mint-match", "m1", { yes: "a", no: "b", qty: "1" });
        h.wf.transition(w, "submitting", { txid: "T_FAILED", payload: { inputs: ["A:0"] } });
        h.fakes.virtualTxs = ["psbt-of-failed-tx"];
        h.fakes.vtxos = [{ txid: "A", vout: 0, isSpent: false }];
        const rebuilt: (string | null)[] = [];
        inner(h.keeper).handle = async (next) => {
            rebuilt.push((next as { txid: string | null }).txid);
            return "T_RETRY";
        };

        await h.keeper.execute(h.wf.get("match:a:b")!);
        expect(rebuilt).toEqual([null]);
    });

    it("waits while arkd has accepted a submission but not yet created its outputs", async () => {
        const h = harness();
        const w = h.wf.enqueue("resolve:m1", "resolve", "m1", { outcome: "yes" });
        h.wf.transition(w, "submitting", { txid: "T_ACCEPTED", payload: { inputs: ["V:0"] } });
        h.fakes.virtualTxs = ["psbt"];
        h.fakes.vtxos = [{ txid: "V", vout: 0, isSpent: true, arkTxId: "T_ACCEPTED" }];

        await h.keeper.execute(h.wf.get("resolve:m1")!);
        expect(h.wf.get("resolve:m1")).toMatchObject({ state: "submitting", txid: "T_ACCEPTED" });
    });

    it("continues a multi-step activate at the vault step when only the genesis tx landed", async () => {
        const h = harness();
        const w = h.wf.enqueue("activate:x", "activate", "x", {});
        // beforeSubmit of step 1, which now records which step is in flight.
        h.wf.transition(w, "submitting", { txid: "T0_GENESIS", payload: { inputs: ["op:1"], step: "genesisTxid" } });
        h.fakes.virtualTxs = ["psbt-of-T0"];
        h.fakes.vtxos = [{ txid: "op", vout: 1, isSpent: true, arkTxId: "T0_GENESIS" }, { txid: "T0_GENESIS", vout: 0, isSpent: false }];
        let seen: Record<string, unknown> | undefined;
        inner(h.keeper).handle = async (next) => {
            seen = (next as { payload: Record<string, unknown> }).payload;
            return "T1_VAULT";
        };

        await h.keeper.execute(h.wf.get("activate:x")!);
        expect(seen?.genesisTxid).toBe("T0_GENESIS");
        expect(seen?.step).toBeNull();
        expect(h.wf.get("activate:x")!.state).toBe("done");
    });
});

describe("writer lease heartbeat", () => {
    it("keeps the lease across a tick longer than the ttl", async () => {
        const { db, path } = tempDb();
        const a = new WriterLease(db, 300);
        const b = new WriterLease(openDb(path), 300);
        expect(a.tryAcquire()).toBe(true);

        const stop = a.keepAlive();
        await new Promise((r) => setTimeout(r, 600)); // a "tick" twice as long as the ttl
        expect(b.tryAcquire()).toBe(false);
        expect(a.heartbeat()).toBe(true);

        stop();
        await new Promise((r) => setTimeout(r, 400));
        expect(b.tryAcquire()).toBe(true);
    });
});

describe("match planning", () => {
    const planned = async (h: ReturnType<typeof harness>) => {
        await inner(h.keeper).plan();
        return h.wf.list({ state: "pending" }).filter((w) => w.kind === "mint-match");
    };

    it("skips a crossing best pair whose fill would break its min-fill rule and takes the next one", async () => {
        const h = harness();
        insertMarket(h.db, { id: "m1", cap: "100001000" });
        // Best YES bid: 20 units of budget but minFill 10, so a 3-unit fill is refused by the covenant.
        insertBuyOffer(h.db, { id: "yesA", marketId: "m1", outcome: "yes", priceSats: 600n, remaining: 20n, minFill: 10n });
        insertBuyOffer(h.db, { id: "yesB", marketId: "m1", outcome: "yes", priceSats: 550n, remaining: 10n });
        insertBuyOffer(h.db, { id: "no1", marketId: "m1", outcome: "no", priceSats: 500n, remaining: 3n });

        const [match, ...rest] = await planned(h);
        expect(rest).toHaveLength(0);
        expect(match?.payload).toMatchObject({ yes: "yesB:0", no: "no1:0", qty: "3" });
    });

    it("caps the quantity at the vault's remaining open-interest room", async () => {
        const h = harness();
        insertMarket(h.db, { id: "m1", cap: "11000", vaultValue: "9000" }); // room for 2 more sets
        insertBuyOffer(h.db, { id: "yes1", marketId: "m1", outcome: "yes", priceSats: 600n, remaining: 20n });
        insertBuyOffer(h.db, { id: "no1", marketId: "m1", outcome: "no", priceSats: 500n, remaining: 20n });

        expect((await planned(h))[0]?.payload).toMatchObject({ qty: "2" });
    });

    it("plans nothing when the vault is already at the cap", async () => {
        const h = harness();
        insertMarket(h.db, { id: "m1", cap: "11000", vaultValue: "11000" });
        insertBuyOffer(h.db, { id: "yes1", marketId: "m1", outcome: "yes", priceSats: 600n, remaining: 20n });
        insertBuyOffer(h.db, { id: "no1", marketId: "m1", outcome: "no", priceSats: 500n, remaining: 20n });

        expect(await planned(h)).toHaveLength(0);
    });
});

describe("halted markets", () => {
    it("stays in the reconcile sweep, so its vault state keeps moving", async () => {
        const attempted: string[] = [];
        const h = harness({ log: (msg, extra) => void (msg === "vault reconcile failed" && attempted.push(String(extra?.market))) });
        for (const [id, status] of [["open1", "open"], ["halted1", "halted"], ["hidden1", "hidden"]]) {
            insertMarket(h.db, { id: id!, status });
        }

        await (h.keeper as unknown as { refresh(): Promise<void> }).refresh();
        expect(attempted.sort()).toEqual(["halted1", "open1"]);
    });

    it("cancels the LP's open offers once per offer and plans no matches", async () => {
        const lpScript = P2TR("bb");
        const h = harness({ lp: { script: Uint8Array.from(Buffer.from(lpScript, "hex")) } as never });
        insertMarket(h.db, { id: "m1", status: "halted" });
        insertBuyOffer(h.db, { id: "lpYes", marketId: "m1", outcome: "yes", priceSats: 600n, remaining: 5n, makerScript: lpScript });
        insertBuyOffer(h.db, { id: "userNo", marketId: "m1", outcome: "no", priceSats: 500n, remaining: 5n });

        await inner(h.keeper).plan();
        await inner(h.keeper).plan();
        const kinds = h.wf.list({}).map((w) => `${w.kind}:${w.id}`);
        expect(kinds.filter((k) => k.startsWith("cancel-offer"))).toEqual(["cancel-offer:cancel:lpYes:0"]);
        expect(kinds.filter((k) => k.startsWith("mint-match"))).toHaveLength(0);
    });
});

describe("LP repricing", () => {
    it("moves only drifted LP asks on mirrored markets to the source price plus spread", async () => {
        const lpScript = P2TR("bb");
        const h = harness({ lp: { script: Uint8Array.from(Buffer.from(lpScript, "hex")) } as never });
        insertMarket(h.db, { id: "pm" });
        insertMarket(h.db, { id: "custom" });
        run(h.db, "UPDATE markets SET kind = 'polymarket', source_snapshot = ? WHERE id = 'pm'",
            JSON.stringify({ referencePrices: [{ outcome: "Yes", price: "0.2" }, { outcome: "No", price: "0.8" }] }));
        const ask = (id: string, marketId: string, outcome: "yes" | "no", priceSats: bigint, makerScript = lpScript) => {
            insertBuyOffer(h.db, { id, marketId, outcome, priceSats, remaining: 3n, makerScript });
            run(h.db, "UPDATE offers SET side = 'sell', terms = json_set(terms, '$.side', 'sell') WHERE id = ?", `${id}:0`);
        };
        ask("drifted", "pm", "yes", 550n);
        ask("close", "pm", "no", 830n);
        ask("other", "pm", "yes", 550n, P2TR("cc"));
        ask("customAsk", "custom", "yes", 550n);
        ask("legacy", "pm", "no", 830n);
        run(h.db, "UPDATE offers SET terms = json_set(terms, '$.legacy', json('true')) WHERE id = 'legacy:0'");

        await inner(h.keeper).plan();
        const reprices = h.wf.list({}).filter((w) => w.kind === "lp-reprice");
        // A legacy ask moves onto the current contracts even when its price has not drifted.
        expect(reprices.map((w) => w.id).sort()).toEqual(["reprice:drifted:0", "reprice:legacy:0"]);
        expect(reprices.find((w) => w.id === "reprice:drifted:0")!.payload.price).toBe("220");
    });
});

describe("resolution planning", () => {
    it("waits for the close before planning a resolve, because the covenant refuses earlier ones", async () => {
        const h = harness();
        const nowS = Math.floor(Date.now() / 1000);
        insertMarket(h.db, { id: "early", closeAt: nowS + 600 });
        insertMarket(h.db, { id: "closed", closeAt: nowS - 5 });
        for (const id of ["early", "closed"]) {
            run(h.db, "INSERT INTO certificates(market_id, outcome, numerators, denominator, evidence_digest, signature, signer, issued_at) VALUES (?, 'yes', '[\"1\",\"0\"]', '1', ?, ?, ?, 't')",
                id, "cd".repeat(32), "ab".repeat(64), "22".repeat(32));
        }
        await inner(h.keeper).plan();
        expect(h.wf.list({ state: "pending" }).filter((w) => w.kind === "resolve").map((w) => w.marketId)).toEqual(["closed"]);
    });
});

describe("own claim redemption", () => {
    it("redeems our wallets' leftover claims on resolved markets, after the LP's offers are gone, once", async () => {
        const lpScript = P2TR("bb");
        const coinWith = (assetId: string) => [{ txid: "aa".repeat(32), vout: 0, value: 330, assets: [{ assetId, amount: 2n }] }];
        const h = harness({
            operator: { script: new Uint8Array(34), coins: async () => coinWith(ASSETS.yes) } as never,
            lp: { script: Uint8Array.from(Buffer.from(lpScript, "hex")), coins: async () => coinWith(ASSETS.no) } as never,
        });
        insertMarket(h.db, { id: "done", phase: "resolved" });
        run(h.db, "UPDATE markets SET vault_outcome = 'yes', status = 'resolved' WHERE id = 'done'");
        insertBuyOffer(h.db, { id: "lpLeft", marketId: "done", outcome: "no", priceSats: 400n, remaining: 2n, makerScript: lpScript });

        await inner(h.keeper).plan();
        const redeems = () => h.wf.list({}).filter((w) => w.kind === "redeem-own").map((w) => w.id).sort();
        expect(redeems()).toEqual(["redeem:done:operator"]);

        run(h.db, "UPDATE offers SET status = 'settled' WHERE id = 'lpLeft:0'");
        await inner(h.keeper).plan();
        await inner(h.keeper).plan();
        expect(redeems()).toEqual(["redeem:done:lp", "redeem:done:operator"]);
    });
});

describe("LP bootstrap retry", () => {
    it("re-arms a failed bootstrap on an open market once its cooldown has passed", async () => {
        const h = harness({});
        insertMarket(h.db, { id: "m1" });
        insertMarket(h.db, { id: "gone", status: "resolved" });
        for (const id of ["m1", "gone"]) {
            run(h.db, "INSERT INTO workflows(id, kind, market_id, state, payload, error, created_at, updated_at) VALUES (?, 'lp-liquidity', ?, 'failed', ?, 'insufficient funds', ?, ?)",
                `lp:${id}:bootstrap`, id, JSON.stringify({ sets: "5", yesAsk: "550", noAsk: "550" }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
        }
        await inner(h.keeper).plan();
        expect(h.wf.get("lp:m1:bootstrap")).toMatchObject({ state: "pending", payload: { sets: "5", yesAsk: "550", rearms: 1 } });
        expect(h.wf.get("lp:gone:bootstrap")?.state).toBe("failed");
    });
});

describe("LP busy-only bootstraps", () => {
    const lp = { script: new Uint8Array(34), coins: async () => [] };
    const cfg = { APM_NETWORK: "regtest", RENEW_THRESHOLD_SECONDS: 3600, MARKET_UNIT_SATS: 1000, LP_BOOTSTRAP_SETS: 5, LP_ASK_YES_SATS: 550, LP_ASK_NO_SATS: 550, LP_BUSY_ONLY: true };
    const mirror = (h: ReturnType<typeof harness>, id: string, snapshot: object) => {
        insertMarket(h.db, { id });
        run(h.db, "UPDATE markets SET kind = 'polymarket', source_snapshot = ? WHERE id = ?", JSON.stringify(snapshot), id);
    };
    const bootstraps = (h: ReturnType<typeof harness>) =>
        all<{ id: string }>(h.db, "SELECT id FROM workflows WHERE kind = 'lp-liquidity'").map((r) => r.id).sort();

    it("seeds a busy mirrored market and an Up/Down window, not a quiet one", async () => {
        const h = harness({ lp, cfg } as never);
        mirror(h, "busy", { provider: "polymarket", slug: "busy", volume24h: 50_000 });
        mirror(h, "quiet", { provider: "polymarket", slug: "quiet", volume24h: 10 });
        mirror(h, "updown", { provider: "polymarket", slug: "btc-updown-15m-1791615600" });
        await inner(h.keeper).plan();
        expect(bootstraps(h)).toEqual(["lp:busy:bootstrap", "lp:updown:bootstrap"]);
        expect(h.wf.get("lp:busy:bootstrap")!.payload).toEqual({ sets: "5", yesAsk: "550", noAsk: "550" });
    });

    it("seeds a quiet market once, after its refreshed volume turns busy", async () => {
        const h = harness({ lp, cfg } as never);
        mirror(h, "m", { provider: "kalshi", slug: "m", volume24h: 0 });
        await inner(h.keeper).plan();
        expect(bootstraps(h)).toEqual([]);
        run(h.db, "UPDATE markets SET source_snapshot = json_set(source_snapshot, '$.volume24h', 500) WHERE id = 'm'");
        await inner(h.keeper).plan();
        h.wf.transition(h.wf.get("lp:m:bootstrap")!, "done", {});
        await inner(h.keeper).plan();
        expect(bootstraps(h)).toEqual(["lp:m:bootstrap"]);
        expect(h.wf.get("lp:m:bootstrap")!.state).toBe("done");
    });

    it("does not re-arm a failed bootstrap on a quiet market", async () => {
        const h = harness({ lp, cfg } as never);
        mirror(h, "m", { provider: "manifold", slug: "m", volume24h: 1 });
        run(h.db, "INSERT INTO workflows(id, kind, market_id, state, payload, error, created_at, updated_at) VALUES ('lp:m:bootstrap', 'lp-liquidity', 'm', 'failed', '{}', 'insufficient funds', ?, ?)",
            "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
        await inner(h.keeper).plan();
        expect(h.wf.get("lp:m:bootstrap")!.state).toBe("failed");
    });
});

describe("LP bids", () => {
    const lpScript = P2TR("bb");
    const lp = { script: Uint8Array.from(Buffer.from(lpScript, "hex")), coins: async () => [] };
    const cfg = (bidSets: number) => ({ APM_NETWORK: "regtest", RENEW_THRESHOLD_SECONDS: 3600, MARKET_UNIT_SATS: 1000, LP_BOOTSTRAP_SETS: 0, LP_BUSY_ONLY: true, LP_BID_SETS: bidSets });
    const mirror = (h: ReturnType<typeof harness>, id: string, volume24h: number, yes = "0.6", no = "0.4") => {
        insertMarket(h.db, { id });
        run(h.db, "UPDATE markets SET kind = 'polymarket', source_snapshot = ? WHERE id = ?",
            JSON.stringify({ provider: "polymarket", slug: id, volume24h, fetchedAt: new Date().toISOString(), referencePrices: [{ outcome: "Yes", price: yes }, { outcome: "No", price: no }] }), id);
    };
    const quote = (h: ReturnType<typeof harness>, id: string, marketId: string, outcome: "yes" | "no", side: "buy" | "sell", priceSats: bigint) => {
        insertBuyOffer(h.db, { id, marketId, outcome, priceSats, remaining: 3n, makerScript: lpScript });
        if (side === "sell") run(h.db, "UPDATE offers SET side = 'sell', terms = json_set(terms, '$.side', 'sell') WHERE id = ?", `${id}:0`);
    };
    const kinds = (h: ReturnType<typeof harness>, kind: string) => h.wf.list({}).filter((w) => w.kind === kind);

    it("bids on busy mirrors only, below the source price", async () => {
        const h = harness({ lp, cfg: cfg(5) } as never);
        mirror(h, "busy", 50_000);
        mirror(h, "quiet", 10);
        await inner(h.keeper).plan();
        expect(kinds(h, "lp-liquidity").map((w) => [w.id, w.payload])).toEqual([["lp:busy:bids", { side: "buy", sets: "5", yesBid: "580", noBid: "380" }]]);
    });

    it("posts no bids on a stale or decided source price, and cancels the LP's live bid there", async () => {
        const h = harness({ lp, cfg: cfg(5) } as never);
        mirror(h, "stale", 50_000);
        run(h.db, "UPDATE markets SET source_snapshot = json_set(source_snapshot, '$.fetchedAt', '2026-01-01T00:00:00.000Z') WHERE id = 'stale'");
        mirror(h, "decided", 50_000, "0.97", "0.03");
        mirror(h, "early", 50_000);
        run(h.db, "UPDATE markets SET resolution_status = 'source-final' WHERE id = 'early'");
        for (const id of ["stale", "decided", "early"]) quote(h, `bid-${id}`, id, "yes", "buy", 100n);
        await inner(h.keeper).plan();
        expect(kinds(h, "lp-liquidity")).toEqual([]);
        expect(kinds(h, "cancel-offer").map((w) => w.id).sort()).toEqual(["cancel:bid-decided:0:unquotable", "cancel:bid-early:0:unquotable", "cancel:bid-stale:0:unquotable"]);
    });

    it("posts no bids with LP_BID_SETS=0", async () => {
        const h = harness({ lp, cfg: cfg(0) } as never);
        mirror(h, "busy", 50_000);
        await inner(h.keeper).plan();
        expect(kinds(h, "lp-liquidity")).toEqual([]);
    });

    it("holds bids that would cross the LP's own live ask", async () => {
        const h = harness({ lp, cfg: cfg(5) } as never);
        mirror(h, "busy", 50_000);
        quote(h, "staleAsk", "busy", "yes", "sell", 570n);
        await inner(h.keeper).plan();
        expect(kinds(h, "lp-liquidity")).toEqual([]);
    });

    it("reprices drifted bids, moving first the one that keeps the LP's bids under a unit", async () => {
        const h = harness({ lp, cfg: cfg(0) } as never);
        mirror(h, "pm", 50_000, "0.2", "0.8");
        quote(h, "yesBid", "pm", "yes", "buy", 50n);
        quote(h, "noBid", "pm", "no", "buy", 900n);
        await inner(h.keeper).plan();
        expect(kinds(h, "lp-reprice").map((w) => [w.id, w.payload.price])).toEqual([["reprice:noBid:0", "780"]]);

        run(h.db, "UPDATE offers SET status = 'cancelled' WHERE id = 'noBid:0'");
        await inner(h.keeper).plan();
        expect(kinds(h, "lp-reprice").map((w) => [w.id, w.payload.price]).sort()).toEqual([["reprice:noBid:0", "780"], ["reprice:yesBid:0", "180"]]);
    });
});

describe("workflow priority", () => {
    it("runs a resolution, then an activation, ahead of a backlog of older liquidity retries", () => {
        const h = harness({});
        for (let i = 0; i < 25; i++) {
            run(h.db, "INSERT INTO workflows(id, kind, market_id, state, payload, next_at, created_at, updated_at) VALUES (?, 'lp-liquidity', NULL, 'pending', '{}', 0, ?, ?)",
                `lp:${i}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`, "2026-01-01T00:00:00.000Z");
        }
        run(h.db, "INSERT INTO workflows(id, kind, market_id, state, payload, next_at, created_at, updated_at) VALUES ('resolve:m', 'resolve', NULL, 'pending', '{}', 0, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')");
        run(h.db, "INSERT INTO workflows(id, kind, market_id, state, payload, next_at, created_at, updated_at) VALUES ('activate:n', 'activate', NULL, 'pending', '{}', 0, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')");
        const due = h.wf.due(20).map((w) => w.id);
        expect(due.slice(0, 3)).toEqual(["resolve:m", "activate:n", "lp:0"]);
        expect(due).toHaveLength(20);
    });
});

describe("in-flight submissions", () => {
    it("never fails a submission whose outcome is unknown, however often reconciliation throws", async () => {
        const indexer = { getVirtualTxs: async () => ({ txs: [] }), getVtxos: async () => { throw new Error("indexer down"); } };
        const h = harness({ net: { indexer, ctx: {}, exitDelaySeconds: 512n } } as never);
        insertMarket(h.db, { id: "m1" });
        run(h.db, "INSERT INTO workflows(id, kind, market_id, state, payload, txid, attempts, created_at, updated_at) VALUES ('activate:m1', 'activate', 'm1', 'submitting', ?, ?, 9, 't', 't')",
            JSON.stringify({ inputs: ["aa:0"] }), "bb".repeat(32));
        await (h.keeper as unknown as { execute(wf: unknown): Promise<void> }).execute(h.wf.get("activate:m1"));
        expect(h.wf.get("activate:m1")).toMatchObject({ state: "submitting", txid: "bb".repeat(32), payload: { inputs: ["aa:0"] } });
    });
});
