import { describe, expect, it } from "vitest";
import { selectWalletInputs, type Party } from "../../../src/core/actions.js";

const coin = (txid: string, value: number, assets: { assetId: string; amount: bigint }[] = []) =>
    ({ txid, vout: 0, value, assets, tapTree: new Uint8Array(), forfeitTapLeafScript: {} as never });
const party = (keepAssetsApart: boolean): Party =>
    ({ identity: {} as never, script: new Uint8Array(), keepAssetsApart, coins: async () => [coin("plain", 1000), coin("ctrlA", 5000, [{ assetId: "ctrl-a", amount: 1n }])] });

describe("wallet coin selection", () => {
    it("funds sats from asset-carrying coins unless the party keeps assets apart", async () => {
        expect((await selectWalletInputs(party(false), 3000n, [], 1)).map((i) => i.coin.txid).sort()).toEqual(["ctrlA", "plain"]);
        await expect(selectWalletInputs(party(true), 3000n, [], 1)).rejects.toThrow(/insufficient funds: have 1000 sats/);
        expect((await selectWalletInputs(party(true), 5500n, [{ assetId: "ctrl-a", amount: 1n }], 1)).map((i) => i.coin.txid).sort()).toEqual(["ctrlA", "plain"]);
    });
});
