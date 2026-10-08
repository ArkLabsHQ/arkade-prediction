import { spawn, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

export interface TestServer {
    url: string;
    adminToken: string;
    devOracleSecret: string;
    dataDir: string;
    env: Record<string, string>;
    proc: ChildProcess;
    logs: string[];
    stop(signal?: NodeJS.Signals): Promise<number | null>;
    api<T = unknown>(path: string, init?: RequestInit & { admin?: boolean }): Promise<{ status: number; body: T }>;
}

/** Starts src/server/main.ts as a real child process against the regtest stack. */
export async function startServer(opts: { port: number; dataDir?: string; env?: Record<string, string> }): Promise<TestServer> {
    const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "apm-server-"));
    const adminToken = opts.env?.ADMIN_TOKEN ?? randomBytes(24).toString("hex");
    const devOracleSecret = opts.env?.DEV_ORACLE_SECRET ?? randomBytes(32).toString("hex");
    const env: Record<string, string> = {
        APM_NETWORK: "regtest", APM_DEPLOYMENT_ID: "apm-regtest-e2e",
        HOST: "127.0.0.1", ARK_SERVER_URL: "http://localhost:37070", EMULATOR_URL: "http://localhost:37073",
        ESPLORA_URL: "http://localhost:37000/api", OPERATOR_MNEMONIC: generateMnemonic(wordlist),
        LP_MNEMONIC: generateMnemonic(wordlist), ADMIN_TOKEN: adminToken, DEV_ORACLE_SECRET: devOracleSecret,
        DEV_ENDPOINTS: "true", KEEPER_INTERVAL_SECONDS: "3", RENEW_THRESHOLD_SECONDS: "600", WORKERS: "all",
        ...opts.env,
        PORT: String(opts.port), PUBLIC_BASE_URL: `http://localhost:${opts.port}`, DATA_DIR: dataDir,
    };
    writeFileSync(join(dataDir, "env.json"), JSON.stringify({ ...env, OPERATOR_MNEMONIC: "<redacted>", LP_MNEMONIC: "<redacted>" }));
    const proc = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const logs: string[] = [];
    const logFile = join(dataDir, `server-${opts.port}.log`);
    const capture = (b: Buffer) => {
        logs.push(...String(b).split("\n").filter(Boolean));
        appendFileSync(logFile, b);
    };
    proc.stdout!.on("data", capture);
    proc.stderr!.on("data", capture);
    const url = `http://127.0.0.1:${opts.port}`;
    const api: TestServer["api"] = async (path, init = {}) => {
        const headers = new Headers(init.headers);
        if (init.body) headers.set("content-type", "application/json");
        if (init.admin) headers.set("authorization", `Bearer ${adminToken}`);
        const r = await fetch(`${url}${path}`, { ...init, headers });
        const text = await r.text();
        return { status: r.status, body: text ? JSON.parse(text) : undefined };
    };
    // tsx compiles the server on start; on a loaded host that alone has exceeded a minute.
    const deadline = Date.now() + 180_000;
    for (;;) {
        if (proc.exitCode !== null) throw new Error(`server exited: ${logs.slice(-5).join("\n")}`);
        const ok = await fetch(`${url}/api/config`).then((r) => r.ok, () => false);
        if (ok) break;
        if (Date.now() > deadline) throw new Error(`server not ready: ${logs.slice(-5).join("\n")}`);
        await new Promise((r) => setTimeout(r, 500));
    }
    const stop = (signal: NodeJS.Signals = "SIGTERM") =>
        new Promise<number | null>((resolve) => {
            if (proc.exitCode !== null || proc.signalCode !== null) return resolve(proc.exitCode);
            proc.once("exit", (code) => resolve(code));
            proc.kill(signal);
        });
    return { url, adminToken, devOracleSecret, dataDir, env, proc, logs, stop, api };
}
