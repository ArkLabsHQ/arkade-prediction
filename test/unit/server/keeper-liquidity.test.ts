import { beforeEach, describe, expect, it, vi } from "vitest";
import { hex } from "@scure/base";
import { lpAsks, lpExpiry } from "../../../src/server/keeper.js";
import { ASSETS, harness, insertMarket, P2TR } from "./harness.js";
import { run } from "../../../src/server/db.js";
import type { OfferTermsJson } from "../../../src/shared/api.js";

interface PostArgs { marketId: string; terms: OfferTermsJson; fundingTxid: string }
const calls: { mints: bigint[]; posts: { expiresAt: bigint; priceSats: bigint }[]; registers: PostArgs[] } = {
    mints: [], posts: [], registers: [],
};
let failNextRegister: string | undefined;

vi.mock("../../../src/core/actions.js", async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    mintSets: async (_c: unknown, _p: unknown, _t: unknown, n: bigint) => {
        calls.mints.push(n);
        return { txid: `MINT_${n}` };
    },
    postOffer: async (_c: unknown, _p: unknown, terms: { expiresAt: bigint; priceSats: bigint }) => {
        calls.posts.push({ expiresAt: terms.expiresAt, priceSats: terms.priceSats });
        return { txid: `POST_${calls.posts.length}` };
    },
}));

vi.mock("../../../src/core/offers.js", async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    offerContract: () => ({ pkScript: new Uint8Array(34) }),
}));

vi.mock("../../../src/server/offers.js", async (orig) => ({
    ...(await orig<Record<string, unknown>>()),
    registerOffer: async (_d: unknown, req: PostArgs) => {
        if (failNextRegister) {
            const e = failNextRegister;
            failNextRegister = undefined;
            throw new Error(e);
        }
        calls.registers.push(req);
        return {};
    },
}));

const lp = {
    script: Uint8Array.from(Buffer.from(P2TR("bb"), "hex")),
    identity: { xOnlyPublicKey: async () => hex.decode("11".repeat(32)) },
    coins: async () => [{ assets: [{ assetId: ASSETS.yes, amount: 1000n }, { assetId: ASSETS.no, amount: 1000n }] }],
} as never;

const nowS = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
    calls.mints = [];
    calls.posts = [];
    calls.registers = [];
    failNextRegister = undefined;
});

