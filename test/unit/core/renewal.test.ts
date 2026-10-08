import { describe, expect, it } from "vitest";
import { SingleKey, networks } from "@arkade-os/sdk";
import { marketContracts } from "../../../src/core/market.js";
import { renewCovenantVtxos, type RenewDeps } from "../../../src/core/renewal.js";
import { BASE, SEED, UNIT, fundedMarket, offlineArk } from "./offline.js";

describe("renewal deadline", () => {
    it("abandons a renewal whose batch never starts once the deadline passes", async () => {
        const { ark } = await offlineArk();
        const { vaultTxid, terms, indexer } = fundedMarket(ark);
        let registered = false;
        let streamOpened = false;
        const deps = {
            indexer,
            network: networks.regtest,
            emulator: { submitIntent: async ({ proof }: { proof: string }) => proof },
            ark: {
                registerIntent: async () => ((registered = true), "intent-1"),
                // Like a stalled SSE read: no events, and the abort signal does not end it.
                getEventStream: () => (async function* () {
                    streamOpened = true;
                    await new Promise(() => {});
                })(),
            },
        } as unknown as RenewDeps;
        const target = {
            coin: { txid: vaultTxid, vout: 0, value: Number(BASE + SEED * UNIT), assets: [{ assetId: terms.assets.ctrl, amount: 1n }] },
            contract: marketContracts(ark, terms).vault,
        };

        const started = Date.now();
        await expect(renewCovenantVtxos(deps, [target], SingleKey.fromRandomBytes().signerSession(), { signal: AbortSignal.timeout(300) }))
            .rejects.toThrow(/deadline/);
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(registered && streamOpened).toBe(true);
    });
});
