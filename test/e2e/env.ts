import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
    EsploraProvider,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    RestArkProvider,
    RestEmulatorProvider,
    RestIndexerProvider,
    SingleKey,
    Wallet,
    arkade,
    networks,
} from "@arkade-os/sdk";
import { hex } from "@scure/base";
import type { ContractArtifact } from "../../src/core/programs.js";
import { randomBytes } from "@noble/hashes/utils.js";

export const ARK_URL = process.env.APM_ARK_URL ?? "http://localhost:37070";
export const EMULATOR_URL = process.env.APM_EMULATOR_URL ?? "http://localhost:37073";
export const ESPLORA_URL = process.env.APM_ESPLORA_URL ?? "http://localhost:37000/api";
const PREFIX = process.env.APM_CONTAINER_PREFIX ?? "apm-";
const STACK_ENV = new URL("../../infra/regtest/stack.env", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

export const arkProvider = new RestArkProvider(ARK_URL);
export const indexerProvider = new RestIndexerProvider(ARK_URL);
export const emulatorProvider = new RestEmulatorProvider(EMULATOR_URL);

export function arkdCli(...args: string[]): string {
    return execFileSync("docker", ["exec", `${PREFIX}arkd`, ...args], { encoding: "utf8" }).trim();
}

export function regtestCli(...args: string[]): string {
    return execFileSync("node", ["regtest/regtest.mjs", ...args, "--env", STACK_ENV], {
        encoding: "utf8",
    }).trim();
}

export function mine(blocks = 1): void {
    regtestCli("mine", String(blocks));
}

/** Pay `amount` sats offchain from the stack's funded ark CLI wallet. */
export function faucet(address: string, amount: number): void {
    arkdCli("ark", "send", "--to", address, "--amount", String(amount), "--password", "secret");
}

/**
 * The emulator answers every refusal with an opaque gRPC "internal error", so a bare rejection proves
 * nothing. Require its log to show an Arkade script failure emitted while this call ran.
 */
export async function expectCovenantRejection(attempt: Promise<unknown>, label: string): Promise<string> {
    const since = new Date(Date.now() - 1000).toISOString();
    const outcome = await attempt.then(
        () => undefined,
        (err: unknown) => err,
    );
    if (outcome === undefined) throw new Error(`${label}: spend was accepted but must be refused`);
    const r = spawnSync("docker", ["logs", `${PREFIX}emulator`, "--since", since], { encoding: "utf8" });
    const logs = `${r.stdout}\n${r.stderr}`;
    const line = logs.split("\n").reverse().find((l) => l.includes("failed to execute arkade script"));
    if (!line) throw new Error(`${label}: refused, but not by the covenant: ${String(outcome)}`);
    return line;
}

export async function waitFor<T>(
    probe: () => Promise<T | undefined | false>,
    { timeoutMs = 60_000, intervalMs = 500, what = "condition" } = {},
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await probe();
        if (value) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, intervalMs));
    }
}

export async function newWallet(secret = randomBytes(32)) {
    const identity = SingleKey.fromPrivateKey(secret);
    const wallet = await Wallet.create({
        identity,
        arkServerUrl: ARK_URL,
        onchainProvider: new EsploraProvider(ESPLORA_URL, { forcePolling: true, pollingInterval: 2000 }),
        storage: {
            walletRepository: new InMemoryWalletRepository(),
            contractRepository: new InMemoryContractRepository(),
        },
        settlementConfig: false,
    });
    return { wallet, identity, secret };
}

export async function connectArkade(identity?: SingleKey) {
    return arkade.Arkade.connect({
        arkade: arkProvider,
        emulator: emulatorProvider,
        indexer: indexerProvider,
        network: networks.regtest,
        ...(identity ? { identity } : {}),
    });
}

export function loadArtifact(name: string): ContractArtifact {
    const path = new URL(`../../contracts/artifacts/${name}.json`, import.meta.url);
    return JSON.parse(readFileSync(path, "utf8")) as ContractArtifact;
}

/** Random P2TR output script (OP_1 <32 bytes>). */
export function randomP2TR(): Uint8Array {
    return Uint8Array.from([0x51, 0x20, ...randomBytes(32)]);
}

export async function spendableAt(script: Uint8Array) {
    const { vtxos } = await indexerProvider.getVtxos({ scripts: [hex.encode(script)], spendableOnly: true });
    return vtxos;
}
