import { arkade } from "@arkade-os/sdk";

export type Program = ReturnType<typeof arkade.programFromArtifact>;
export type ContractArtifact = Parameters<typeof arkade.programFromArtifact>[0];

/**
 * Compiler artifact -> SDK Program. SDK 0.4.78 binds a `$param` CSV operand as a block-typed
 * timelock (artifact.ts csvTimelock); arkd rejects block CSV when the operator runs seconds-based
 * locktimes, so param-bound CSV operands are rebound as seconds (must be a multiple of 512).
 */
export function loadProgram(artifact: ContractArtifact): Program {
    const program = arkade.programFromArtifact(flattenPoints(artifact));
    for (const fn of Object.values(program.functions)) {
        const csv = fn.tapscript.csv;
        if (csv && typeof csv.value === "string") fn.tapscript.csv = { type: "seconds", value: csv.value };
    }
    return program;
}

// SDK 0.4.78 has no ECPoint/G2Point types; the compiler already lays them out as per-field int slots.
const POINT_FIELDS: Record<string, string[]> = { ECPoint: ["x", "y"], G2Point: ["xC1", "xC0", "yC1", "yC0"] };
type Input = { name: string; type: string };
const flatten = (inputs: Input[]): Input[] =>
    inputs.flatMap((i) => (POINT_FIELDS[i.type] ? POINT_FIELDS[i.type]!.map((f) => ({ name: `${i.name}.${f}`, type: "int" })) : [i]));

function flattenPoints(artifact: ContractArtifact): ContractArtifact {
    const a = structuredClone(artifact) as unknown as { constructorInputs: Input[]; functions: { arkade?: { inputs: Input[] } }[] };
    a.constructorInputs = flatten(a.constructorInputs);
    for (const f of a.functions) if (f.arkade) f.arkade.inputs = flatten(f.arkade.inputs);
    return a as unknown as ContractArtifact;
}
