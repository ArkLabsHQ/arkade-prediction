// Client for the Arkade wallet app links: connect shares an address and x-only
// pubkey, send pays a BIP21. The wallet asks before either, then navigates back.
import { ArkAddress, type Identity, type TapLeafScript, type Wallet, type WalletBalance } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { scriptOfAddress, type Party } from "../core/actions.js";
import type { Chain, Session } from "./chain.js";
import type { Keystore } from "./keystore.js";

const KEY = "apm.arkadeLink.v1";
const NOTE = "apm.arkadeLink.note";
export const ARKADE_WALLET = "https://arkade.money";
export const EXTERNAL_SIGN = "The Arkade wallet can connect and pay in its own tab, but this market transaction has to be signed by a wallet in this browser.";
const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export interface ArkLink { address: string; pubkey: string }
export type LinkResult =
    | { ok: true; link: ArkLink }
    | { ok: true; sent: string | null }
    | { ok: false; error: "denied" | "invalid" | "mismatch" };

export function linkErrorText(error: "denied" | "invalid" | "mismatch"): string {
    if (error === "denied") return "The Arkade wallet declined.";
    if (error === "mismatch") return "That address is for a different Arkade server than this market.";
    return "The Arkade wallet returned a link this app cannot use.";
}

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

/** Ask the Arkade wallet to sign a BIP21 payment in a new tab. */
export function openArkadeSend(request: string, callback = `${location.origin}${location.pathname}`): void {
    openArkadeTab(arkadeSendUrl(request, callback));
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
export const saveNote = (note: string | null) => (note ? localStorage.setItem(NOTE, note) : localStorage.removeItem(NOTE));
export const loadNote = () => localStorage.getItem(NOTE);

/** Open the wallet beside this page. If the browser blocks the tab, stay on this one. */
export function openArkadeTab(url: string, nav?: { open(url: string): Window | null; assign(url: string): void }): void {
    const go = nav ?? { open: (href) => window.open(href, "_blank"), assign: (href) => location.assign(href) };
    if (!go.open(url)) go.assign(url);
}

/** The wallet tab tells this page to re-read localStorage, then closes itself. */
export function finishArkadeTab(): void {
    const opener = window.opener as Window | null;
    if (!opener || opener === window) return;
    opener.postMessage("apm-arkade", location.origin);
    opener.focus();
    window.close();
}

export function watchArkadeHandoff(onChange: () => void): () => void {
    const onStorage = (e: StorageEvent) => { if (e.key === KEY || e.key === NOTE) onChange(); };
    const onMessage = (e: MessageEvent) => { if (e.origin === location.origin && e.data === "apm-arkade") onChange(); };
    const onVisible = () => { if (document.visibilityState === "visible") onChange(); };
    window.addEventListener("storage", onStorage);
    window.addEventListener("message", onMessage);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
        window.removeEventListener("storage", onStorage);
        window.removeEventListener("message", onMessage);
        document.removeEventListener("visibilitychange", onVisible);
    };
}

/** Read a connect or send callback once. Leaves any other query string alone. */
export function takeConnectReturn(search: string, serverKey: string): { result: LinkResult | null; search: string } {
    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    const address = params.get("address");
    const pubkey = params.get("pubkey");
    const error = params.get("error");
    const status = params.get("status");
    const txid = params.get("txid");
    if (!(address && pubkey) && error !== "denied" && error !== "invalid" && status !== "sent") return { result: null, search };
    for (const key of ["address", "pubkey", "error", "status", "txid"]) params.delete(key);
    const next = params.size ? `?${params}` : "";
    if (status === "sent" && !error) return { result: { ok: true, sent: txid }, search: next };
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
