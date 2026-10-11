import { ArkAddress } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { arkadeCallbackAllowed, arkadeConnectUrl, arkadeSendUrl, openLinkedSession, takeConnectReturn } from "../../../src/web/arkLink.js";
import type { Chain } from "../../../src/web/chain.js";

const server = new Uint8Array(32).map((_, i) => i + 1);
const address = new ArkAddress(server, new Uint8Array(32).fill(2), "tark").encode();
const pubkey = "ab".repeat(32);
const serverHex = hex.encode(server);

describe("arkade app links", () => {
    it("builds connect and send links with encoded params", () => {
        const callback = "https://arkade.trade/wallet";
        const connect = new URL(arkadeConnectUrl(callback));
        expect(connect.origin).toBe("https://arkade.money");
        expect(connect.searchParams.get("action")).toBe("connect");
        expect(connect.searchParams.get("callback")).toBe(callback);
        const request = "bitcoin:?ark=tark1qq&amount=0.0001";
        const send = new URL(arkadeSendUrl(request, callback));
        expect(send.searchParams.get("action")).toBe("send");
        expect(send.searchParams.get("request")).toBe(request);
        expect(send.searchParams.get("callback")).toBe(callback);
        expect(arkadeSendUrl(request)).not.toContain("callback");
    });

    it("accepts https callbacks and localhost http only", () => {
        expect(arkadeCallbackAllowed("https://arkade.trade/wallet")).toBe(true);
        expect(arkadeCallbackAllowed("http://localhost:5173/wallet")).toBe(true);
        expect(arkadeCallbackAllowed("http://127.0.0.1:37400/wallet")).toBe(true);
        expect(arkadeCallbackAllowed("http://[::1]/wallet")).toBe(true);
        expect(arkadeCallbackAllowed("http://example.com/wallet")).toBe(false);
        expect(arkadeCallbackAllowed("https://user:pass@arkade.trade/wallet")).toBe(false);
    });

    it("reads a connect callback and strips it", () => {
        const search = `?address=${address}&pubkey=${pubkey.toUpperCase()}&keep=1`;
        const parsed = takeConnectReturn(search, `02${serverHex}`);
        expect(parsed.result).toEqual({ ok: true, link: { address, pubkey } });
        expect(parsed.search).toBe("?keep=1");
        expect(takeConnectReturn("?keep=1", serverHex)).toEqual({ result: null, search: "?keep=1" });
    });

    it("reports denial, a bad address, and a foreign server", () => {
        expect(takeConnectReturn("?error=denied&address=ark1qleftover", serverHex).result).toEqual({ ok: false, error: "denied" });
        expect(takeConnectReturn("?error=denied", serverHex).search).toBe("");
        expect(takeConnectReturn(`?address=not-an-address&pubkey=${pubkey}`, serverHex).result).toEqual({ ok: false, error: "invalid" });
        const other = new ArkAddress(new Uint8Array(32).fill(9), new Uint8Array(32).fill(3), "tark").encode();
        expect(takeConnectReturn(`?address=${other}&pubkey=${pubkey}`, serverHex).result).toEqual({ ok: false, error: "mismatch" });
    });

    it("identifies a linked wallet and refuses to sign", async () => {
        const chain = { indexer: { getVtxos: async () => ({ vtxos: [{ txid: "aa", vout: 1, value: 500, isSpent: false }] }) } } as unknown as Chain;
        const session = openLinkedSession(chain, { address, pubkey });
        expect(session.external).toBe(true);
        expect(session.address).toBe(address);
        expect(session.pubkey).toBe(pubkey);
        expect((await session.wallet.getBalance()).available).toBe(500);
        await expect(session.identity.sign(undefined as never)).rejects.toThrow(/Arkade app holds this key/);
    });
});
