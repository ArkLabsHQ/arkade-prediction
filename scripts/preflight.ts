// Read-only deployment preflight. Usage: node --env-file=<env> --import tsx scripts/preflight.ts
// Compares live endpoints with the configured pins and checks that our templates fit the advertised limits.
import { RestArkProvider, RestEmulatorProvider, networks, resolveEmulatorPubkey } from "@arkade-os/sdk";
import { TEMPLATE, PROGRAMS } from "../src/core/market.js";
import { OFFER_PROGRAMS } from "../src/core/offers.js";
import { CLAIM_BOX_PROGRAM } from "../src/core/claimBox.js";

const env = process.env;
const j = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
const checks: { check: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail: string) => checks.push({ check: name, ok, detail });

async function main() {
    const network = env.APM_NETWORK as "regtest" | "mutinynet";
    const ark = new RestArkProvider(env.ARK_SERVER_URL!);
    const info = await ark.getInfo();
    check("arkd network", info.network === network, `arkd says ${info.network}, configured ${network}`);
    check("arkd signer pin", !env.ARK_SIGNER_PUBKEY || info.signerPubkey === env.ARK_SIGNER_PUBKEY, `live ${info.signerPubkey}`);
    check("arkd deprecated signers", true, j(info.deprecatedSigners ?? []));
    const exit = BigInt(info.unilateralExitDelay);
    check("exit delay is seconds-based", exit >= 512n && exit % 512n === 0n, `${exit} s (templates use it as their CSV)`);
    check("intent fees", true, j(info.fees));
    check("tx limits", Number(info.maxTxWeight) >= 20_000, `maxTxWeight ${info.maxTxWeight}, maxOpReturnOutputs ${info.maxOpReturnOutputs}, dust ${info.dust}`);

    const emu = new RestEmulatorProvider(env.EMULATOR_URL!);
    const emuInfo = await emu.getInfo();
    const pinned = resolveEmulatorPubkey(networks[network], env.EMULATOR_PUBKEY);
    check("emulator key == pin", emuInfo.signerPubkey === pinned, `live ${emuInfo.signerPubkey}, pinned ${pinned}`);
    check("emulator version", true, `${(emuInfo as { version?: string }).version ?? "unknown"} (regtest-verified: v0.0.9-rc.1)`);
    check("emulator deprecated keys", true, JSON.stringify((emuInfo as { deprecatedSignerPubkeys?: string[] }).deprecatedSignerPubkeys ?? []));

    const tip = await fetch(`${env.ESPLORA_URL}/blocks/tip/height`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.text(), (e) => `error ${e}`);
    check("esplora reachable", /^\d+$/.test(tip), `tip ${tip}`);

    for (const [name, program] of Object.entries({ ...PROGRAMS, ...OFFER_PROGRAMS, claimBox: CLAIM_BOX_PROGRAM })) {
        const largest = Math.max(...Object.values(program.functions).map((f) => j(f.arkadeScript?.asm ?? []).length));
        check(`template ${name}`, largest < 10_000, `largest covenant asm JSON ${largest} chars (< 10,000-byte script cap)`);
    }
    check("template fingerprints", true, j(TEMPLATE));

    const rpcs = (env.POLYGON_RPC_URLS ?? "").split(",").filter(Boolean);
    const finalized = await Promise.all(rpcs.map((u) =>
        fetch(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBlockByNumber", params: ["finalized", false] }), signal: AbortSignal.timeout(10_000) })
            .then((r) => r.json() as Promise<{ result?: { number: string; hash: string } }>).then((j) => j.result, () => undefined)));
    check("polygon finalized tag on >= 2 providers", finalized.filter(Boolean).length >= 2, finalized.map((b, i) => `${rpcs[i]}: ${b ? parseInt(b.number, 16) : "unavailable"}`).join("; "));

    const gamma = await fetch(`${env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com"}/markets/keyset?limit=5&closed=false`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.status, () => 0);
    check("gamma discovery reachable", gamma === 200, `HTTP ${gamma}`);

    const failed = checks.filter((c) => !c.ok);
    for (const c of checks) console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.check}: ${c.detail}`);
    console.log(JSON.stringify({ network, at: new Date().toISOString(), arkSigner: info.signerPubkey, emulator: emuInfo.signerPubkey, failed: failed.length }));
    process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
    console.error("preflight error:", e);
    process.exit(2);
});

