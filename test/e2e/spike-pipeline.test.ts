import { describe, expect, it } from "vitest";
import { loadProgram } from "../../src/core/programs.js";
import { hex } from "@scure/base";
import {
    connectArkade,
    faucet,
    loadArtifact,
    newWallet,
    randomP2TR,
    spendableAt,
    waitFor,
} from "./env.js";

// .ark source -> arkadec artifact -> programFromArtifact -> SDK contract -> emulator -> arkd.
describe("compiler artifact pipeline", () => {
    it("spends a compiled covenant through the emulator", { timeout: 180_000 }, async () => {
        const program = loadProgram(loadArtifact("spike_pay"));
        const ark = await connectArkade();
        const owner = await newWallet();
        const recipient = randomP2TR();
        const contract = ark.contract(program, {
            owner: await owner.identity.xOnlyPublicKey(),
            recipient: recipient.slice(2),
            maxFee: 0n,
            exit: 512n,
        });

        faucet(await owner.wallet.getAddress(), 30_000);
        await waitFor(async () => (await owner.wallet.getBalance()).available >= 30_000, { what: "faucet" });
        await owner.wallet.send({ address: contract.address, amount: 20_000 });
        const [coin] = await waitFor(async () => {
            const v = await spendableAt(contract.pkScript);
            return v.length > 0 && v;
        }, { what: "contract funding" });
        expect(coin!.value).toBe(20_000);

        await expect(
            contract.functions.forward!().from(coin!).to(randomP2TR(), 20_000n).send(),
        ).rejects.toThrow();
        await expect(
            contract.functions.forward!().from(coin!).to(recipient, 19_999n).change(randomP2TR()).send(),
        ).rejects.toThrow();

        const { txid } = await contract.functions.forward!().from(coin!).to(recipient, 20_000n).send();
        const [paid] = await waitFor(async () => {
            const v = await spendableAt(recipient);
            return v.length > 0 && v;
        }, { what: "recipient output" });
        expect(paid!.txid).toBe(txid);
        expect(paid!.value).toBe(20_000);
        console.log(`spike forward txid=${txid} contract=${hex.encode(contract.pkScript)}`);
    });
});
