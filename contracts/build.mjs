// Compile contracts/src/*.ark with the pinned arkadec. `--check` recompiles to a temp dir and fails
// if any committed artifact's fingerprint differs (fingerprint covers source, ABI and scripts).
// Install the pinned compiler: cargo install --git https://github.com/arkade-os/compiler
//   --rev e9703e7ac69db73439fb725643831c7072518a17 --locked arkade-compiler --root .tools/arkadec
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const exe = process.platform === "win32" ? "arkadec.exe" : "arkadec";
const arkadec =
    process.env.ARKADEC ?? [join(root, "..", ".tools", "arkadec", "bin", exe)].find(existsSync) ?? "arkadec";
const check = process.argv.includes("--check");
const outDir = check ? mkdtempSync(join(tmpdir(), "apm-artifacts-")) : join(root, "artifacts");

let failed = false;
for (const file of readdirSync(join(root, "src")).filter((f) => f.endsWith(".ark"))) {
    const name = file.replace(/\.ark$/, "");
    const out = join(outDir, `${name}.json`);
    execFileSync(arkadec, [join(root, "src", file), "-o", out], { stdio: ["ignore", "ignore", "inherit"] });
    if (!check) continue;
    const fresh = JSON.parse(readFileSync(out, "utf8")).fingerprint;
    const committedPath = join(root, "artifacts", `${name}.json`);
    const committed = existsSync(committedPath) ? JSON.parse(readFileSync(committedPath, "utf8")).fingerprint : "missing";
    if (fresh !== committed) {
        failed = true;
        console.error(`${name}: committed ${committed} != compiled ${fresh}`);
    } else console.log(`${name}: ${fresh}`);
}
if (failed) process.exit(1);
