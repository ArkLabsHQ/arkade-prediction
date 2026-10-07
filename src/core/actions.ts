import { ArkAddress, asset, type Identity, type IndexerProvider } from "@arkade-os/sdk";
import { hex } from "@scure/base";
import {
    buildArkadeTx,
    signInputs,
    submitArkadeTx,
    type AssetAmount,
    type Coin,
    type InputSpec,
    type Network,
    type OutputSpec,
} from "./arkadeTx.js";
import { assetIdOf } from "./assets.js";
import { genesisPacket, marketContracts, type ArkadeClient, type Contract, type MarketAssets, type VaultTerms } from "./market.js";
import { offerContract, type OfferTerms } from "./offers.js";
import { BINARY_VECTORS, redemptionPayout, type BinaryOutcome } from "./payout.js";

export const CARRIER_SATS = 330n;

export interface Ctx {
    ark: ArkadeClient;
    net: Network;
    indexer: Pick<IndexerProvider, "getVtxos" | "getVirtualTxs">;
    /** Write-ahead hook: runs with the final txid and spent outpoints after signing, before submission. */
    beforeSubmit?: (pending: { txid: string; inputs: string[] }) => void | Promise<void>;
}

/** A key-holding party: browser wallet, CLI user, LP or operator. */
export interface Party {
    identity: Identity;
    script: Uint8Array;
    /** Spendable wallet coins with their tap tree, forfeit leaf and assets. */
    coins(): Promise<WalletCoin[]>;
    /** Called with outpoints this party just spent, so selection skips them while the indexer catches up. */
    noteSpent?(outpoints: string[]): void;
}

/** Adapts an SDK wallet. */
export async function walletParty(
    wallet: { getAddress(): Promise<string>; getVtxos(): Promise<(WalletCoin & { isSpent?: boolean })[]> },
    identity: Identity,
): Promise<Party> {
    const pending = new Set<string>();
    return {
        identity,
        script: ArkAddress.decode(await wallet.getAddress()).pkScript,
        coins: async () => (await wallet.getVtxos()).filter((c) => !c.isSpent && !pending.has(`${c.txid}:${c.vout}`)),
        noteSpent: (outpoints) => outpoints.forEach((o) => pending.add(o)),
    };
}
export type WalletCoin = Extract<InputSpec, { kind: "wallet" }>["coin"];

export function scriptOfAddress(address: string): Uint8Array {
    return ArkAddress.decode(address).pkScript;
}

export async function spendableCoins(ctx: Ctx, script: Uint8Array): Promise<Coin[]> {
    const { vtxos } = await ctx.indexer.getVtxos({ scripts: [hex.encode(script)], spendableOnly: true });
    return vtxos
        .filter((v) => !v.isSpent)
        .map((v) => ({ txid: v.txid, vout: v.vout, value: v.value, assets: v.assets }));
}

/** The single live coin of a contract (vault). Fails loudly if the script holds several. */
export async function contractCoin(ctx: Ctx, contract: Contract, txid?: string): Promise<Coin | undefined> {
    const coins = (await spendableCoins(ctx, contract.pkScript)).filter((c) => !txid || c.txid === txid);
    if (coins.length > 1) throw new Error(`contract ${hex.encode(contract.pkScript)} has ${coins.length} live coins`);
    return coins[0];
}

const amountOf = (assets: AssetAmount[] | undefined, id: string) =>
    (assets ?? []).filter((a) => a.assetId === id).reduce((s, a) => s + a.amount, 0n);

function holdings(inputs: InputSpec[]): Map<string, bigint> {
    const m = new Map<string, bigint>();
    for (const i of inputs) for (const a of i.coin.assets ?? []) m.set(a.assetId, (m.get(a.assetId) ?? 0n) + a.amount);
    return m;
}

/**
 * Pick wallet coins covering `sats` plus every asset amount in `need`. Coins carrying any asset are
 * included whole, so the change output must carry their leftovers.
 */
