import { beforeAll, describe, expect, it } from "vitest";
import { assetIdOf } from "../../../src/core/assets.js";
import { AuditError, auditGenesis } from "../../../src/core/audit.js";
import { genesisPacket, type ArkadeClient, type MarketAssets, type VaultTerms } from "../../../src/core/market.js";
import { BASE, UNIT, fresh, fundedMarket, offlineArk, p2tr, transfer, txWith, type Funding } from "./offline.js";

let ark: ArkadeClient;
beforeAll(async () => {
    ({ ark } = await offlineArk());
});

function scenario(v: Funding & { served?: (t: VaultTerms) => VaultTerms } = {}) {
    const f = fundedMarket(ark, v);
    return () => auditGenesis({ ark, indexer: f.indexer }, v.served?.(f.terms) ?? f.terms, f.genesisTxid, f.vaultTxid);
}

async function refusal(run: () => Promise<unknown>, code: string) {
    const err = await run().then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(AuditError);
    expect((err as AuditError).code).toBe(code);
}

describe("genesis audit (core, shared by server and browser)", () => {
    it("accepts an honest genesis and vault funding", async () => {
        expect(await scenario()()).toEqual({ seed: 2n, baseSats: BASE });
    });

    it("refuses a forged CTRL next to the real YES/NO", async () => {
        const attacker = txWith([{ script: p2tr(), amount: 330n }], genesisPacket("x", 0, 1n).groups);
        await refusal(scenario({ served: (t) => ({ ...t, assets: { ...t.assets, ctrl: assetIdOf(attacker.id, 0) } }) }), "asset-ids");
    });

    it("refuses any issuance beyond CTRL, YES and NO", async () => {
        await refusal(scenario({ genesis: [...genesisPacket("m", 0, 2n).groups, fresh(5n, null)] }), "genesis-shape");
    });

    it("refuses a CTRL that is not a fresh, uncontrolled supply of one", async () => {
        await refusal(scenario({ genesis: [fresh(2n, null), fresh(2n, 0), fresh(2n, 0)] }), "genesis-ctrl");
        await refusal(scenario({ genesis: [fresh(1n, 1), fresh(2n, 0), fresh(2n, 0)] }), "genesis-ctrl");
    });

    it("refuses claims that CTRL does not control", async () => {
        await refusal(scenario({ genesis: [fresh(1n, null), fresh(2n, null), fresh(2n, 0)] }), "genesis-claims");
    });

    it("refuses mismatched YES/NO seed supplies", async () => {
        await refusal(scenario({ genesis: [fresh(1n, null), fresh(2n, 0), fresh(1n, 0)] }), "genesis-seed");
    });

    it("refuses CTRL that left genesis through another tx", async () => {
        await refusal(scenario({ ctrlSpender: () => "ab".repeat(32) }), "genesis-ctrl-path");
    });

    it("refuses CTRL moved anywhere but the vault script of the served terms", async () => {
        await refusal(scenario({ vaultScript: () => p2tr() }), "vault-script");
        await refusal(scenario({ served: (t) => ({ ...t, timeoutAt: 0n }) }), "vault-script");
    });

    it("refuses a vault tx that reissues claims", async () => {
        const vaultGroups = (a: MarketAssets, seed: bigint) => [
            transfer(a.ctrl, [[0, 1n]], [[0, 1n]]),
            transfer(a.yes, [[0, seed]], [[1, seed + 5n]]),
            transfer(a.no, [[0, seed]], [[1, seed]]),
        ];
        await refusal(scenario({ vaultGroups }), "vault-reissue");
    });

    it("refuses a vault without the seed collateral plus a carrier", async () => {
        await refusal(scenario({ vaultSats: 2n * UNIT + 329n }), "vault-collateral");
    });

    it("reports transactions the indexer does not know", async () => {
        await refusal(scenario({ hideTxs: true }), "tx-not-found");
    });
});
