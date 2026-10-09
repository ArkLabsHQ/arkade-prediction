import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RedStonePackage } from "../../../src/core/redstone.js";
import { run } from "../../../src/server/db.js";
import { captureTick, neededRounds, storedRound } from "../../../src/server/rounds.js";
import { insertMarket, tempDb } from "./harness.js";

const packages: RedStonePackage[] = JSON.parse(readFileSync(new URL("../../fixtures/redstone/btc-packages.json", import.meta.url), "utf8")).BTC;
const T = packages[0]!.timestampMilliseconds;
const gateway = (served: RedStonePackage[]) => (async () => new Response(JSON.stringify({ BTC: served }))) as unknown as typeof fetch;

function setup() {
    const { db } = tempDb();
    insertMarket(db, { id: "ud" });
    run(db, "UPDATE markets SET kind = 'polymarket', oracle_policy = 'redstone', source_snapshot = ? WHERE id = 'ud'", JSON.stringify({ updown: { feed: "BTC", startAtMs: T, endAtMs: T + 300_000 } }));
    return db;
}

describe("RedStone round capture", () => {
    it("needs a round only while it is live and not yet stored", () => {
        const db = setup();
        expect(neededRounds(db, T - 60_000)).toEqual([]);
        expect(neededRounds(db, T + 2_000)).toEqual([{ feed: "BTC", roundMs: T }]);
        expect(neededRounds(db, T + 301_000)).toEqual([{ feed: "BTC", roundMs: T + 300_000 }]);
        expect(neededRounds(db, T + 600_000)).toEqual([]);
    });

    it("stores the round when a gateway serves it with a quorum of signers, and not otherwise", async () => {
        const db = setup();
        const skipped = packages.map((p) => ({ ...p, timestampMilliseconds: T + 20_000 }));
        expect(await captureTick(db, 3, gateway(skipped), T + 15_000)).toBe(0);
        expect(await captureTick(db, 3, gateway(packages.slice(0, 2)), T + 15_000)).toBe(0);
        expect(await captureTick(db, 3, gateway(packages), T + 15_000)).toBe(1);
        expect(storedRound(db, "BTC", T)).toHaveLength(5);
        expect(neededRounds(db, T + 15_000)).toEqual([]);
    });
});
