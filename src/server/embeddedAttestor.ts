import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDED_ATTESTOR_PORT, type Config } from "./config.js";

/**
 * Runs the attestor as a supervised child of the app, for single-container deployments. It is still a separate
 * process holding the only copy of the attestor key, but the same operator runs both: a 1-of-1 attestor.
 */
export function startEmbeddedAttestor(cfg: Config, secret: string, log: (msg: string, extra?: Record<string, unknown>) => void): () => void {
    const self = fileURLToPath(import.meta.url);
    const entry = join(self, "..", "..", "oracle", `main${self.endsWith(".ts") ? ".ts" : ".js"}`);
    let child: ChildProcess | undefined;
    let stopping = false;
    let restarts = 0;
    const start = () => {
        child = spawn(process.execPath, [...process.execArgv, entry], {
            stdio: "inherit",
            env: {
                ...process.env, ORACLE_SECRET_KEY: secret, ORACLE_SECRET_KEY_FILE: "", ORACLE_HOST: "127.0.0.1",
                ORACLE_PORT: String(EMBEDDED_ATTESTOR_PORT), ORACLE_DATA_DIR: join(cfg.DATA_DIR, "oracle"),
                APM_NETWORK: cfg.APM_NETWORK, ARK_SERVER_URL: cfg.ARK_SERVER_URL,
            },
        });
        child.once("exit", (code) => {
            if (stopping) return;
            const delay = Math.min(60_000, 1000 * 2 ** Math.min(restarts++, 6));
            log("embedded attestor exited, restarting", { code, delayMs: delay });
            setTimeout(start, delay).unref();
        });
    };
    start();
    return () => {
        stopping = true;
        child?.kill("SIGTERM");
    };
}
