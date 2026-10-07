import claimBoxArtifact from "../../contracts/artifacts/claim_box.json" with { type: "json" };
import type { Coin } from "./arkadeTx.js";
import { contractCoin, execute, type Ctx } from "./actions.js";
import { marketContracts, type ArkadeClient, type Contract, type VaultTerms } from "./market.js";
import { BINARY_VECTORS, redemptionPayout, type BinaryOutcome } from "./payout.js";
import { loadProgram, type ContractArtifact } from "./programs.js";

export const CLAIM_BOX_PROGRAM = loadProgram(claimBoxArtifact as ContractArtifact);
export const CLAIM_BOX_TEMPLATE = claimBoxArtifact.fingerprint;

export interface BoxOwner {
    /** x-only key that can always withdraw (with the operator) or exit after the CSV delay. */
    owner: Uint8Array;
    /** P2TR pkScript that receives the automatic payout. */
    ownerScript: Uint8Array;
}

export function claimBoxContract(ark: ArkadeClient, terms: VaultTerms, o: BoxOwner): Contract {
    const { resolved } = marketContracts(ark, terms);
    return ark.contract(CLAIM_BOX_PROGRAM, {
        owner: o.owner,
        ownerProgram: o.ownerScript.slice(2),
        resolvedYes: resolved.yes.pkScript.slice(2),
        resolvedNo: resolved.no.pkScript.slice(2),
        resolvedInvalid: resolved.invalid.pkScript.slice(2),
        exit: terms.exitDelaySeconds,
    });
}

const held = (c: Coin, id: string) => (c.assets ?? []).filter((a) => a.assetId === id).reduce((s, a) => s + a.amount, 0n);

/** Permissionless: burns every claim in the box against the resolved vault and pays the owner. */
export async function autoClaim(ctx: Ctx, terms: VaultTerms, outcome: BinaryOutcome, o: BoxOwner, box: Coin) {
    const vault = marketContracts(ctx.ark, terms).resolved[outcome];
    const coin = await contractCoin(ctx, vault, terms.assets.ctrl);
    if (!coin) throw new Error("resolved vault not found");
    const yesBurn = held(box, terms.assets.yes);
    const noBurn = held(box, terms.assets.no);
    if (yesBurn + noBurn === 0n) throw new Error("box holds no claims");
    const payout = redemptionPayout([yesBurn, noBurn], BINARY_VECTORS[outcome], terms.unitSats);
    const result = await execute(ctx, [
        { kind: "covenant", coin, contract: vault, fn: "redeem", args: { yesBurn, noBurn } },
        { kind: "covenant", coin: box, contract: claimBoxContract(ctx.ark, terms, o), fn: "claim" },
    ], [
        { script: vault.pkScript, amount: BigInt(coin.value) - payout, assets: [{ assetId: terms.assets.ctrl, amount: 1n }] },
        { script: o.ownerScript, amount: BigInt(box.value) + payout },
    ]);
    return { ...result, payout };
}
