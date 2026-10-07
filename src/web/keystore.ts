import { schnorr } from "@noble/curves/secp256k1.js";
import { base64, hex } from "@scure/base";

const STORAGE_KEY = "apm.keystore.v1";
// OWASP's PBKDF2-HMAC-SHA256 figure; the floor for this app is 210k.
const ITERATIONS = 600_000;
export const MIN_PASSPHRASE = 10;

/** Everything secret this browser holds, encrypted as one blob. */
export interface Secrets {
    mnemonic: string;
    /** x-only oracle public key (hex) -> secret key (hex), for markets this wallet resolves. */
    oracleKeys: Record<string, string>;
}

interface Meta {
    v: 1;
    kdf: "PBKDF2-SHA256";
    iterations: number;
    salt: string;
    /** IndexedDB database holding this wallet's synced coins (not secret). */
    db: string;
}

export interface Keystore {
    key: CryptoKey;
    meta: Meta;
    secrets: Secrets;
}

const utf8 = new TextEncoder();
const bytes = (b: Uint8Array) => new Uint8Array(b);

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey("raw", utf8.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", hash: "SHA-256", salt: bytes(salt), iterations },
        base,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
    );
}

export const hasKeystore = () => localStorage.getItem(STORAGE_KEY) !== null;

export async function persist(ks: Keystore): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, ks.key, utf8.encode(JSON.stringify(ks.secrets)));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...ks.meta, iv: hex.encode(iv), ct: base64.encode(new Uint8Array(ct)) }));
}

export async function createKeystore(passphrase: string, mnemonic: string): Promise<Keystore> {
    if (passphrase.length < MIN_PASSPHRASE) throw new Error(`Passphrase must be at least ${MIN_PASSPHRASE} characters`);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const meta: Meta = {
        v: 1, kdf: "PBKDF2-SHA256", iterations: ITERATIONS, salt: hex.encode(salt),
        db: `apm-wallet-${hex.encode(crypto.getRandomValues(new Uint8Array(6)))}`,
    };
    const ks = { key: await deriveKey(passphrase, salt, ITERATIONS), meta, secrets: { mnemonic, oracleKeys: {} } };
    await persist(ks);
    return ks;
}

export async function unlockKeystore(passphrase: string): Promise<Keystore> {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) throw new Error("No wallet is stored in this browser");
    const { iv, ct, ...meta } = JSON.parse(raw) as Meta & { iv: string; ct: string };
    const key = await deriveKey(passphrase, hex.decode(meta.salt), meta.iterations);
    let plain: ArrayBuffer;
    try {
        plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(hex.decode(iv)) }, key, bytes(base64.decode(ct)));
    } catch {
        throw new Error("Wrong passphrase");
    }
    return { key, meta, secrets: JSON.parse(new TextDecoder().decode(plain)) as Secrets };
}

/** Deletes the encrypted secrets and the wallet's coin cache. Irreversible without the recovery phrase. */
export function forgetKeystore(): void {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) indexedDB.deleteDatabase((JSON.parse(raw) as Meta).db);
    localStorage.removeItem(STORAGE_KEY);
}

/** New x-only oracle key, persisted encrypted before it is ever shown or used. */
export async function addOracleKey(ks: Keystore): Promise<{ publicKey: string; secretKey: string }> {
    const { secretKey, publicKey } = schnorr.keygen();
    const pair = { publicKey: hex.encode(publicKey), secretKey: hex.encode(secretKey) };
    ks.secrets.oracleKeys[pair.publicKey] = pair.secretKey;
    await persist(ks);
    return pair;
}

export function isXOnlyKey(k: string): boolean {
    if (!/^[0-9a-f]{64}$/.test(k)) return false;
    try {
        schnorr.utils.lift_x(BigInt(`0x${k}`));
        return true;
    } catch {
        return false;
    }
}