export async function selectWalletInputs(party: Party, sats: bigint, need: AssetAmount[] = []): Promise<InputSpec[]> {
    const coins = (await party.coins()).filter((c) => !(c as { isSpent?: boolean }).isSpent);
    const chosen: WalletCoin[] = [];
    const take = (c: WalletCoin) => !chosen.includes(c) && chosen.push(c);
    for (const n of need) {
        let got = 0n;
        for (const c of coins.filter((c) => amountOf(c.assets, n.assetId) > 0n)) {
            if (got >= n.amount) break;
            take(c);
            got += amountOf(c.assets, n.assetId);
        }
        if (got < n.amount) throw new Error(`insufficient ${n.assetId.slice(0, 8)}…: have ${got}, need ${n.amount}`);
    }
    let value = chosen.reduce((s, c) => s + BigInt(c.value), 0n);
    // Asset-free coins first; asset-carrying coins can still fund sats because change keeps their assets.
    const bySats = [...coins].sort((a, b) => Number(!!a.assets?.length) - Number(!!b.assets?.length) || b.value - a.value);
    for (const c of bySats) {
        if (value >= sats) break;
        take(c);
        value += BigInt(c.value);
    }
    if (value < sats) throw new Error(`insufficient funds: have ${value} sats, need ${sats}`);
    return chosen.map((coin) => ({ kind: "wallet", coin }));
}

/** Change output for `party`: leftover sats plus every asset the wallet inputs carried minus `spent`. */
function changeOutput(party: Party, inputs: InputSpec[], satsLeft: bigint, spent: AssetAmount[] = [], received: AssetAmount[] = []): OutputSpec[] {
    const left = holdings(inputs.filter((i) => i.kind === "wallet"));
    for (const a of spent) left.set(a.assetId, (left.get(a.assetId) ?? 0n) - a.amount);
    for (const a of received) left.set(a.assetId, (left.get(a.assetId) ?? 0n) + a.amount);
    if ([...left.values()].some((v) => v < 0n)) throw new Error("asset accounting went negative");
    const assets = [...left].filter(([, v]) => v > 0n).map(([assetId, amount]) => ({ assetId, amount }));
    if (satsLeft < 0n) throw new Error("insufficient sats");
    if (assets.length === 0 && satsLeft === 0n) return [];
    if (satsLeft < CARRIER_SATS) throw new Error(`change of ${satsLeft} sats is below the ${CARRIER_SATS}-sat carrier`);
    return [{ script: party.script, amount: satsLeft, assets }];
}

export async function execute(ctx: Ctx, inputs: InputSpec[], outputs: OutputSpec[], signer?: Party): Promise<{ txid: string }> {
    const built = await buildArkadeTx(ctx.net, inputs, outputs);
    if (built.signerInputs.length > 0) {
        if (!signer) throw new Error("transaction has inputs that need a signature");
        await signInputs(built, signer.identity, built.signerInputs);
    }
    await ctx.beforeSubmit?.({ txid: built.arkTx.id, inputs: inputs.map((i) => `${i.coin.txid}:${i.coin.vout}`) });
    const result = await submitArkadeTx(ctx.net, built, signer ? (cp) => signer.identity.sign(cp, [0]) : undefined);
    signer?.noteSpent?.(inputs.filter((i) => i.kind === "wallet").map((i) => `${i.coin.txid}:${i.coin.vout}`));
    return result;
}

// --- market lifecycle -------------------------------------------------------------------------

export interface MarketGenesis {
    assets: MarketAssets;
    genesisTxid: string;
}

/**
 * T0: issue CTRL + seed YES/NO to the creator. Asset ids are fixed by this txid. Assets the creator's coins
 * already carry ride along as transfer groups after the three issuance groups, so ByGroup(0) still names CTRL.
 */
