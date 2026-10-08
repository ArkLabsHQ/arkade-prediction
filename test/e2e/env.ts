import "../../src/node/eventsource.js";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
    ArkNote,
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
import { schnorr } from "@noble/curves/secp256k1.js";

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

const FUNDER_SATS = 5_000_000;
let funder: { wallet: Wallet; freshUntil: number; left: number } | undefined;

function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms)));
    return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/**
 * Every coin a wallet sends inherits the batch expiry of the coins it spends. The stack's CLI wallet outlives runs
 * and spends its oldest coins first, so tests saw their coins swept mid-run (and its `redeem-notes` could hang).
 * Each process funds from an SDK wallet whose only coin is a fresh operator note redeemed into a new batch.
 */
async function freshFunder(amount: number): Promise<Wallet> {
    // Notes draw on the operator's batch liquidity, so keep them small and replace a spent funder.
    if (funder && Date.now() < funder.freshUntil && funder.left >= amount + 1000) return funder.wallet;
    const { wallet } = await newWallet();
    const sats = Math.max(FUNDER_SATS, amount + 1000);
    const note = ArkNote.fromString(arkdCli("arkd", "note", "--amount", String(sats)).split(/\s+/).pop()!);
    await within(wallet.settle({ inputs: [note], outputs: [{ address: await wallet.getAddress(), amount: BigInt(note.value) }] }), 180_000, "funder note redemption");
    funder = { wallet, freshUntil: Date.now() + 30 * 60_000, left: note.value };
    return wallet;
}

/** Pay `amount` sats offchain from a freshly funded wallet. */
export async function faucet(address: string, amount: number): Promise<void> {
    const wallet = await freshFunder(amount);
    await within(wallet.send({ address, amount }), 60_000, "faucet send");
    funder!.left -= amount;
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
    // Under load the emulator's log line can reach `docker logs` after its error reached us.
    for (let i = 0; i < 20; i++) {
        const r = spawnSync("docker", ["logs", `${PREFIX}emulator`, "--since", since], { encoding: "utf8" });
        const line = `${r.stdout}\n${r.stderr}`.split("\n").reverse().find((l) => l.includes("failed to execute arkade script"));
        if (line) return line;
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`${label}: refused, but not by the covenant: ${String(outcome)}`);
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

/** P2TR output script for a fresh key (random 32 bytes are a valid x-only point only ~half the time). */
export function randomP2TR(): Uint8Array {
    return Uint8Array.from([0x51, 0x20, ...schnorr.getPublicKey(randomBytes(32))]);
}

export async function spendableAt(script: Uint8Array) {
    const { vtxos } = await indexerProvider.getVtxos({ scripts: [hex.encode(script)], spendableOnly: true });
    return vtxos;
}
