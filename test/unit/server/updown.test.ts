import { describe, expect, it } from "vitest";
import { loadConfig } from "../../../src/server/config.js";
import { all } from "../../../src/server/db.js";
import { EventBus } from "../../../src/server/events.js";
import { WriterLease } from "../../../src/server/lease.js";
import { importUpDown, parseUpDownEvent, upcomingSlugs } from "../../../src/server/updown.js";
import { Workflows } from "../../../src/server/workflows.js";
import { tempDb } from "./harness.js";

const START = 1791609000;
const event = (over: Record<string, unknown> = {}, market: Record<string, unknown> = {}) => ({
    slug: `btc-updown-15m-${START}`,
    markets: [{
        id: "900001", question: "Bitcoin Up or Down - October 10, 1:10AM-1:25AM ET", endDate: new Date((START + 900) * 1000).toISOString(),
        outcomes: '["Up", "Down"]', outcomePrices: '["0.52", "0.48"]', resolutionSource: "https://data.chain.link/streams/btc-usd-twap-60s-streams",
        image: "https://polymarket-upload.s3.us-east-2.amazonaws.com/btc.png", ...market,
    }],
    ...over,
});

describe("Polymarket Up/Down mirrors", () => {
    it("parses only well-formed Up/Down events on round boundaries", () => {
        expect(parseUpDownEvent(event())).toMatchObject({ feed: "BTC", window: "15m", startAtMs: START * 1000, endAtMs: (START + 900) * 1000,
            referencePrices: [{ outcome: "Up", price: "0.52" }, { outcome: "Down", price: "0.48" }] });
        expect(parseUpDownEvent(event({ slug: "will-btc-hit-100k" }))).toBeUndefined();
        expect(parseUpDownEvent(event({}, { endDate: new Date((START + 901) * 1000).toISOString() }))).toBeUndefined();
        expect(parseUpDownEvent(event({}, { outcomes: '["Yes", "No"]' }))).toBeUndefined();
        expect(parseUpDownEvent(event({}, { image: "https://evil.example/x.png" }))!.image).toBeNull();
    });

    it("names the upcoming events by slug: window boundaries past the activation lead, up to the lead horizon", () => {
        const at = START * 1000 - 100_000;
        expect(upcomingSlugs(["5m", "15m"], ["BTC", "eth"], 600, at)).toEqual([
            `btc-updown-5m-${START}`, `eth-updown-5m-${START}`, `btc-updown-5m-${START + 300}`, `eth-updown-5m-${START + 300}`,
            `btc-updown-15m-${START + 300}`, `eth-updown-15m-${START + 300}`,
        ]);
    });

    it("imports mirrors within the lead window and the cap, once each", () => {
        const { db } = tempDb();
        const lease = new WriterLease(db);
        lease.tryAcquire();
        const cfg = loadConfig({ APM_NETWORK: "regtest", ARK_SERVER_URL: "http://a", EMULATOR_URL: "http://e", ESPLORA_URL: "http://s", UPDOWN_MAX_ACTIVE: "2" });
        expect(cfg.UPDOWN_WINDOWS).toEqual(["15m", "4h"]);
        const d = { cfg, db, bus: new EventBus(db), wf: new Workflows(db, lease) } as never;
        const at = START * 1000 - 600_000;
        const mk = (n: number, asset = "btc") => parseUpDownEvent(event({ slug: `${asset}-updown-15m-${START + n * 900}` }, { id: `9000${n}`, endDate: new Date((START + n * 900 + 900) * 1000).toISOString() }))!;
        const created = importUpDown(d, [mk(0), mk(1), mk(2), mk(3, "pepe")], at);
        expect(created).toHaveLength(2);
        expect(importUpDown(d, [mk(0)], at)).toEqual([]);
        expect(importUpDown(d, [parseUpDownEvent(event({}, { id: "too-soon" }))!], START * 1000 - 30_000)).toEqual([]);
        const rows = all<{ oracle_policy: string; status: string; source_snapshot: string }>(db, "SELECT oracle_policy, status, source_snapshot FROM markets");
        expect(rows.every((r) => r.oracle_policy === "redstone" && r.status === "activating")).toBe(true);
        expect(JSON.parse(rows[0]!.source_snapshot).updown).toEqual({ feed: "BTC", startAtMs: START * 1000, endAtMs: (START + 900) * 1000 });
    });
});
