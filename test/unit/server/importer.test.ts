import { describe, expect, it } from "vitest";
import { run, one } from "../../../src/server/db.js";
import { importOnce, upsertSource } from "../../../src/server/importer.js";
import type { SourceMarket } from "../../../src/server/sources/types.js";
import { insertMarket, tempDb } from "./harness.js";

const market = (versionHash: string, price: string): SourceMarket => ({
    provider: "polymarket", sourceId: "42", slug: "s", url: "", question: "q", description: "", resolutionSource: "", outcomes: ["Yes", "No"],
    endDate: null, tags: [], active: true, closed: false, archived: false, sourceStatus: null,
    protocol: { version: "v1", chainId: 137, negRisk: false, resolver: null, conditionId: "c", questionId: "q", settlementContract: "x" },
    referencePrices: [{ outcome: "Yes", price }, { outcome: "No", price: "0.5" }], image: null, event: { title: "E", slug: "e" }, volume24h: Number(price) * 10_000, gameStartTime: null,
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
        expect(snap()).toMatchObject({ referencePrices: [{ price: "0.3" }, { price: "0.5" }], fetchedAt: "t-0.3", volume24h: 3000, event: { title: "E" }, binding: { keep: true } });

        upsertSource({ db } as never, { ...market("v1", "0.4"), image: null, event: null }, { eligible: true });
        expect(snap()).toMatchObject({ referencePrices: [{ price: "0.4" }, { price: "0.5" }], event: { title: "E" } });

        upsertSource({ db } as never, market("v2", "0.9"), { eligible: true });
        expect(snap()).toMatchObject({ referencePrices: [{ price: "0.4" }, { price: "0.5" }], volume24h: 4000 });
    });

    it("refreshes a funded market that discovery did not return", async () => {
        const { db } = tempDb();
        insertMarket(db, { id: "m" });
        run(db, "UPDATE markets SET kind = 'polymarket', source_provider = 'polymarket', source_id = '42', source_version = 'v1', source_snapshot = ? WHERE id = 'm'",
            JSON.stringify(market("v1", "0.1")));
        const provider = {
            name: "polymarket", profile: "polymarket-ctf-v1-binary",
            discoverMarkets: async () => ({ markets: [], next: null }),
            fetchMarketDefinition: async () => market("v1", "0.7"),
            evaluateEligibility: () => ({ eligible: false, code: "horizon", reason: "" }),
        };
        const cfg = { IMPORT_MAX_PAGES: 1, IMPORT_PAGE_LIMIT: 100, IMPORT_TAGS: [], IMPORT_MAX_HORIZON_SECONDS: 1, IMPORT_MIN_HORIZON_SECONDS: 0 };
        await importOnce({ db, cfg, providers: [provider] } as never);
        expect(JSON.parse(one<{ s: string }>(db, "SELECT source_snapshot s FROM markets WHERE id = 'm'")!.s).referencePrices[0].price).toBe("0.7");
    });
});

describe("activation vetting", () => {
    const eligible = { ...market("v1", "0.5"), endDate: new Date(Date.now() + 86_400_000).toISOString() };
    const deps = (vetSource: () => Promise<{ ok: true } | { ok: false; reason: string }>) => {
        const { db } = tempDb();
        const provider = {
            name: "polymarket", profile: "polymarket-ctf-v1-binary", vetSource,
            discoverMarkets: async () => ({ markets: [eligible], next: null }),
            fetchMarketDefinition: async () => eligible,
            evaluateEligibility: () => ({ eligible: true, profile: "polymarket-ctf-v1-binary" }),
        };
        const cfg = {
            IMPORT_MAX_PAGES: 1, IMPORT_PAGE_LIMIT: 100, IMPORT_TAGS: [], IMPORT_MAX_HORIZON_SECONDS: 1e10, IMPORT_MIN_HORIZON_SECONDS: 0,
            IMPORT_MAX_ACTIVE: 5, IMPORT_MAX_PER_SECTION: 0, ORACLE_PUBKEYS: ["aa".repeat(32)], ORACLE_THRESHOLD: 1, ORACLE_EPOCH: 1,
        };
        return { db, d: { db, cfg, providers: [provider], wf: { enqueue: () => ({}) }, bus: { publish: () => {} }, timeoutDays: 60 } };
    };

    it("funds nothing when the chain does not vouch for the reporter, and records why", async () => {
        const { db, d } = deps(async () => ({ ok: false, reason: "question creator 0xdead is not allowlisted" }));
        const result = await importOnce(d as never);
        expect(result.activated).toEqual([]);
        expect(result.ineligibleByCode["unvetted-source"]).toBe(1);
        expect(one(db, "SELECT 1 FROM markets")).toBeUndefined();
        expect(one<{ code: string; eligible: number }>(db, "SELECT code, eligible FROM source_markets WHERE source_id = '42'"))
            .toMatchObject({ code: "unvetted-source", eligible: 0 });
    });

    it("funds nothing when too few attestors serve the source's profile", async () => {
        const { db, d } = deps(async () => ({ ok: true }));
        const result = await importOnce({ ...d, attestorProfiles: async () => new Map([["kalshi-api-v1-binary", 1]]) } as never);
        expect(result.ineligibleByCode["no-attestor"]).toBe(1);
        expect(one(db, "SELECT 1 FROM markets")).toBeUndefined();
    });

    it("re-checks the slot after vetting, when another pass took it meanwhile", async () => {
        let d!: ReturnType<typeof deps>["d"];
        const made = deps(async () => {
            insertMarket(made.db, { id: "other", status: "activating" });
            run(made.db, "UPDATE markets SET kind = 'polymarket', source_provider = 'polymarket', source_id = '42' WHERE id = 'other'");
            return { ok: true };
        });
        d = made.d;
        const result = await importOnce(d as never);
        expect(result.activated).toEqual([]);
        expect(one<{ n: number }>(made.db, "SELECT COUNT(*) n FROM markets")!.n).toBe(1);
    });

    it("activates the same market once the vet passes", async () => {
        const { db, d } = deps(async () => ({ ok: true }));
        const result = await importOnce(d as never);
        expect(result.activated).toHaveLength(1);
        expect(one(db, "SELECT 1 FROM markets")).toBeTruthy();
    });
});
