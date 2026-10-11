// Client for the Arkade wallet app links: connect shares an address and x-only
// pubkey, send pays a BIP21. The wallet asks before either, then navigates back.
import { ArkAddress, type Identity, type TapLeafScript, type Wallet, type WalletBalance } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { scriptOfAddress, type Party } from "../core/actions.js";
import type { Chain, Session } from "./chain.js";
import type { Keystore } from "./keystore.js";

const KEY = "apm.arkadeLink.v1";
export const ARKADE_WALLET = "https://arkade.money";
export const EXTERNAL_SIGN = "The Arkade app holds this key. Create a wallet in this browser to sign.";
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface ArkLink { address: string; pubkey: string }
export type LinkResult = { ok: true; link: ArkLink } | { ok: false; error: "denied" | "invalid" | "mismatch" };

export function arkadeCallbackAllowed(callback: string): boolean {
    try {
        const url = new URL(callback);
        if (url.username || url.password || callback.length > 2000) return false;
        return url.protocol === "https:" || (url.protocol === "http:" && LOCAL.has(url.hostname));
    } catch {
        return false;
    }
}

export function arkadeConnectUrl(callback: string): string {
    return `${ARKADE_WALLET}/?${new URLSearchParams({ action: "connect", callback })}`;
}

export function arkadeSendUrl(request: string, callback?: string): string {
    const q = new URLSearchParams({ action: "send", request });
    if (callback) q.set("callback", callback);
    return `${ARKADE_WALLET}/?${q}`;
}

export function loadLink(): ArkLink | null {
    try {
        const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as ArkLink | null;
        return v?.address && /^[0-9a-f]{64}$/.test(v.pubkey) ? v : null;
    } catch {
        return null;
    }
}
export const saveLink = (link: ArkLink) => localStorage.setItem(KEY, JSON.stringify(link));
export const forgetLink = () => localStorage.removeItem(KEY);

/** Read a connect callback once. Leaves any other query string alone. */
export function takeConnectReturn(search: string, serverKey: string): { result: LinkResult | null; search: string } {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    const address = params.get("address");
    const pubkey = params.get("pubkey");
    const error = params.get("error");
    if (!(address && pubkey) && error !== "denied" && error !== "invalid") return { result: null, search };
    for (const key of ["address", "pubkey", "error", "status", "txid"]) params.delete(key);
    const next = params.size ? `?${params}` : "";
    if (error) return { result: { ok: false, error: error === "denied" ? "denied" : "invalid" }, search: next };
    if (!pubkey || !/^[0-9a-fA-F]{64}$/.test(pubkey)) return { result: { ok: false, error: "invalid" }, search: next };
    try {
        const got = hex.encode(ArkAddress.decode(address!).serverPubKey);
        if (got.toLowerCase() !== serverKey.toLowerCase().replace(/^0x/, "").slice(-64)) {
            return { result: { ok: false, error: "mismatch" }, search: next };
        }
    } catch {
        return { result: { ok: false, error: "invalid" }, search: next };
    }
    return { result: { ok: true, link: { address: address!, pubkey: pubkey.toLowerCase() } }, search: next };
}

const deny = () => { throw new Error(EXTERNAL_SIGN); };

/** Watch-only session. The Arkade app holds the key, so signing throws. */
export function openLinkedSession(chain: Chain, link: ArkLink): Session {
    const script = scriptOfAddress(link.address);
    const identity = {
        xOnlyPublicKey: async () => hex.decode(link.pubkey),
        compressedPublicKey: async () => deny(),
        sign: async () => deny(),
        signMessage: async () => deny(),
        signerSession: () => deny(),
    } as Identity;
    const party: Party = {
        identity, script,
        coins: async () => {
            const { vtxos } = await chain.indexer.getVtxos({ scripts: [hex.encode(script)], spendableOnly: true });
            return vtxos.filter((v) => !v.isSpent).map((v) => ({
                txid: v.txid, vout: v.vout, value: v.value, assets: v.assets,
                tapTree: new Uint8Array(), forfeitTapLeafScript: [] as unknown as TapLeafScript,
            }));
        },
    };
    const wallet = {
        getAddress: async () => link.address,
        dispose: async () => {},
        getBalance: async (): Promise<WalletBalance> => {
            const coins = await party.coins();
            const available = coins.reduce((s, c) => s + c.value, 0);
            const boarding = { confirmed: 0, unconfirmed: 0, total: 0 };
            return {
                boarding, settled: available, preconfirmed: 0, available, gated: 0, intentLocked: 0,
                recoverable: 0, pendingRecovery: 0, unrolled: 0, total: available, assets: [], availableAssets: [],
            };
        },
    } as unknown as Wallet;
    return {
        wallet, identity, party, external: true,
        keystore: { secrets: { mnemonic: "", oracleKeys: {} } } as Keystore,
        address: link.address, script: hex.encode(script), pubkey: link.pubkey,
    };
}