describe("LP liquidity", () => {
    const setup = (closeAt: number, status = "open") => {
        const h = harness({ lp, cfg: { APM_NETWORK: "regtest", MARKET_UNIT_SATS: 1000 } as never });
        insertMarket(h.db, { id: "m1", closeAt, status });
        h.fakes.vtxos = [1, 2, 3].map((i) => ({ txid: `POST_${i}`, vout: 0, isSpent: false }));
        return h;
    };
    const liquidity = async (h: ReturnType<typeof harness>) => {
        const w = h.wf.get("lp:m1:bootstrap") ?? h.wf.enqueue("lp:m1:bootstrap", "lp-liquidity", "m1", { sets: "5", yesAsk: "400", noAsk: "500" });
        await h.keeper.execute(w);
        return h.wf.get("lp:m1:bootstrap")!;
    };

    it("expires every offer no later than the market close, with jitter", async () => {
        const closeAt = nowS() + 3600;
        const h = setup(closeAt);
        await liquidity(h);

        expect(calls.posts).toHaveLength(2);
        for (const p of calls.posts) {
            expect(p.expiresAt).toBeLessThanOrEqual(BigInt(closeAt));
            expect(p.expiresAt).toBeGreaterThan(BigInt(nowS()));
        }
    });

    it("stops quoting when the event starts, not at the close", async () => {
        const start = nowS() + 1800;
        const h = setup(nowS() + 3 * 3600);
        run(h.db, "UPDATE markets SET source_snapshot = ? WHERE id = 'm1'", JSON.stringify({ gameStartTime: new Date(start * 1000).toISOString() }));
        await liquidity(h);
        expect(calls.posts).toHaveLength(2);
        for (const p of calls.posts) expect(p.expiresAt).toBeLessThanOrEqual(BigInt(start));

        calls.posts.length = 0;
        const live = setup(nowS() + 3 * 3600);
        run(live.db, "UPDATE markets SET source_snapshot = ? WHERE id = 'm1'", JSON.stringify({ gameStartTime: new Date((nowS() - 60) * 1000).toISOString() }));
        await liquidity(live);
        expect(calls.posts).toHaveLength(0);
    });

    it("posts for a market closing in two minutes but not within one minute", async () => {
        const soon = setup(nowS() + 120);
        await liquidity(soon);
        expect(calls.posts).toHaveLength(2);

        calls.posts.length = 0;
        const tooLate = setup(nowS() + 45);
        await liquidity(tooLate);
        expect(calls.posts).toHaveLength(0);
    });

    it("does not mint or post into a halted market", async () => {
        const h = setup(nowS() + 3600, "halted");
        await liquidity(h);
        expect(calls.posts).toHaveLength(0);
        expect(calls.mints).toHaveLength(0);
    });

    it("stores each offer's terms before posting and retries only the registration", async () => {
        const h = setup(nowS() + 3600);
        failNextRegister = "fetch failed";
        const failed = await liquidity(h);
        expect(calls.posts).toHaveLength(1);
        expect((failed.payload.yesTerms as OfferTermsJson).priceSats).toBe("400");
        expect(failed.payload.yesFundingTxid).toBe("POST_1");
        expect(failed.payload.yesRegistered).toBeUndefined();
        expect(failed.state).not.toBe("done");

        await liquidity(h);
        expect(calls.mints).toEqual([5n]);
        expect(calls.posts).toHaveLength(2);
        expect(calls.registers.map((r) => r.terms.priceSats)).toEqual(["400", "500"]);
        expect(calls.registers[0]!.terms.expiresAtUnix).toBe(String(calls.posts[0]!.expiresAt));
    });

    it("treats a duplicate registration as already registered", async () => {
        const h = setup(nowS() + 3600);
        failNextRegister = "an identical live offer exists; vary the expiry";
        await liquidity(h);
        expect(h.wf.get("lp:m1:bootstrap")!.payload.yesRegistered).toBe(true);
        expect(h.wf.get("lp:m1:bootstrap")!.state).toBe("done");
    });
});

describe("LP offer expiry", () => {
    it("never outlives the market and never lands in the past", () => {
        for (const window of [601, 1800, 86_400, 60 * 86_400]) {
            for (const jitter of [0, 0.5, 0.999999]) {
                const closeAt = 2_000_000 + window;
                const e = lpExpiry(closeAt, 2_000_000, jitter);
                expect(e).toBeLessThanOrEqual(BigInt(closeAt));
                expect(e).toBeGreaterThan(2_000_000n);
            }
        }
    });
});

describe("LP opening asks", () => {
    const fixed = { yes: 550n, no: 550n };
    const ref = (yes: string, no: string) => [{ outcome: "Yes", price: yes }, { outcome: "No", price: no }];

    it("quotes the source price plus the half-spread on each side", () => {
        expect(lpAsks(ref("0.012", "0.988"), ["Yes", "No"], 1000n, fixed)).toEqual({ yes: 32n, no: 999n });
        expect(lpAsks(ref("0.6", "0.4"), ["Yes", "No"], 1000n, fixed)).toEqual({ yes: 620n, no: 420n });
    });

    it("falls back to the fixed asks without a usable price or when both legs together would undercut a set", () => {
        expect(lpAsks(null, ["Yes", "No"], 1000n, fixed)).toBe(fixed);
        expect(lpAsks(ref("0.5", "0.5"), ["A", "B"], 1000n, fixed)).toBe(fixed);
        expect(lpAsks(ref("0.2", "0.2"), ["Yes", "No"], 1000n, fixed)).toBe(fixed);
    });
});
