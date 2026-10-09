import { schnorr } from "@noble/curves/secp256k1.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { hex } from "@scure/base";
import { beforeAll, describe, expect, it } from "vitest";
import { assetIdOf } from "../../../src/core/assets.js";
import { bindingOf, type MarketDefinition } from "../../../src/core/definition.js";
import { genesisPacket, oracleSlots, type ArkadeClient, type MarketAssets, type VaultTerms } from "../../../src/core/market.js";
import { offerContract, type OfferTerms, type Side } from "../../../src/core/offers.js";
import { offerTermsToJson, termsFromJson, termsToJson, type ConfigJson, type MarketJson, type OfferJson, type Outcome } from "../../../src/shared/api.js";
import type { Chain } from "../../../src/web/chain.js";
import { checkDisplayedBinding, checkLegs, displayedDefinition, verifiedTerms, type Deployment } from "../../../src/web/verify.js";
import { BASE, UNIT, fundedMarket, offlineArk, p2tr, txWith } from "../core/offline.js";
import { REDSTONE_PRIMARY_SIGNERS, feedIdBytes } from "../../../src/core/redstone.js";

const CLOSE = 1_900_000_000;
const TIMEOUT = CLOSE + 30 * 86_400;
const SOURCE = {
    provider: "polymarket", profile: "polymarket-ctf-v1-binary", sourceId: "123", chainId: 137, protocolVersion: "v1",
    settlementContract: "0xc7", resolver: "0xbe", conditionId: "0x01", questionId: "0x02", outcomes: ["Yes", "No"], payoutPolicy: "follow-final",
};

let ark: ArkadeClient;
let dep: Deployment;
let config: ConfigJson;
beforeAll(async () => {
    const o = await offlineArk();
    ark = o.ark;
    dep = { network: "regtest", arkSigner: ark.serverKey, emulatorSigner: ark.emulatorKey! };
    config = { network: "regtest", arkSignerPubkey: o.signerPubkey, emulatorPubkey: o.emulatorPubkey } as ConfigJson;
});

/** A funded market exactly as an honest server serves it. */
function served(mirror = false) {
    const id = hex.encode(randomBytes(16));
    const oracleKey = hex.encode(randomBytes(32));
    const definition: MarketDefinition = {
        question: "Will the unit test pass?", rules: "Resolves YES if it passes.", outcomes: ["YES", "NO"], category: "test",
        closeAtUnix: String(CLOSE), timeoutAtUnix: String(TIMEOUT), source: mirror ? SOURCE : null,
    };
    const terms = (assets: MarketAssets): VaultTerms => ({
        assets, unitSats: UNIT, capSats: BASE + 100n * UNIT, oracleKeys: oracleSlots([hex.decode(oracleKey)], 1), oracleThreshold: 1,
        binding: bindingOf({ ...dep, marketId: id, definition, unitSats: UNIT, assets, oracleKeys: [oracleKey, oracleKey, oracleKey], oracleThreshold: 1, oracleEpoch: 1 }),
        closeAt: BigInt(CLOSE), timeoutAt: BigInt(TIMEOUT), exitDelaySeconds: 512n,
    });
    const f = fundedMarket(ark, { terms });
    const m: MarketJson = {
        id, kind: mirror ? "polymarket" : "custom", status: "open", question: definition.question, rules: definition.rules,
        outcomes: ["YES", "NO"], category: "test", closeAt: new Date(CLOSE * 1000).toISOString(), createdAt: new Date().toISOString(),
        source: mirror ? {
            provider: "polymarket", sourceId: "123", url: "https://polymarket.com/event/x", slug: "x", protocol: "v1", conditionId: "0x01",
            questionId: "0x02", resolver: "0xbe", resolutionSource: "", referencePrices: null, sourceStatus: null, image: null, event: null, clarifications: [], binding: SOURCE,
        } : null,
        oracle: { policy: "external-key", keys: [oracleKey, oracleKey, oracleKey], threshold: 1, epoch: 1, label: "" },
        terms: termsToJson(f.terms), genesisTxid: f.genesisTxid, vaultTxid: f.vaultTxid,
        vault: { phase: "open", outcome: null, valueSats: null, outpoint: null, expiresAt: null },
        resolution: { status: "pending", detail: "", certificate: null },
        book: { yes: { bid: null, ask: null }, no: { bid: null, ask: null } },
        stats: { openInterestSets: "0", collateralSats: "0", volumeSats: "0", trades: 0 },
    };
    return { m, chain: { ark, indexer: f.indexer } as unknown as Chain };
}

