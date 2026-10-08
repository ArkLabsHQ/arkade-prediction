import { describe, expect, it } from "vitest";
import { openDb, run } from "../../../src/server/db.js";
import { WriterLease } from "../../../src/server/lease.js";
import { harness, inner, insertBuyOffer, insertMarket, P2TR, tempDb } from "./harness.js";

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

describe("resolution planning", () => {
    it("waits for the close before planning a resolve, because the covenant refuses earlier ones", async () => {
        const h = harness();
        const nowS = Math.floor(Date.now() / 1000);
        insertMarket(h.db, { id: "early", closeAt: nowS + 600 });
        insertMarket(h.db, { id: "closed", closeAt: nowS - 5 });
        for (const id of ["early", "closed"]) {
            run(h.db, "INSERT INTO certificates(market_id, outcome, numerators, denominator, evidence_digest, signature, signer, issued_at) VALUES (?, 'yes', '[\"1\",\"0\"]', '1', 'e', 's', 'k', 't')", id);
        }
        await inner(h.keeper).plan();
        expect(h.wf.list({ state: "pending" }).filter((w) => w.kind === "resolve").map((w) => w.marketId)).toEqual(["closed"]);
    });
});