export async function issueMarketAssets(ctx: Ctx, creator: Party, marketId: string, seedSets: bigint): Promise<MarketGenesis> {
    const inputs = await selectWalletInputs(creator, CARRIER_SATS);
    const value = inputs.reduce((s, i) => s + BigInt(i.coin.value), 0n);
    const carried = new Map<string, asset.AssetInput[]>();
    inputs.forEach((i, vin) => {
        for (const a of i.coin.assets ?? []) carried.set(a.assetId, [...(carried.get(a.assetId) ?? []), asset.AssetInput.create(vin, a.amount)]);
    });
    const transfers = [...carried].map(([id, ins]) =>
        asset.AssetGroup.create(asset.AssetId.fromString(id), null, ins, [asset.AssetOutput.create(0, ins.reduce((s, x) => s + x.input.amount, 0n))], []),
    );
    const packet = asset.Packet.create([...genesisPacket(marketId, 0, seedSets).groups, ...transfers]);
    const built = await buildArkadeTx(ctx.net, inputs.map((i) => ({ ...i, coin: { ...i.coin, assets: [] } })) as InputSpec[], [{ script: creator.script, amount: value }], { packet });
    await signInputs(built, creator.identity, built.signerInputs);
    await ctx.beforeSubmit?.({ txid: built.arkTx.id, inputs: inputs.map((i) => `${i.coin.txid}:${i.coin.vout}`) });
    const { txid } = await submitArkadeTx(ctx.net, built, (cp) => creator.identity.sign(cp, [0]));
    creator.noteSpent?.(inputs.map((i) => `${i.coin.txid}:${i.coin.vout}`));
    return { genesisTxid: txid, assets: { ctrl: assetIdOf(txid, 0), yes: assetIdOf(txid, 1), no: assetIdOf(txid, 2) } };
}

/** T1: lock CTRL with `baseSats + seedSets * unit` in the vault; the creator keeps the seed sets. */
export async function openVault(ctx: Ctx, creator: Party, terms: VaultTerms, seedSets: bigint, baseSats: bigint) {
    const { vault } = marketContracts(ctx.ark, terms);
    const lock = baseSats + seedSets * terms.unitSats;
    const inputs = await selectWalletInputs(creator, lock + CARRIER_SATS, [
        { assetId: terms.assets.ctrl, amount: 1n },
        { assetId: terms.assets.yes, amount: seedSets },
        { assetId: terms.assets.no, amount: seedSets },
    ]);
    const value = inputs.reduce((s, i) => s + BigInt(i.coin.value), 0n);
    const outputs: OutputSpec[] = [
        { script: vault.pkScript, amount: lock, assets: [{ assetId: terms.assets.ctrl, amount: 1n }] },
        ...changeOutput(creator, inputs, value - lock, [{ assetId: terms.assets.ctrl, amount: 1n }]),
    ];
    return execute(ctx, inputs, outputs, creator);
}

export async function mintSets(ctx: Ctx, party: Party, terms: VaultTerms, n: bigint) {
    const { vault } = marketContracts(ctx.ark, terms);
    const coin = await contractCoin(ctx, vault);
    if (!coin) throw new Error("market vault not found (resolved or not yet open)");
    const cost = n * terms.unitSats;
    const inputs = await selectWalletInputs(party, cost + CARRIER_SATS);
    const value = inputs.reduce((s, i) => s + BigInt(i.coin.value), 0n);
    const minted = [{ assetId: terms.assets.yes, amount: n }, { assetId: terms.assets.no, amount: n }];
    return execute(ctx, [{ kind: "covenant", coin, contract: vault, fn: "mint", args: { n } }, ...inputs], [
        { script: vault.pkScript, amount: BigInt(coin.value) + cost, assets: [{ assetId: terms.assets.ctrl, amount: 1n }] },
        ...changeOutput(party, inputs, value - cost, [], minted),
    ], party);
}

