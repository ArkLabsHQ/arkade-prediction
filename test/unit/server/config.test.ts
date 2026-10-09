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
            ARK_SERVER_URL: "http://arkd:7070/SECRET-path",
            EMULATOR_URL: "http://emulator:7072/?token=SECRET-token",
            ESPLORA_URL: "http://esplora:3000/api#SECRET-fragment",
            EXPLORER_URL: "https://mempool.example/SECRET-explorer",
            PUBLIC_ARK_SERVER_URL: "https://ark.example/SECRET-public",
            ORACLE_URL: "https://oracle.example:8443/v1/SECRET-oracle",
            POLYMARKET_GAMMA_URL: "https://gamma.example/?apikey=SECRET-gamma",
            POLYGON_RPC_URLS: "https://polygon-mainnet.g.alchemy.com/v2/SECRET-alchemy,https://lb.drpc.org/ogrpc?network=polygon&dkey=SECRET-drpc",
            ORACLE_SECRET_KEY: "5ec2e7".padEnd(64, "0"),
            OPERATOR_MNEMONIC: "SECRET mnemonic words",
        });
        const out = redacted(cfg);
        expect(JSON.stringify(out)).not.toMatch(/SECRET[- ]|user/);
        expect(out).toMatchObject({
            EXPLORER_URL: "https://mempool.example",
            ARK_SERVER_URL: "http://arkd:7070",
            ORACLE_URL: "https://oracle.example:8443",
            POLYGON_RPC_URLS: ["https://polygon-mainnet.g.alchemy.com", "https://lb.drpc.org"],
            ORACLE_SECRET_KEY: true,
            OPERATOR_MNEMONIC: true,
            LP_MNEMONIC: false,
        });
    });
});

describe("endpoint and pin defaults", () => {
    it("needs neither endpoints nor pins on mutinynet", () => {
        const cfg = loadConfig({ APM_NETWORK: "mutinynet" });
        expect(cfg).toMatchObject({
            ARK_SERVER_URL: "https://mutinynet.arkade.sh",
            EMULATOR_URL: "https://emulator.mutinynet.arkade.sh",
            ESPLORA_URL: "https://mempool.mutinynet.arkade.sh/api",
        });
        expect(cfg.ARK_SIGNER_PUBKEY).toBeUndefined();
        expect(cfg.EMULATOR_PUBKEY).toBeUndefined();
        expect(loadConfig({ APM_NETWORK: "mutinynet", APM_DEPLOYMENT_ID: "t", PUBLIC_BASE_URL: "https://app.example", ARK_SERVER_URL: "https://ark.example" }).ARK_SERVER_URL).toBe("https://ark.example");
    });

    it("still requires explicit endpoints on regtest", () => {
        expect(() => loadConfig({ APM_NETWORK: "regtest", APM_DEPLOYMENT_ID: "t", PUBLIC_BASE_URL: "http://app" })).toThrow(/ARK_SERVER_URL is required on regtest/);
    });
});

describe("single-container attestor", () => {
    it("runs a local attestor and trusts only its key when ORACLE_SECRET_KEY is set on the app", async () => {
        const { schnorr } = await import("@noble/curves/secp256k1.js");
        const secret = "11".repeat(32);
        expect(() => loadConfig({ APM_NETWORK: "mutinynet", ORACLE_SECRET_KEY: secret })).toThrow(/POLYGON_RPC_URLS/);
        expect(loadConfig({ APM_NETWORK: "mutinynet", ORACLE_SECRET_KEY: secret, KALSHI_ENABLED: "1" }).KALSHI_ENABLED).toBe(true);
        const cfg = loadConfig({ APM_NETWORK: "mutinynet", ORACLE_SECRET_KEY: secret, POLYGON_RPC_URLS: "https://a,https://b" });
        expect(cfg.ORACLE_URLS).toEqual(["http://127.0.0.1:37410"]);
        expect(cfg.ORACLE_PUBKEYS).toEqual([Buffer.from(schnorr.getPublicKey(Buffer.from(secret, "hex"))).toString("hex")]);
        expect(cfg.ADMIN_PORT).toBe(37401);
        expect(redacted(cfg).ORACLE_SECRET_KEY).toBe(true);
    });
});
