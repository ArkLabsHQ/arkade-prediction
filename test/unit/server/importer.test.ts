import { describe, expect, it } from "vitest";
import { run, one } from "../../../src/server/db.js";
import { importOnce, upsertSource } from "../../../src/server/importer.js";
import type { SourceMarket } from "../../../src/server/sources/types.js";
import { insertMarket, tempDb } from "./harness.js";

const market = (versionHash: string, price: string): SourceMarket => ({
    provider: "polymarket", sourceId: "42", slug: "s", url: "", question: "q", description: "", resolutionSource: "", outcomes: ["Yes", "No"],
    endDate: null, tags: [], active: true, closed: false, archived: false, sourceStatus: null,
    protocol: { version: "v1", chainId: 137, negRisk: false, resolver: null, conditionId: "c", questionId: "q", settlementContract: "x" },
    referencePrices: [{ outcome: "Yes", price }, { outcome: "No", price: "0.5" }], image: null, event: { title: "E", slug: "e" }, gameStartTime: null,
    versionHash, fetchedAt: `t-${price}`,
});

describe("source refresh", () => {
    it("refreshes display fields of the funded market only while its definition is unchanged", () => {
        const { db } = tempDb();
        insertMarket(db, { id: "m" });
        run(db, "UPDATE markets SET kind = 'polymarket', source_provider = 'polymarket', source_id = '42', source_version = 'v1', source_snapshot = ? WHERE id = 'm'",
            JSON.stringify({ ...market("v1", "0.1"), binding: { keep: true } }));
        const snap = () => JSON.parse(one<{ s: string }>(db, "SELECT source_snapshot s FROM markets WHERE id = 'm'")!.s);

        upsertSource({ db } as never, market("v1", "0.3"), { eligible: true });
        expect(snap()).toMatchObject({ referencePrices: [{ price: "0.3" }, { price: "0.5" }], fetchedAt: "t-0.3", event: { title: "E" }, binding: { keep: true } });

        upsertSource({ db } as never, { ...market("v1", "0.4"), image: null, event: null }, { eligible: true });
        expect(snap()).toMatchObject({ referencePrices: [{ price: "0.4" }, { price: "0.5" }], event: { title: "E" } });

        upsertSource({ db } as never, market("v2", "0.9"), { eligible: true });
        expect(snap().referencePrices[0].price).toBe("0.4");
    });

    it("refreshes a funded market that discovery did not return", async () => {
        const { db } = tempDb();
        insertMarket(db, { id: "m" });
        run(db, "UPDATE markets SET kind = 'polymarket', source_provider = 'polymarket', source_id = '42', source_version = 'v1', source_snapshot = ? WHERE id = 'm'",
            JSON.stringify(market("v1", "0.1")));
        const provider = {
            discoverMarkets: async () => ({ markets: [], next: null }),
            fetchMarketDefinition: async () => market("v1", "0.7"),
            evaluateEligibility: () => ({ eligible: false, code: "horizon", reason: "" }),
        };
        const cfg = { IMPORT_MAX_PAGES: 1, IMPORT_PAGE_LIMIT: 100, IMPORT_TAGS: [], IMPORT_MAX_HORIZON_SECONDS: 1, IMPORT_MIN_HORIZON_SECONDS: 0 };
        await importOnce({ db, cfg, provider } as never);
        expect(JSON.parse(one<{ s: string }>(db, "SELECT source_snapshot s FROM markets WHERE id = 'm'")!.s).referencePrices[0].price).toBe("0.7");
    });
});