export async function mergeSets(ctx: Ctx, party: Party, terms: VaultTerms, n: bigint) {
    const { vault } = marketContracts(ctx.ark, terms);
    const coin = await contractCoin(ctx, vault);
    if (!coin) throw new Error("market vault not found");
    const burned = [{ assetId: terms.assets.yes, amount: n }, { assetId: terms.assets.no, amount: n }];
    const inputs = await selectWalletInputs(party, 0n, burned);
    const value = inputs.reduce((s, i) => s + BigInt(i.coin.value), 0n);
    const released = n * terms.unitSats;
    return execute(ctx, [{ kind: "covenant", coin, contract: vault, fn: "merge", args: { n } }, ...inputs], [
        { script: vault.pkScript, amount: BigInt(coin.value) - released, assets: [{ assetId: terms.assets.ctrl, amount: 1n }] },
        ...changeOutput(party, inputs, value + released, burned),
    ], party);
}

/** Moves the open vault to the ResolvedVault of `outcome`. Anyone holding a valid certificate may submit. */
export async function resolveMarket(ctx: Ctx, terms: VaultTerms, outcome: BinaryOutcome, evidence: Uint8Array, oracleSig: Uint8Array) {
    const { vault, resolved } = marketContracts(ctx.ark, terms);
    const coin = await contractCoin(ctx, vault);
    if (!coin) throw new Error("market vault not found");
    const fn = { yes: "resolveYes", no: "resolveNo", invalid: "resolveInvalid" }[outcome];
    return execute(ctx, [{ kind: "covenant", coin, contract: vault, fn, args: { evidence, oracleSig } }], [
        { script: resolved[outcome].pkScript, amount: BigInt(coin.value), assets: [{ assetId: terms.assets.ctrl, amount: 1n }] },
    ]);
}

export async function timeoutMarket(ctx: Ctx, terms: VaultTerms) {
    const { vault, resolved } = marketContracts(ctx.ark, terms);
    const coin = await contractCoin(ctx, vault);
    if (!coin) throw new Error("market vault not found");
    return execute(ctx, [{ kind: "covenant", coin, contract: vault, fn: "timeout" }], [
        { script: resolved.invalid.pkScript, amount: BigInt(coin.value), assets: [{ assetId: terms.assets.ctrl, amount: 1n }] },
    ]);
}

/** Burns every YES/NO the party holds against the resolved vault and pays them out. */
export async function redeemAll(ctx: Ctx, party: Party, terms: VaultTerms, outcome: BinaryOutcome) {
    const { resolved } = marketContracts(ctx.ark, terms);
    const contract = resolved[outcome];
    const coin = await contractCoin(ctx, contract);
    if (!coin) throw new Error("resolved vault not found");
    const coins = (await party.coins()).filter((c) => amountOf(c.assets, terms.assets.yes) + amountOf(c.assets, terms.assets.no) > 0n);
    const inputs: InputSpec[] = coins.map((c) => ({ kind: "wallet", coin: c }));
    const yesBurn = coins.reduce((s, c) => s + amountOf(c.assets, terms.assets.yes), 0n);
    const noBurn = coins.reduce((s, c) => s + amountOf(c.assets, terms.assets.no), 0n);
    if (yesBurn + noBurn === 0n) throw new Error("no claims to redeem");
    const payout = redemptionPayout([yesBurn, noBurn], BINARY_VECTORS[outcome], terms.unitSats);
    const value = inputs.reduce((s, i) => s + BigInt(i.coin.value), 0n);
    const burned = [{ assetId: terms.assets.yes, amount: yesBurn }, { assetId: terms.assets.no, amount: noBurn }].filter((a) => a.amount > 0n);
    const result = await execute(ctx, [{ kind: "covenant", coin, contract, fn: "redeem", args: { yesBurn, noBurn } }, ...inputs], [
        { script: contract.pkScript, amount: BigInt(coin.value) - payout, assets: [{ assetId: terms.assets.ctrl, amount: 1n }] },
        ...changeOutput(party, inputs, value + payout, burned),
    ], party);
    return { ...result, payout, yesBurn, noBurn };
}