describe("displayed definition vs the committed binding", () => {
    it("accepts a market whose binding commits to what the page shows", () => {
        expect(() => checkDisplayedBinding(served().m, dep)).not.toThrow();
        expect(() => checkDisplayedBinding(served(true).m, dep)).not.toThrow();
    });

    it("rejects every displayed or funded field the binding does not commit to", () => {
        const { m } = served();
        const t = m.terms!;
        const variants: Partial<MarketJson>[] = [
            { question: "Will the unit test fail?" },
            { rules: "Resolves NO." },
            { category: "sports" },
            { outcomes: ["NO", "YES"] },
            { closeAt: new Date((CLOSE + 60) * 1000).toISOString() },
            { terms: { ...t, timeoutAtUnix: "0" } },
            { terms: { ...t, unitSats: "2000" } },
            { terms: { ...t, assets: { ...t.assets, yes: t.assets.no, no: t.assets.yes } } },
            { oracle: { ...m.oracle, keys: [hex.encode(randomBytes(32))] } },
            { oracle: { ...m.oracle, epoch: 2 } },
            { oracle: { ...m.oracle, keys: [...m.oracle.keys, hex.encode(randomBytes(32))] } },
        ];
        for (const v of variants) expect(() => checkDisplayedBinding({ ...m, ...v }, dep), JSON.stringify(v)).toThrow();
    });

    it("rejects the same terms on another deployment", () => {
        const { m } = served();
        expect(() => checkDisplayedBinding(m, { ...dep, network: "mutinynet" })).toThrow();
        expect(() => checkDisplayedBinding(m, { ...dep, arkSigner: randomBytes(32) })).toThrow();
        expect(() => checkDisplayedBinding(m, { ...dep, emulatorSigner: randomBytes(33) })).toThrow();
    });

    it("ties a mirrored market's displayed source to the committed source identity", () => {
        const { m } = served(true);
        const s = m.source!;
        expect(() => checkDisplayedBinding({ ...m, source: { ...s, conditionId: "0x99" } }, dep)).toThrow(/source/);
        expect(() => checkDisplayedBinding({ ...m, source: { ...s, binding: { ...SOURCE, payoutPolicy: "pay-the-server" } } }, dep)).toThrow();
        expect(() => checkDisplayedBinding({ ...m, source: { ...s, binding: null } }, dep)).toThrow(/source/);
    });
});

describe("offer legs", () => {
    const yes = assetIdOf(hex.encode(randomBytes(32)), 1);
    const no = assetIdOf(hex.encode(randomBytes(32)), 2);
    const offer = (side: Side, assetId: string, outcome: Outcome = "yes"): OfferJson => {
        const terms: OfferTerms = {
            side, maker: schnorr.getPublicKey(randomBytes(32)), makerScript: p2tr(), assetId, priceSats: 600n, minFill: 1n,
            expiresAt: 0n, reserveSats: 330n, exitDelaySeconds: 512n,
        };
        return {
            id: hex.encode(randomBytes(4)), marketId: "m", outcome, terms: offerTermsToJson(terms), script: hex.encode(offerContract(ark, terms).pkScript),
            coin: null, remaining: "5", status: "open", createdAt: "", updatedAt: "",
        };
    };

    it("accepts asks of the chosen claim when buying and bids when selling", () => {
        expect(() => checkLegs(ark, [offer("sell", yes), offer("sell", yes)], "buy", yes)).not.toThrow();
        expect(() => checkLegs(ark, [offer("buy", no, "no")], "sell", no)).not.toThrow();
    });

    it("refuses a NO ask labelled YES", () => {
        expect(() => checkLegs(ark, [offer("sell", yes), offer("sell", no, "yes")], "buy", yes)).toThrow(/different asset/);
    });

    it("refuses a leg on the side being taken", () => {
        expect(() => checkLegs(ark, [offer("buy", yes)], "buy", yes)).toThrow(/not an ask/);
        expect(() => checkLegs(ark, [offer("sell", yes)], "sell", yes)).toThrow(/not a bid/);
    });

    it("refuses a listing whose script its terms do not produce", () => {
        const o = offer("sell", yes);
        expect(() => checkLegs(ark, [{ ...o, script: offer("sell", yes).script }], "buy", yes)).toThrow(/script/);
        expect(() => checkLegs(ark, [{ ...o, terms: { ...o.terms, priceSats: "1" } }], "buy", yes)).toThrow(/script/);
    });
});

