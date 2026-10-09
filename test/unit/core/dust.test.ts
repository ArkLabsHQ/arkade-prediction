import { describe, expect, it } from "vitest";
import { DUST_SATS, buildArkadeTx, type Network } from "../../../src/core/arkadeTx.js";
import { p2tr } from "./offline.js";

describe("subdust outputs", () => {
    it("refuses to build a transaction with an output below dust", async () => {
        await expect(buildArkadeTx({} as Network, [], [{ script: p2tr(), amount: DUST_SATS - 1n }])).rejects.toThrow(/below the 330-sat dust limit/);
    });
});