// --- orders ----------------------------------------------------------------------------------

export interface LiveOffer {
    terms: OfferTerms;
    coin: Coin;
}

/** Funds a standing offer from the maker's wallet. Sell offers lock units, buy offers lock budget. */
export async function postOffer(ctx: Ctx, maker: Party, terms: OfferTerms, size: bigint) {
    const contract = offerContract(ctx.ark, terms);
    const locked = terms.side === "sell" ? [{ assetId: terms.assetId, amount: size }] : [];
    const value = terms.side === "sell" ? CARRIER_SATS : size * terms.priceSats + terms.reserveSats;
    const inputs = await selectWalletInputs(maker, value + CARRIER_SATS, locked);
    const total = inputs.reduce((s, i) => s + BigInt(i.coin.value), 0n);
    const result = await execute(ctx, inputs, [
        { script: contract.pkScript, amount: value, assets: locked },
        ...changeOutput(maker, inputs, total - value, locked),
    ], maker);
    return { ...result, contract };
}

export async function cancelOffer(ctx: Ctx, maker: Party, offer: LiveOffer) {
    const contract = offerContract(ctx.ark, offer.terms);
    return execute(ctx, [{ kind: "tapscript", coin: offer.coin, contract, fn: "cancel" }], [
        { script: offer.terms.makerScript, amount: BigInt(offer.coin.value), assets: offer.coin.assets ?? [] },
    ], maker);
}

/** Permissionless: returns an expired offer to its maker. */
export async function settleExpiredOffer(ctx: Ctx, offer: LiveOffer) {
    const contract = offerContract(ctx.ark, offer.terms);
    return execute(ctx, [{ kind: "covenant", coin: offer.coin, contract, fn: "settle" }], [
        { script: offer.terms.makerScript, amount: BigInt(offer.coin.value), assets: offer.coin.assets ?? [] },
    ]);
}

export interface Leg {
    offer: LiveOffer;
    qty: bigint;
}

/** Offer-side output of a fill, at the same index as the offer input. */
function legOutput(ctx: Ctx, leg: Leg): OutputSpec {
    const { terms, coin } = leg.offer;
    const value = BigInt(coin.value);
    const held = amountOf(coin.assets, terms.assetId);
    const offerScript = () => offerContract(ctx.ark, terms).pkScript;
    if (terms.side === "sell") {
        const paid = leg.qty * terms.priceSats;
        const left = held - leg.qty;
        if (left < 0n) throw new Error("fill exceeds offer size");
        return left === 0n
            ? { script: terms.makerScript, amount: value + paid }
            : { script: offerScript(), amount: value + paid, assets: [{ assetId: terms.assetId, amount: left }] };
    }
    const spend = leg.qty * terms.priceSats;
    const left = value - spend - terms.reserveSats;
    if (left < 0n) throw new Error("fill exceeds offer budget");
    const assets = [{ assetId: terms.assetId, amount: held + leg.qty }];
    return left < terms.priceSats
        ? { script: terms.makerScript, amount: value - spend, assets }
        : { script: offerScript(), amount: value - spend, assets };
}

/**
 * Taker fills one or more offers of the same asset in one atomic tx. Buying from sell offers pays sats and
 * receives units; selling into buy offers delivers units and receives sats. Fails rather than exceed limits.
 */
