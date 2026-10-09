// Records the Polygon -> Ethereum chain of trust for one CTF resolution into zk/ctf-payout/fixtures.
// Usage: node --import tsx scripts/live/polygon-checkpoint-fixture.ts
import { writeFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

const BLOCK = 95207843;
const POLYGON = "https://polygon.gateway.tenderly.co";
const POLYGON_BOR = "https://polygon-bor-rpc.publicnode.com";
const ETHEREUM = "https://ethereum-rpc.publicnode.com";
const ROOT_CHAIN = "0x86E4Dc95c7FBdBf52e33D563BbDB00823894C287";
const HEADER_BLOCKS_SLOT = 5n;
const OUT = new URL("../../zk/ctf-payout/fixtures/buccaneers-resolution.json", import.meta.url);

type Req = { method: string; params: unknown[] };
async function rpc(url: string, reqs: Req[], attempt = 0): Promise<any[]> {
    const body = reqs.map((r, id) => ({ jsonrpc: "2.0", id, ...r }));
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const out = (await res.json()) as { id: number; result?: unknown; error?: unknown }[];
    const bad = !Array.isArray(out) ? out : out.find((r) => r.error !== undefined);
    if (bad && attempt < 8) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        return rpc(url, reqs, attempt + 1);
    }
    if (bad) throw new Error(`${url}: ${JSON.stringify(bad)}`);
    return out.sort((a, b) => a.id - b.id).map((r) => r.result);
}
const call1 = async (url: string, method: string, ...params: unknown[]) => (await rpc(url, [{ method, params }]))[0];
const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const pad32 = (n: bigint) => n.toString(16).padStart(64, "0");

async function headerBlock(id: bigint) {
    const data = `0x41539d4a${pad32(id)}`; // headerBlocks(uint256)
    const r: string = await call1(ETHEREUM, "eth_call", { to: ROOT_CHAIN, data }, "latest");
    const w = (i: number) => BigInt(`0x${r.slice(2 + 64 * i, 66 + 64 * i)}`);
    return { id, root: `0x${r.slice(2, 66)}`, start: w(1), end: w(2) };
}

const [block, receipts] = await rpc(POLYGON, [
    { method: "eth_getBlockByNumber", params: [hex(BLOCK), false] },
    { method: "eth_getBlockReceipts", params: [hex(BLOCK)] },
]);
if (receipts.length !== block.transactions.length) console.warn(`receipts ${receipts.length} != txs ${block.transactions.length}`);

const current = BigInt(await call1(ETHEREUM, "eth_call", { to: ROOT_CHAIN, data: "0xec7e4855" }, "latest"));
let lo = 1n, hi = current / 10000n;
while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const h = await headerBlock(mid * 10000n);
    if (h.end < BigInt(BLOCK)) lo = mid + 1n;
    else hi = mid;
}
const cp = await headerBlock(lo * 10000n);
if (!(cp.start <= BigInt(BLOCK) && BigInt(BLOCK) <= cp.end)) throw new Error(`no checkpoint covers ${BLOCK}: ${JSON.stringify(cp, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}`);
console.log(`checkpoint ${cp.id}: [${cp.start}, ${cp.end}] root ${cp.root}`);

const headers: { number: string; timestamp: string; transactionsRoot: string; receiptsRoot: string }[] = [];
for (let n = cp.start; n <= cp.end; n += 20n) {
    const reqs: Req[] = [];
    for (let m = n; m <= cp.end && m < n + 20n; m++) reqs.push({ method: "eth_getBlockByNumber", params: [hex(m), false] });
    for (const b of await rpc(POLYGON, reqs)) headers.push({ number: b.number, timestamp: b.timestamp, transactionsRoot: b.transactionsRoot, receiptsRoot: b.receiptsRoot });
}
const borRoot: string = await call1(POLYGON_BOR, "bor_getRootHash", Number(cp.start), Number(cp.end));
console.log(`bor_getRootHash ${borRoot} (L1 ${cp.root})`);

const eth = await call1(ETHEREUM, "eth_getBlockByNumber", "finalized", false);
const base = BigInt(`0x${bytesToHex(keccak_256(hexToBytes(pad32(cp.id) + pad32(HEADER_BLOCKS_SLOT))))}`);
const slots = [0n, 1n, 2n].map((i) => `0x${pad32(base + i)}`); // root, start, end
const proof = await call1(ETHEREUM, "eth_getProof", ROOT_CHAIN, slots, eth.number);
console.log(`ethereum finalized ${BigInt(eth.number)} stateRoot ${eth.stateRoot}`);

const fixture = {
    fetchedAt: new Date().toISOString(),
    block: { number: block.number, hash: block.hash, transactionsRoot: block.transactionsRoot, receiptsRoot: block.receiptsRoot, timestamp: block.timestamp, transactions: block.transactions },
    receipts,
    checkpoint: { headerBlockId: cp.id.toString(), root: cp.root, start: cp.start.toString(), end: cp.end.toString(), borRootHash: borRoot },
    headers,
    ethereum: { number: eth.number, hash: eth.hash, stateRoot: eth.stateRoot, rootChain: ROOT_CHAIN, proof },
};
writeFileSync(OUT, `${JSON.stringify(fixture, null, 1)}\n`);
console.log(`wrote ${OUT.pathname} (${headers.length} headers, ${receipts.length} receipts)`);
