// Turn the sp1-gnark docker output (bincode ProofBn254::Groth16) into the {vkey, publicValues, proof} fixture.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const buf = readFileSync(process.argv[2]);
let o = 4; // enum tag
const str = () => { const n = Number(buf.readBigUInt64LE(o)); o += 8; const s = buf.subarray(o, o + n).toString("utf8"); o += n; return s; };
const pub = Array.from({ length: 5 }, str);
const encoded = str();
const raw = str();
const vkHash = buf.subarray(o, o + 32); o += 32;
console.error({ pub, encodedLen: encoded.length, rawLen: raw.length, vkHash: vkHash.toString("hex"), rest: buf.length - o });
const [vkey, digest, exitCode, vkRoot, nonce] = pub.map(BigInt);
const w = (x) => x.toString(16).padStart(64, "0");
const pv = process.argv[3].replace(/^0x/, "");
const h = BigInt("0x" + createHash("sha256").update(Buffer.from(pv, "hex")).digest("hex")) & ((1n << 253n) - 1n);
if (h !== digest) throw new Error(`public values digest ${h} != committed ${digest}`);
// encoded_proof already carries exitCode, vkRoot and nonce; docker leaves the vk hash zero, the selector is sha256(groth16_vk.bin).
const selector = createHash("sha256").update(readFileSync(process.argv[5])).digest("hex").slice(0, 8);
const enc = encoded.replace(/^0x/, "");
if (BigInt("0x" + enc.slice(64, 128)) !== vkRoot || BigInt("0x" + enc.slice(0, 64)) !== exitCode) throw new Error("unexpected encoded_proof layout");
const proof = "0x" + selector + enc;
writeFileSync(process.argv[4], JSON.stringify({ vkey: "0x" + w(vkey), publicValues: "0x" + pv, proof }, null, 2) + "\n");
console.error(`proof ${(proof.length - 2) / 2} bytes, vkRoot 0x${w(vkRoot).slice(0, 8)}…`);
