// Fresh regtest-only secrets on top of .env.regtest.example. Never use the output on a real network.
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1.js";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

const oracle = randomBytes(32);
const values: Record<string, string> = {
    OPERATOR_MNEMONIC: generateMnemonic(wordlist),
    LP_MNEMONIC: generateMnemonic(wordlist),
    ADMIN_TOKEN: randomBytes(24).toString("hex"),
    DEV_ORACLE_SECRET: randomBytes(32).toString("hex"),
    ORACLE_SECRET_KEY: oracle.toString("hex"),
    ORACLE_PUBKEYS: Buffer.from(schnorr.getPublicKey(oracle)).toString("hex"),
};
const example = readFileSync(new URL("../.env.regtest.example", import.meta.url), "utf8");
process.stdout.write(example.replace(/^([A-Z_]+)=<[^>\n]*>$/gm, (_, k: string) => `${k}=${values[k] ?? ""}`));
