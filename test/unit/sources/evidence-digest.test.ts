import { hex } from "@scure/base";
import { describe, expect, it } from "vitest";
import { evidenceDigest } from "../../../src/core/attestation.js";
import { canonicalJson, sha256Hex } from "../../../src/core/encoding.js";
import { createLimitlessProvider } from "../../../src/server/sources/limitless/index.js";
import { DEFAULT_ORACLES, createOpinionProvider } from "../../../src/server/sources/opinion/index.js";
import { CTF_ADDRESS, createPolymarketProvider, deriveConditionId } from "../../../src/server/sources/polymarket/index.js";
import type { MarketSourceProvider, SourceMarket } from "../../../src/server/sources/types.js";

// Pinned on the pre-refactor provider code: a change here means attestors would sign a different digest.
const RPCS = ["https://rpc-a.example/KEY1", "https://rpc-b.example/KEY2", "https://down.example/KEY3"];
const QUESTION = `0x${"5a".repeat(32)}`;
const HEAD = 1000n;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

type Payout = [den: bigint, n0: bigint, n1: bigint];

function chainFetch(chainId: number, payout: Payout, skew?: Payout) {
    return (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.host === "down.example") return new Response("{}", { status: 400 });
        if (!url.host.startsWith("rpc-")) return new Response("not found", { status: 404 });
        const [den, n0, n1] = skew && url.host === "rpc-b.example" ? skew : payout;
        const result = (method: string, params: unknown[]) => {
            if (method === "eth_chainId") return `0x${chainId.toString(16)}`;
            if (method === "eth_getBlockByNumber") {
                const n = params[0] === "finalized" ? HEAD : BigInt(params[0] as string);
                return { number: `0x${n.toString(16)}`, hash: word(n + 0xabcn), parentHash: word(n + 0xabbn), timestamp: "0x67000000", transactions: ["0x1"] };
            }
            const data = (params[0] as { data: string }).data;
            if (data.startsWith("0xdd34de67")) return word(den);
            if (data.startsWith("0x0504c814")) return word(BigInt(`0x${data.slice(-64)}`) === 0n ? n0 : n1);
            if (data.startsWith("0xd42dc0c2")) return word(2n);
            throw new Error(`unexpected ${data}`);
        };
        const answer = (r: { id: unknown; method: string; params: unknown[] }) => ({ jsonrpc: "2.0", id: r.id, result: result(r.method, r.params) });
        const body = JSON.parse(String(init?.body));
        return Response.json(Array.isArray(body) ? body.map(answer) : answer(body));
    }) as typeof fetch;
}

function market(provider: SourceMarket["provider"], sourceId: string, version: string, chainId: number, ctf: string, resolver: string, status: string): SourceMarket {
    return {
        provider, sourceId, slug: sourceId, url: "", question: "Q?", description: "", resolutionSource: "", outcomes: ["Yes", "No"],
        endDate: null, tags: [], active: false, closed: true, archived: false, sourceStatus: status,
        protocol: { version, chainId, negRisk: false, resolver, conditionId: deriveConditionId(resolver, QUESTION), questionId: QUESTION, settlementContract: ctf },
        referencePrices: null, image: null, event: null, volume24h: null, gameStartTime: null, versionHash: "", fetchedAt: "",
    };
}

const POLY_RESOLVER = "0x6a9d222616c90fca5754cd1333cfd9b7fb6a4f74";
const LIMITLESS_SAFE = "0x32e52896663de88a65c2d94917b006404415a89f";
const cases: Record<string, { make: (f: typeof fetch, rpcUrls?: string[]) => MarketSourceProvider; market: SourceMarket; chainId: number; final: Payout }> = {
    polymarket: {
        make: (f, r = RPCS) => createPolymarketProvider({ rpcUrls: r, resolverAllowlist: [POLY_RESOLVER], fetch: f }),
        market: market("polymarket", "123", "v1", 137, CTF_ADDRESS, POLY_RESOLVER, "proposed"),
        chainId: 137,
        final: [1n, 1n, 0n],
    },
    limitless: {
        make: (f, r = RPCS) => createLimitlessProvider({ rpcUrls: r, fetch: f }),
        market: market("limitless", "some-slug", "clob", 8453, "0xc9c98965297bc527861c898329ee280632b76e18", LIMITLESS_SAFE, "FUNDED"),
        chainId: 8453,
        final: [100n, 50n, 50n],
    },
    opinion: {
        make: (f, r = RPCS) => createOpinionProvider({ rpcUrls: r, resolverAllowlist: DEFAULT_ORACLES, fetch: f }),
        market: market("opinion", "123", "ctf", 56, "0xad1a38cec043e70e83a3ec30443db285ed10d774", DEFAULT_ORACLES[0]!, "resolved:proposed"),
        chainId: 56,
        final: [1n, 0n, 1n],
    },
};

const PINNED: Record<string, { record: string; outputs: string }> = {
    polymarket: { record: "1ed47d177f69ee1802132f5c8f62c28676c1c6c00dc4dbac309bbec7e124b881", outputs: "238a06718e247f7c4c47af3d448f4a4ded3f0f1f2a08b481efb8bd70391f6f28" },
    limitless: { record: "0466b0996db714a5965cf7904349edcbc16ee55da1013ae5c5bdec8dbe463833", outputs: "391f4dcbec1f25c7edc86539e2f2215a8c39ee07f204175257c26aa8c5b246a2" },
    opinion: { record: "faf01dda442501c06530cd2f2fded6647b7122230a96e1bd4dadab39b2388332", outputs: "3cc561d4291a5b2fdb7063ab03d2a8a8a99cc41bd93095d11dd648267f4748cf" },
};

describe("evidence determinism across the shared CTF reader", () => {
    for (const [name, c] of Object.entries(cases)) {
        it(`${name}: evidence, digest and screen outputs are unchanged`, async () => {
            const strip = ({ observedAt: _, ...rest }: { observedAt: string }) => rest;
            const final = c.make(chainFetch(c.chainId, c.final));
            const finalEv = await final.fetchResolutionEvidence(c.market);
            const pinned = await final.fetchResolutionEvidence(c.market, { atBlock: 900n });
            const ahead = await final.fetchResolutionEvidence(c.market, { atBlock: HEAD + 1n });
            const open = await c.make(chainFetch(c.chainId, [0n, 0n, 0n])).fetchResolutionEvidence(c.market);
            const split = await c.make(chainFetch(c.chainId, c.final, [2n, 1n, 1n])).fetchResolutionEvidence(c.market);
            const lone = await c.make(chainFetch(c.chainId, c.final), [RPCS[0]!, RPCS[2]!]).fetchResolutionEvidence(c.market).catch((e: Error) => e.message);
            const screened = await final.screenResolved!([c.market]);
            const vet = name === "polymarket" ? null : await final.vetSource!(c.market);
            const record = hex.encode(evidenceDigest(final.evidenceRecord!(c.market, finalEv)));
            expect(finalEv.status).toBe("final");
            const outputs = sha256Hex(canonicalJson([finalEv, pinned, ahead, open, split, lone].map((e) => (typeof e === "string" ? e : strip(e))).concat([screened, vet] as never[])));
            expect({ record, outputs }).toEqual(PINNED[name]);
        });
    }
});