describe("browser audit before money moves", () => {
    it("audits once against the browser's own indexer and reuses the result", async () => {
        const { m, chain } = served();
        const first = verifiedTerms(chain, config, m);
        expect(await first).toEqual(termsFromJson(m.terms!));
        expect(verifiedTerms(chain, config, { ...m, stats: { ...m.stats, trades: 3 } })).toBe(first);
    });

    it("re-audits when the served definition changes, without caching the refusal", async () => {
        const { m, chain } = served();
        await verifiedTerms(chain, config, m);
        await expect(verifiedTerms(chain, config, { ...m, question: "Will the unit test fail?" })).rejects.toThrow(/failed verification/);
        await expect(verifiedTerms(chain, config, m)).resolves.toBeDefined();
    });

    it("blocks a forged CTRL even when the server recomputes the binding for it", async () => {
        const { m, chain } = served();
        const forged = { ...m.terms!.assets, ctrl: assetIdOf(txWith([{ script: p2tr(), amount: 330n }], genesisPacket("x", 0, 1n).groups).id, 0) };
        const binding = bindingOf({ ...dep, marketId: m.id, definition: displayedDefinition(m), unitSats: UNIT, assets: forged, oracleKeys: m.oracle.keys, oracleThreshold: m.oracle.threshold, oracleEpoch: 1 });
        const lie = { ...m, terms: { ...m.terms!, assets: forged, binding: hex.encode(binding) } };
        expect(() => checkDisplayedBinding(lie, dep)).not.toThrow();
        await expect(verifiedTerms(chain, config, lie)).rejects.toThrow(/asset-ids/);
    });

    it("blocks when the operator signs with a key the deployment does not pin", async () => {
        const { m, chain } = served();
        const other = { ...config, arkSignerPubkey: `02${hex.encode(randomBytes(32))}` };
        await expect(verifiedTerms(chain, other, m)).rejects.toThrow(/operator/);
    });
});

describe("RedStone up/down terms", () => {
    const START = 1_900_000_000_000;
    const END = START + 900_000;
    const settled = () => {
        const { m } = served(true);
        const signers = [...REDSTONE_PRIMARY_SIGNERS];
        const t = { ...m.terms!, closeAtUnix: String(END / 1000),
            price: { kind: "updown" as const, feedId: hex.encode(feedIdBytes("BTC")), startAtMs: String(START), endAtMs: String(END), signers, quorum: 3 } };
        const settlement = { oracle: "redstone-primary-prod", feed: "BTC", startAtMs: START, endAtMs: END };
        return { ...m, closeAt: new Date(END).toISOString(), terms: t, oracle: { ...m.oracle, policy: "redstone" as const, keys: signers, threshold: 3 },
            source: { ...m.source!, binding: { provider: "polymarket", sourceId: "123", settlement } } } as MarketJson;
    };

    it("accepts the vault an honest server funded and refuses each substitution", () => {
        expect(() => checkDisplayedBinding(settled(), dep)).not.toThrow();
        const p = (m: MarketJson) => m.terms!.price!;
        const cases: [string, (m: MarketJson) => void][] = [
            ["feed", (m) => { p(m).feedId = hex.encode(feedIdBytes("DOGE")); }],
            ["rounds", (m) => { (p(m) as { startAtMs: string }).startAtMs = String(START + 10_000); }],
            ["close", (m) => { m.closeAt = new Date(END + 10_000).toISOString(); }],
            ["signers", (m) => { p(m).signers = [...p(m).signers.slice(1), `10${"02".repeat(33)}`]; m.oracle.keys = p(m).signers; }],
            ["quorum", (m) => { p(m).quorum = 2; }],
        ];
        for (const [what, tamper] of cases) {
            const m = settled();
            tamper(m);
            expect(() => checkDisplayedBinding(m, dep), what).toThrow();
        }
    });
});