export async function takeOffers(
    ctx: Ctx,
    taker: Party,
    legs: Leg[],
    limits: { maxSpendSats?: bigint; minReceiveSats?: bigint; receiveScript?: Uint8Array } = {},
) {
    if (legs.length === 0) throw new Error("no offers to take");
    const side = legs[0]!.offer.terms.side;
    const assetId = legs[0]!.offer.terms.assetId;
    if (legs.some((l) => l.offer.terms.side !== side || l.offer.terms.assetId !== assetId)) throw new Error("legs must share side and asset");
    const qty = legs.reduce((s, l) => s + l.qty, 0n);
    const notional = legs.reduce((s, l) => s + l.qty * l.offer.terms.priceSats, 0n);
    if (side === "sell" && limits.maxSpendSats !== undefined && notional > limits.maxSpendSats) throw new Error(`cost ${notional} exceeds max spend ${limits.maxSpendSats}`);
    if (side === "buy" && limits.minReceiveSats !== undefined && notional < limits.minReceiveSats) throw new Error(`proceeds ${notional} below minimum ${limits.minReceiveSats}`);
    const offerInputs: InputSpec[] = legs.map((l) => ({
        kind: "covenant", coin: l.offer.coin, contract: offerContract(ctx.ark, l.offer.terms), fn: "fill", args: { qty: l.qty },
    }));
    const delivered = side === "buy" ? [{ assetId, amount: qty }] : [];
    const received = side === "sell" ? [{ assetId, amount: qty }] : [];
    // Units bought can go to a separate script (e.g. the taker's ClaimBox) on their own carrier.
    const routed = side === "sell" && limits.receiveScript !== undefined;
    const carrier = routed ? CARRIER_SATS : 0n;
    const walletIn = await selectWalletInputs(taker, side === "sell" ? notional + CARRIER_SATS + carrier : CARRIER_SATS, delivered);
    const value = walletIn.reduce((s, i) => s + BigInt(i.coin.value), 0n);
    const satsLeft = (side === "sell" ? value - notional : value + notional) - carrier;
    const result = await execute(ctx, [...offerInputs, ...walletIn], [
        ...legs.map((l) => legOutput(ctx, l)),
        ...(routed ? [{ script: limits.receiveScript!, amount: carrier, assets: received }] : []),
        ...changeOutput(taker, walletIn, satsLeft, delivered, routed ? [] : received),
    ], taker);
    return { ...result, qty, notional };
}

/**
 * Keeper match: a YES bid and a NO bid whose prices sum to at least one unit fund a mint of `qty` sets.
 * No maker signs; the surplus goes to `surplusScript` (or stays with the YES bid when below a carrier).
 */
export async function mintMatch(ctx: Ctx, terms: VaultTerms, yesBid: LiveOffer, noBid: LiveOffer, qty: bigint, surplusScript: Uint8Array) {
    const { vault } = marketContracts(ctx.ark, terms);
    const coin = await contractCoin(ctx, vault);
    if (!coin) throw new Error("market vault not found");
    if (yesBid.terms.side !== "buy" || noBid.terms.side !== "buy") throw new Error("mint match needs two bids");
    if (yesBid.terms.assetId !== terms.assets.yes || noBid.terms.assetId !== terms.assets.no) throw new Error("bids must be YES and NO");
    const surplus = qty * (yesBid.terms.priceSats + noBid.terms.priceSats - terms.unitSats);
    if (surplus < 0n) throw new Error("bids do not cross");
    const outs = [legOutput(ctx, { offer: yesBid, qty }), legOutput(ctx, { offer: noBid, qty })];
    const keepSurplus = surplus >= CARRIER_SATS;
    if (!keepSurplus) outs[0] = { ...outs[0]!, amount: outs[0]!.amount + surplus };
    return execute(ctx, [
        { kind: "covenant", coin, contract: vault, fn: "mint", args: { n: qty } },
        { kind: "covenant", coin: yesBid.coin, contract: offerContract(ctx.ark, yesBid.terms), fn: "fill", args: { qty } },
        { kind: "covenant", coin: noBid.coin, contract: offerContract(ctx.ark, noBid.terms), fn: "fill", args: { qty } },
    ], [
        { script: vault.pkScript, amount: BigInt(coin.value) + qty * terms.unitSats, assets: [{ assetId: terms.assets.ctrl, amount: 1n }] },
        ...outs,
        ...(keepSurplus ? [{ script: surplusScript, amount: surplus }] : []),
    ]);
}
