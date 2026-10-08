import { ESPLORA_URL } from "@arkade-os/sdk";

/**
 * Public endpoints per network. Esplora comes from the SDK; the SDK has no operator or emulator URL presets, so
 * those are Arkade's published hosts. Regtest has none: local stacks use their own ports.
 */
const ARKADE_HOSTS: Record<string, { arkServer: string; emulator: string }> = {
    mutinynet: { arkServer: "https://mutinynet.arkade.sh", emulator: "https://emulator.mutinynet.arkade.sh" },
};

export function defaultEndpoints(network: string): { arkServer?: string; emulator?: string; esplora?: string } {
    if (network === "regtest") return {};
    return { ...ARKADE_HOSTS[network], esplora: (ESPLORA_URL as Record<string, string>)[network] };
}
