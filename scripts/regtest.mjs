#!/usr/bin/env node
// One entry point for the regtest proof of concept.
//   node scripts/regtest.mjs up     isolated arkade-regtest stack + app image + attestor
//   node scripts/regtest.mjs demo   deterministic end-to-end demo against the running app
//   node scripts/regtest.mjs test   unit tests + regtest e2e suite (LIVE_POLYMARKET=1 / DOCKER_E2E=1 add those)
//   node scripts/regtest.mjs down   stop app containers and the stack (volumes kept)
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stackEnv = join(root, "infra", "regtest", "stack.env");
const compose = ["compose", "-f", "compose.yaml", "-f", "compose.regtest.yaml", "--env-file", ".env.regtest"];
const sh = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" && cmd === "pnpm", ...opts });
    if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
};
const ok = async (url) => fetch(url, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);

async function up() {
    if (!(await ok("http://localhost:37070/v1/info")) || !(await ok("http://localhost:37073/v1/info"))) {
        sh("node", ["regtest/regtest.mjs", "start", "--env", stackEnv]);
    } else console.log("regtest stack already running");
    if (!existsSync(join(root, ".env.regtest"))) {
        writeFileSync(join(root, ".env.regtest"), execFileSync(process.execPath, ["--import", "tsx", "scripts/gen-regtest-env.ts"], { cwd: root, encoding: "utf8" }));
        console.log("generated .env.regtest (regtest-only secrets)");
    }
    sh("docker", [...compose, "up", "-d", "--build"]);
    for (let i = 0; i < 60; i++) {
        const ready = await fetch("http://127.0.0.1:37400/api/health/ready").then((r) => r.json(), () => undefined);
        if (ready?.ok && ready.components?.writer?.ok) {
            console.log("app ready: http://localhost:37400  (arkd :37070, emulator :37073, esplora :37000/api)");
            return;
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error("app did not become ready; see: docker compose -f compose.yaml -f compose.regtest.yaml logs app");
}

const commands = {
    up,
    down: async () => {
        sh("docker", [...compose, "stop"]);
        sh("node", ["regtest/regtest.mjs", "stop", "--env", stackEnv]);
    },
    demo: async () => sh(process.execPath, ["--import", "tsx", "scripts/demo.ts"]),
    test: async () => {
        sh("pnpm", ["exec", "tsc", "--noEmit", "-p", "."]);
        sh("pnpm", ["exec", "vitest", "run", "test/unit"]);
        sh("pnpm", ["exec", "vitest", "run", "--config", "vitest.e2e.config.ts"]);
    },
};

const cmd = commands[process.argv[2]];
if (!cmd) {
    console.error("usage: node scripts/regtest.mjs up|demo|test|down");
    process.exit(2);
}
cmd().catch((err) => {
    console.error(String(err));
    process.exit(1);
});
