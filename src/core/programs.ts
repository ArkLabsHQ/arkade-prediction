import { arkade } from "@arkade-os/sdk";

export type Program = ReturnType<typeof arkade.programFromArtifact>;
export type ContractArtifact = Parameters<typeof arkade.programFromArtifact>[0];

/**
 * Compiler artifact -> SDK Program. SDK 0.4.78 binds a `$param` CSV operand as a block-typed
 * timelock (artifact.ts csvTimelock); arkd rejects block CSV when the operator runs seconds-based
 * locktimes, so param-bound CSV operands are rebound as seconds (must be a multiple of 512).
 */
export function loadProgram(artifact: ContractArtifact): Program {
    const program = arkade.programFromArtifact(artifact);
    for (const fn of Object.values(program.functions)) {
        const csv = fn.tapscript.csv;
        if (csv && typeof csv.value === "string") fn.tapscript.csv = { type: "seconds", value: csv.value };
    }
    return program;
}
