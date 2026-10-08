import { describe, expect, it } from "vitest";
import { loadConfig, redacted } from "../../../src/server/config.js";

const BASE = { APM_NETWORK: "regtest", APM_DEPLOYMENT_ID: "t", PUBLIC_BASE_URL: "http://app", ARK_SERVER_URL: "http://arkd", EMULATOR_URL: "http://emu", ESPLORA_URL: "http://esplora" };

describe("config redaction", () => {
    it("refuses an ORACLE_URL with credentials, which fetch would echo into public resolution details", () => {
        let message = "";
        try {
            loadConfig({ ...BASE, ORACLE_URL: "https://user:SECRET@oracle.example" });
        } catch (e) {
            message = (e as Error).message;
        }
        expect(message).toMatch(/ORACLE_URL: must not embed credentials/);
        expect(message).not.toMatch(/SECRET/);
        expect(loadConfig({ ...BASE, ORACLE_URL: "https://oracle.example/v1?k=x" }).ORACLE_URL).toBe("https://oracle.example/v1?k=x");
    });

    it("logs every URL setting as scheme://host only, and secrets as presence flags", () => {
        const cfg = loadConfig({
            ...BASE,
            PUBLIC_BASE_URL: "https://user:SECRET-pw@app.example/base?SECRET-q=1",
            ARK_SERVER_URL: "http://arkd:7070/SECRET-path",
            EMULATOR_URL: "http://emulator:7072/?token=SECRET-token",
            ESPLORA_URL: "http://esplora:3000/api#SECRET-fragment",
            EXPLORER_URL: "https://mempool.example/SECRET-explorer",
            PUBLIC_ARK_SERVER_URL: "https://ark.example/SECRET-public",
            ORACLE_URL: "https://oracle.example:8443/v1/SECRET-oracle",
            POLYMARKET_GAMMA_URL: "https://gamma.example/?apikey=SECRET-gamma",
            POLYGON_RPC_URLS: "https://polygon-mainnet.g.alchemy.com/v2/SECRET-alchemy,https://lb.drpc.org/ogrpc?network=polygon&dkey=SECRET-drpc",
            ADMIN_TOKEN: "SECRET-admin-token-0123456789",
            OPERATOR_MNEMONIC: "SECRET mnemonic words",
        });
        const out = redacted(cfg);
        expect(JSON.stringify(out)).not.toMatch(/SECRET[- ]|user/);
        expect(out).toMatchObject({
            PUBLIC_BASE_URL: "https://app.example",
            ARK_SERVER_URL: "http://arkd:7070",
            ORACLE_URL: "https://oracle.example:8443",
            POLYGON_RPC_URLS: ["https://polygon-mainnet.g.alchemy.com", "https://lb.drpc.org"],
            ADMIN_TOKEN: true,
            OPERATOR_MNEMONIC: true,
            LP_MNEMONIC: false,
        });
    });
});
