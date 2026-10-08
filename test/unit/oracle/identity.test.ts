import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MarketDefinition } from "../../../src/core/definition.js";
import { openDb } from "../../../src/server/db.js";
import { EventBus } from "../../../src/server/events.js";
import { replayHistorical } from "../../../src/server/importer.js";
import { getMarket } from "../../../src/server/markets.js";
import { definitionMismatch, importedDefinition } from "../../../src/server/sources/definition.js";
import { PROFILE, createPolymarketProvider } from "../../../src/server/sources/polymarket/index.js";

const gamma = JSON.parse(readFileSync(new URL("../../fixtures/polymarket/gamma.json", import.meta.url), "utf8"));
const provider = createPolymarketProvider({
    rpcUrls: ["https://rpc-one.example", "https://rpc-two.example"],
    resolverAllowlist: ["0x65070be91477460d8a7aeeb94ef92fe056c2f2a7", "0x157ce2d672854c848c9b79c49a8cc6cc89176a49"],
    fetch: (async (input: string | URL | Request) => {
        const body = gamma.markets[new URL(String(input)).pathname.slice("/markets/".length)]?.response;
        return body ? Response.json(body) : new Response("not found", { status: 404 });
    }) as typeof fetch,
});

describe("attestor definition checks", () => {
    it("accepts the honest import and refuses swapped labels, another question or a changed source", async () => {
        const live = await provider.fetchMarketDefinition("4737427");
        const def = importedDefinition(live, PROFILE, 60);
        expect(def.outcomes).toEqual(["Over", "Under"]);
        expect(definitionMismatch(def, live, PROFILE)).toBeNull();
        expect(definitionMismatch({ ...def, question: `  ${def.question} ` }, live, PROFILE)).toBeNull();

        expect(definitionMismatch({ ...def, outcomes: ["Under", "Over"] }, live, PROFILE)).toMatch(/outcome labels/);
        expect(definitionMismatch({ ...def, question: `Will it not be true that ${def.question}` }, live, PROFILE)).toMatch(/question/);
        expect(definitionMismatch({ ...def, question: 7 as unknown as string }, live, PROFILE)).toMatch(/question/);
        expect(definitionMismatch(def, { ...live, outcomes: ["Under", "Over"] }, PROFILE)).toMatch(/source outcomes/);
        expect(definitionMismatch(def, { ...live, question: "Edited upstream?" }, PROFILE)).toMatch(/question/);
        expect(definitionMismatch(def, { ...live, protocol: { ...live.protocol, resolver: "0x157ce2d672854c848c9b79c49a8cc6cc89176a49" } }, PROFILE)).toMatch(/resolver/);
        expect(definitionMismatch({ ...def, source: null }, live, PROFILE)).toMatch(/source/);
    });

    it("accepts the definition the server builds for a historical replay", async () => {
        const db = openDb(join(mkdtempSync(join(tmpdir(), "apm-replay-")), "apm.sqlite"));
        const d = {
            cfg: { APM_NETWORK: "regtest", ORACLE_PUBKEYS: ["aa".repeat(32)], ORACLE_EPOCH: 1 } as never,
            db, bus: new EventBus(db), net: {} as never, wf: { enqueue: () => ({}) } as never, provider, timeoutDays: 60,
        };
        const row = getMarket(db, await replayHistorical(d, "2758339"))!;
        expect(row.category).toBe("historical replay");
        // Same construction as resolver.requestCertificate.
        const def: MarketDefinition = {
            question: row.question, rules: row.rules, outcomes: JSON.parse(row.outcomes), category: row.category,
            closeAtUnix: String(row.close_at), timeoutAtUnix: String(row.timeout_at), source: JSON.parse(row.source_snapshot!).binding,
        };
        expect(definitionMismatch(def, await provider.fetchMarketDefinition("2758339"), PROFILE)).toBeNull();
    });
});
