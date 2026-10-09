import { useState, type ReactNode } from "react";
import { CARRIER_SATS, mergeSets, mintSets, redeemAll } from "../../core/actions.js";
import { MIN_BET_SATS, minFillFor, offerTooSmall, type Side } from "../../core/offers.js";
import { BINARY_VECTORS, redemptionPayout, type BinaryOutcome } from "../../core/payout.js";
import type { BoxJson, CertificateJson, MarketJson, OfferJson, Outcome } from "../../shared/api.js";
import { api, refreshOffers } from "../api.js";
import {
    cancelFresh, ensureBox, fillWithRetry, logged, oracleKeyFor, postOrder, resolveAsOracle, sendCertificate, type Chain, type Session,
} from "../chain.js";
import { useApp } from "../ctx.js";
import { fillable, planFill, type Plan } from "../fills.js";
import { count, fromUnix, n, pct, sats, short, when } from "../format.js";
import { ActionStatus, Loading, LockedNotice, Panel, Time, Txid, outcomeName, useAction, useAsync } from "../ui.js";
import { verifiedTerms } from "../verify.js";

const VERIFYING = "Verifying the market against the Arkade indexer";

interface Live {
    m: MarketJson;
    chain: Chain;
    session: Session;
    onChanged(): void;
}

export function TradePanels({ m, offers, onChanged }: { m: MarketJson; offers?: OfferJson[]; onChanged(): void }) {
    const { chain, session } = useApp();
    if (!m.terms) return <Panel title="Place a bet"><p className="state">Betting isn't open on this market yet: its bitcoin hasn't been locked in.</p></Panel>;
    if (!chain || !session) return <Panel title="Place a bet"><LockedNotice what="place a bet" /></Panel>;
    const open = m.vault.phase === "open" && m.status !== "failed";
    const trading = open && m.status !== "halted";
    const live: Live = { m, chain, session, onChanged };
    return (
        <>
            {trading && <Ticket {...live} offers={offers} />}
            {open && !trading && <Panel title="Place a bet"><p className="state">Betting is paused until the market closes. You can still cancel your orders, or merge pairs under Advanced.</p></Panel>}
            <Position {...live} />
            {open && <Sets {...live} halted={!trading} />}
            {trading && <OrderForm {...live} />}
            <MyOrders {...live} offers={offers} />
            {open && oracleKeyFor(session, m) && <Resolve {...live} />}
        </>
    );
}

function Seg<T extends string>(props: { name: string; value: T; options: readonly (readonly [T, ReactNode])[]; onChange(v: T): void }) {
    return (
        <div className="seg" role="radiogroup" aria-label={props.name}>
            {props.options.map(([v, label]) => (
                <label key={v} className={`o-${v}${v === props.value ? " on" : ""}`}>
                    <input type="radio" name={props.name} value={v} checked={v === props.value} onChange={() => props.onChange(v)} />
                    {label}
                </label>
            ))}
        </div>
    );
}

const outcomeOptions = (m: MarketJson) => [["yes", m.outcomes[0]], ["no", m.outcomes[1]]] as const;
const assetOf = (m: MarketJson, o: Outcome) => (o === "yes" ? m.terms!.assets.yes : m.terms!.assets.no);

function Ticket({ m, chain, session, onChanged, offers }: Live & { offers?: OfferJson[] }) {
    const { config, holdings, refreshHoldings } = useApp();
    const unit = BigInt(m.terms!.unitSats);
    const [side, setSide] = useState<Side>("buy");
    const [outcome, setOutcome] = useState<Outcome>(() => (new URLSearchParams(location.search).get("o") === "no" ? "no" : "yes"));
    const [qtyText, setQtyText] = useState("1");
    const [boundText, setBoundText] = useState<string | null>(null);
    const [autoClaim, setAutoClaim] = useState(false);
    const act = useAction();
    const label = m.outcomes[outcome === "yes" ? 0 : 1];
    const qty = count(qtyText);
    // The asset decides what a fill delivers; the server's outcome label is presentation only.
    const book = (offers ?? []).filter((o) => o.terms.assetId === assetOf(m, outcome));
    const plan = offers && qty ? planFill(book, side, qty, Math.floor(Date.now() / 1000), session.script) : null;
    const bound = boundText === null ? plan?.notional ?? null : count(boundText);
    const held = holdings?.assets.get(assetOf(m, outcome)) ?? 0n;
    const boxed = side === "buy" && autoClaim;
    const carriers = boxed ? 2n * CARRIER_SATS : CARRIER_SATS;

    const nowUnix = Math.floor(Date.now() / 1000);
    const resting = book.filter((o) => o.terms.side === (side === "buy" ? "sell" : "buy") && fillable(o, nowUnix, session.script));
    // Smallest size the book fills, when the one entered falls under the 330-sat minimum or an offer's min fill.
    const minShares = plan && plan.legs.length === 0 && resting.length > 0 && qty
        ? Array.from({ length: 400 }, (_, i) => qty + BigInt(i + 1)).find((q) => planFill(book, side, q, nowUnix, session.script).qty === q) ?? null
        : null;

    const minimum = side === "buy" ? "Minimum bet" : "Minimum cash-out";
    let blocker: string | null = null;
    if (!offers) blocker = "Loading prices";
    else if (!qty) blocker = "Enter a whole number of shares";
    else if (resting.length === 0) blocker = `No one is ${side === "buy" ? "offering" : "buying"} ${label} right now. The house stops quoting once an event starts; set your own price below instead.`;
    else if (!plan || plan.legs.length === 0) blocker = minShares ? `${minimum} is ${sats(MIN_BET_SATS)}: ${n(minShares)} shares at this price` : "No one is matching this many shares right now";
    else if (plan.qty < qty) blocker = `Only ${n(plan.qty)} of ${n(qty)} shares are available right now (${n(plan.depth)} on offer, some only in bigger chunks)`;
    else if (plan.notional < MIN_BET_SATS) blocker = `${minimum} is ${sats(MIN_BET_SATS)}; this one is ${sats(plan.notional)}`;
    else if (bound === null) blocker = `Enter a valid ${side === "buy" ? "max spend" : "lowest payout"}`;
    else if (side === "buy" ? plan.notional > bound : plan.notional < bound) blocker = side === "buy" ? "This bet costs more than your max spend" : "This cash-out pays less than your lowest payout";
    else if (side === "buy" && holdings && holdings.plainSats < plan.notional + carriers) {
        blocker = `You need ${sats(plan.notional + carriers)}: your bet plus ${carriers === CARRIER_SATS ? "" : "2 × "}${CARRIER_SATS} sats held with your shares (the minimum any coin needs). You have ${sats(holdings.plainSats)}`;
    } else if (side === "sell" && held < qty) blocker = `You only have ${n(held)} ${label} shares`;

    const submit = () => act.run(async (step) => {
        step(VERIFYING);
        const terms = await verifiedTerms(chain, config, m);
        let receiveScript: Uint8Array | undefined;
        if (boxed) {
            step("Setting up automatic payout");
            receiveScript = await ensureBox(chain, session, m, terms);
        }
        step(side === "buy" ? "Placing your bet" : "Cashing out");
        const r = await logged(chain, session,
            { kind: side, label: `${side === "buy" ? "Bet on" : "Cash out"} ${qty} ${label}${boxed ? " (paid automatically)" : ""}`, marketId: m.id, outcome, qty: String(qty) },
            (ctx) => fillWithRetry(ctx, session.party, book, { side, qty: qty!, bound: bound!, takerScript: session.script, receiveScript, assetId: terms.assets[outcome] }),
            (r) => ({ sats: r.notional.toString(), qty: r.qty.toString() }));
        step("Updating prices");
        await refreshOffers(r.touched);
        onChanged();
        void refreshHoldings();
        setBoundText(null);
        return (
            <>
                {side === "buy" ? "Bet placed:" : "Cashed out"} {n(r.qty)} {label} shares for {sats(r.notional)}{boxed ? ", paid out automatically when the market resolves" : ""}
                {r.retried ? " (a price changed while you were betting, so we re-checked it)" : ""}. <Txid txid={r.txid} />
            </>
        );
    });

    const resetBound = () => setBoundText(null);
    return (
        <Panel title="Place a bet" className="ticket">
            <Seg name="Side" value={side} options={[["buy", "Bet"], ["sell", "Cash out"]] as const} onChange={(v) => { setSide(v); resetBound(); }} />
            <Seg name="Outcome" value={outcome} options={outcomeOptions(m)} onChange={(v) => { setOutcome(v); resetBound(); }} />
            <label className="field">
                <span>Shares</span>
                <input inputMode="numeric" autoComplete="off" value={qtyText} onChange={(e) => { setQtyText(e.target.value); resetBound(); }} />
                <small className="muted">Each share pays {sats(unit)} if you're right, 0 if not. Price = the crowd's odds.</small>
            </label>
            {plan && plan.legs.length > 0 && <Preview plan={plan} side={side} unit={unit} label={label} />}
            <label className="field">
                <span>{side === "buy" ? "Max spend (sats)" : "Lowest payout you'll take (sats)"}</span>
                <input inputMode="numeric" autoComplete="off" value={boundText ?? plan?.notional.toString() ?? ""} onChange={(e) => setBoundText(e.target.value)} />
                <small className="muted">
                    {boundText === null
                        ? side === "buy" ? "Set to the cost shown. Raise it a little in case prices move." : "Set to the payout shown. Lower it a little in case prices move."
                        : <button type="button" className="linklike" onClick={resetBound}>Reset to the price shown</button>}
                </small>
            </label>
            {side === "buy" && (
                <label className="check">
                    <input type="checkbox" checked={autoClaim} onChange={(e) => setAutoClaim(e.target.checked)} />
                    <span>
                        Get paid automatically
                        <small className="muted block">Your shares go into a box that can only ever pay this wallet; we trigger the payout when the market resolves, even if you never come back. The box holds {CARRIER_SATS} sats (the minimum any coin needs), returned with your winnings. To cash out early, withdraw from Your bets first.</small>
                    </span>
                </label>
            )}
            {Date.parse(m.closeAt) <= Date.now() && <p className="notice warn">This market has closed. The result may already be known, and open orders can still be matched.</p>}
            {blocker && <p className="hint">{blocker}{minShares && !(plan?.legs.length) ? <> <button type="button" className="btn small" onClick={() => setQtyText(minShares.toString())}>Use {n(minShares)}</button></> : null}</p>}
            <button type="button" className={`btn wide ${side}`} disabled={!!blocker || act.busy} onClick={() => void submit()}>
                {plan && qty && !blocker
                    ? side === "buy" ? `Bet on ${label}: ${n(qty)} shares for ${sats(plan.notional)}` : `Cash out ${n(qty)} ${label} shares for ${sats(plan.notional)}`
                    : side === "buy" ? `Bet on ${label}` : "Cash out"}
            </button>
            <ActionStatus s={act} />
        </Panel>
    );
}

function Preview({ plan, side, unit, label }: { plan: Plan; side: Side; unit: bigint; label: string }) {
    const avg10 = (plan.notional * 10n) / plan.qty;
    return (
        <div className="preview">
            <table className="data compact">
                <thead><tr><th scope="col" className="num">Price</th><th scope="col" className="num">Shares</th><th scope="col" className="num">Sats</th></tr></thead>
                <tbody>
                    {plan.legs.map((l) => (
                        <tr key={l.offer.id}>
                            <td className="num">{n(l.price)} <span className="muted">{pct(l.price, unit)}</span></td>
                            <td className="num">{n(l.qty)}</td>
                            <td className="num">{n(l.qty * l.price)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <dl className="kv tight">
                <dt>{side === "buy" ? "You pay" : "You get"}</dt><dd className="strong">{sats(plan.notional)}</dd>
                <dt>Average price</dt><dd>{`${avg10 / 10n}.${avg10 % 10n}`} sats per share ({pct(plan.notional / plan.qty, unit)} chance)</dd>
                {side === "buy"
                    ? <><dt>If {label} wins</dt><dd>you collect {sats(plan.qty * unit)}</dd></>
                    : <><dt>You give up</dt><dd>{n(plan.qty)} {label} shares</dd></>}
            </dl>
        </div>
    );
}

export const boxShares = (boxes: BoxJson[], assetId: string) =>
    boxes.flatMap((b) => b.coins).flatMap((c) => c.assets).filter((a) => a.assetId === assetId).reduce((s, a) => s + BigInt(a.amount), 0n);

function Position({ m, chain, session, onChanged }: Live) {
    const { config, holdings, holdingsError, refreshHoldings } = useApp();
    const act = useAction();
    const t = m.terms!;
    const boxes = useAsync(() => api<{ boxes: BoxJson[] }>(`/api/boxes?ownerScript=${session.script}`).then((r) => r.boxes.filter((b) => b.marketId === m.id)), [session.script, m]);
    const boxYes = boxShares(boxes.data ?? [], t.assets.yes);
    const boxNo = boxShares(boxes.data ?? [], t.assets.no);
    const boxLine = boxYes + boxNo > 0n && (
        <p className="small">
            Paid automatically: {n(boxYes)} {m.outcomes[0]} and {n(boxNo)} {m.outcomes[1]} shares. When the market resolves, any winnings go straight to this wallet.
        </p>
    );
    if (!holdings) return <Panel title="Your bets">{holdingsError ? <p className="error">{holdingsError}</p> : <Loading what="balances" />}{boxLine}</Panel>;
    const yes = holdings.assets.get(t.assets.yes) ?? 0n;
    const no = holdings.assets.get(t.assets.no) ?? 0n;
    const outcome = m.vault.phase === "resolved" ? m.vault.outcome : null;
    const payout = outcome ? redemptionPayout([yes, no], BINARY_VECTORS[outcome], BigInt(t.unitSats)) : 0n;
    const redeem = (o: BinaryOutcome) => act.run(async (step) => {
        step(VERIFYING);
        const terms = await verifiedTerms(chain, config, m);
        step("Collecting your winnings");
        const r = await logged(chain, session, { kind: "redeem", label: `Collect winnings: ${m.question.slice(0, 60)}`, marketId: m.id, outcome: o },
            (ctx) => redeemAll(ctx, session.party, terms, o),
            (r) => ({ sats: r.payout.toString(), qty: String(r.yesBurn + r.noBurn) }));
        void refreshHoldings();
        onChanged();
        return <>Collected {sats(r.payout)} for {n(r.yesBurn)} {m.outcomes[0]} and {n(r.noBurn)} {m.outcomes[1]} shares. <Txid txid={r.txid} /></>;
    });
    return (
        <Panel title="Your bets">
            {boxLine}
            {yes === 0n && no === 0n ? <p className="state">You have no bets in your wallet on this market.</p> : (
                <table className="data compact">
                    <thead><tr><th scope="col">Outcome</th><th scope="col" className="num">Shares</th><th scope="col" className="num">Cash-out price</th><th scope="col" className="num">Cash-out value (sats)</th></tr></thead>
                    <tbody>
                        {([["yes", yes], ["no", no]] as const).map(([o, qty], i) => {
                            const bid = m.book[o].bid;
                            return (
                                <tr key={o}>
                                    <td>{m.outcomes[i]}</td>
                                    <td className="num">{n(qty)}</td>
                                    <td className="num">{bid ? n(bid) : "—"}</td>
                                    <td className="num">{bid ? n(qty * BigInt(bid)) : "no buyers"}</td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
            {outcome && (yes > 0n || no > 0n) && (
                <>
                    <p>Result: {outcomeName(m, outcome)}. Your winnings: <strong>{sats(payout)}</strong>.</p>
                    <button type="button" className="btn primary wide" disabled={act.busy} onClick={() => void redeem(outcome)}>
                        {payout > 0n ? `Collect ${sats(payout)} winnings` : "Clear losing shares (pays 0 sats)"}
                    </button>
                </>
            )}
            <ActionStatus s={act} />
        </Panel>
    );
}

function Sets({ m, chain, session, onChanged, halted }: Live & { halted: boolean }) {
    const { config, holdings, refreshHoldings } = useApp();
    const t = m.terms!;
    const unit = BigInt(t.unitSats);
    const [text, setText] = useState("1");
    const act = useAction();
    const k = count(text);
    const yes = holdings?.assets.get(t.assets.yes) ?? 0n;
    const no = holdings?.assets.get(t.assets.no) ?? 0n;
    const room = m.vault.valueSats ? (BigInt(t.capSats) - BigInt(m.vault.valueSats)) / unit : null;
    const mintBlock = halted ? "betting is paused until the market closes"
        : !k ? "enter a whole number of pairs"
        : room !== null && k > room ? `this market has room for ${n(room)} more pairs`
        : holdings && holdings.plainSats < k * unit + CARRIER_SATS ? `you need ${sats(k * unit + CARRIER_SATS)} in your balance` : null;
    const mergeBlock = !k ? "enter a whole number of pairs" : yes < k || no < k ? `you need ${n(k)} of each; you have ${n(yes)} ${m.outcomes[0]} and ${n(no)} ${m.outcomes[1]}` : null;
    const run = (kind: "mint" | "merge") => act.run(async (step) => {
        step(VERIFYING);
        const terms = await verifiedTerms(chain, config, m);
        step(kind === "mint" ? "Minting pairs" : "Merging pairs");
        const r = await logged(chain, session, { kind, label: `${kind === "mint" ? "Mint" : "Merge"} ${k} pairs`, marketId: m.id, qty: String(k), sats: String(k! * unit) },
            (ctx) => (kind === "mint" ? mintSets : mergeSets)(ctx, session.party, terms, k!));
        void refreshHoldings();
        onChanged();
        return <>{kind === "mint" ? "Minted" : "Merged"} {n(k!)} pairs {kind === "mint" ? "for" : "into"} {sats(k! * unit)}. <Txid txid={r.txid} /></>;
    });
    return (
        <Panel title="Advanced">
            <details>
                <summary>Mint or merge {m.outcomes[0]} + {m.outcomes[1]} pairs</summary>
                <p className="muted small">Mint: lock {sats(unit)} to get one {m.outcomes[0]} and one {m.outcomes[1]} share. Merge: hand one of each back for {sats(unit)}.</p>
                <label className="field">
                    <span>Pairs</span>
                    <input inputMode="numeric" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} />
                </label>
                <div className="row2">
                    <button type="button" className="btn" disabled={!!mintBlock || act.busy} onClick={() => void run("mint")}>Mint{k ? ` for ${sats(k * unit)}` : ""}</button>
                    <button type="button" className="btn" disabled={!!mergeBlock || act.busy} onClick={() => void run("merge")}>Merge{k ? ` for ${sats(k * unit)}` : ""}</button>
                </div>
                {mintBlock && <p className="hint">Mint: {mintBlock}.</p>}
                {mergeBlock && <p className="hint">Merge: {mergeBlock}.</p>}
                <ActionStatus s={act} />
            </details>
        </Panel>
    );
}

const EXPIRY = [["none", "No expiry"], ["3600", "1 hour"], ["86400", "1 day"], ["604800", "7 days"], ["custom", "Custom"]] as const;
const randomInt = (max: number) => crypto.getRandomValues(new Uint32Array(1))[0]! % max;

/** Identical terms share one offer script and the server keeps one live offer per script, so expiries get jitter. */
function expiryUnix(choice: string, customUnix: number): bigint {
    const now = Math.floor(Date.now() / 1000);
    if (choice === "none") return BigInt(now + 5 * 365 * 86400 + randomInt(86400));
    return BigInt((choice === "custom" ? customUnix : now + Number(choice)) + randomInt(60));
}

function OrderForm({ m, chain, session, onChanged }: Live) {
    const { config, holdings, refreshHoldings } = useApp();
    const unit = BigInt(m.terms!.unitSats);
    const [side, setSide] = useState<Side>("buy");
    const [outcome, setOutcome] = useState<Outcome>("yes");
    const [priceText, setPrice] = useState("");
    const [sizeText, setSize] = useState("1");
    const [minText, setMin] = useState("");
    const [expiry, setExpiry] = useState<string>("none");
    const [custom, setCustom] = useState("");
    const act = useAction();
    const price = count(priceText);
    const size = count(sizeText);
    const autoMin = price ? minFillFor(price) : null;
    const minFill = minText ? count(minText) : autoMin;
    const label = m.outcomes[outcome === "yes" ? 0 : 1];
    const held = holdings?.assets.get(assetOf(m, outcome)) ?? 0n;
    const customUnix = custom ? Math.floor(new Date(custom).getTime() / 1000) : NaN;
    const quote = m.book[outcome];

    let blocker: string | null = null;
    if (!price || price >= unit) blocker = `Price must be 1 to ${n(unit - 1n)} sats per share`;
    else if (!size) blocker = "Enter a whole number of shares";
    else if (!minFill || minFill > size) blocker = "Smallest partial fill must be between 1 and your number of shares";
    else if (offerTooSmall({ priceSats: price, minFill }, size)) {
        blocker = size * price < MIN_BET_SATS ? `Minimum order is ${sats(MIN_BET_SATS)}`
            : `Smallest partial fill must be worth at least ${sats(MIN_BET_SATS)}: ${n(minFillFor(price))} shares at this price`;
    } else if (expiry === "custom" && !(customUnix > Date.now() / 1000 + 60)) blocker = "Pick an expiry at least a minute ahead";
    else if (side === "buy" && holdings && holdings.plainSats < size * price + 2n * CARRIER_SATS) {
        blocker = `You need ${sats(size * price + 2n * CARRIER_SATS)}: your order plus 2 × ${CARRIER_SATS} sats (the minimum any coin needs)`;
    } else if (side === "sell" && held < size) blocker = `You only have ${n(held)} ${label} shares`;
    const crosses = !!price && (side === "buy" ? !!quote.ask && price >= BigInt(quote.ask) : !!quote.bid && price <= BigInt(quote.bid));

    const submit = () => act.run(async (step) => {
        step(VERIFYING);
        const terms = await verifiedTerms(chain, config, m);
        step("Placing your order");
        const r = await postOrder(chain, session, config, m, terms, { side, outcome, price: price!, size: size!, minFill: minFill!, expiresAt: expiryUnix(expiry, customUnix) });
        void refreshHoldings();
        onChanged();
        if (r.registerError) throw new Error(`Your order is funded (tx ${short(r.txid)}) but the server hasn't listed it yet: ${r.registerError}. Retry it from Portfolio, Pending.`);
        return <>Order posted: {side === "buy" ? "bet on" : "cash out"} {n(size!)} {label} at {n(price!)} sats. <Txid txid={r.txid} /></>;
    });

    return (
        <Panel title="Set your own price">
            <p className="muted small">Don't like the current price? Name yours. Your order waits until someone takes it, and you can cancel any time before then.</p>
            <Seg name="Order side" value={side} options={[["buy", "Bet"], ["sell", "Cash out"]] as const} onChange={(v) => setSide(v)} />
            <Seg name="Order outcome" value={outcome} options={outcomeOptions(m)} onChange={(v) => setOutcome(v)} />
            <div className="row2">
                <label className="field">
                    <span>Price per share (sats)</span>
                    <input inputMode="numeric" autoComplete="off" value={priceText} onChange={(e) => setPrice(e.target.value)} placeholder={`1–${n(unit - 1n)}`} />
                    <small className="muted">{price ? `${pct(price, unit)} chance` : " "}</small>
                </label>
                <label className="field">
                    <span>Shares</span>
                    <input inputMode="numeric" autoComplete="off" value={sizeText} onChange={(e) => setSize(e.target.value)} />
                </label>
            </div>
            <div className="row2">
                <label className="field">
                    <span>Smallest partial fill (shares)</span>
                    <input inputMode="numeric" autoComplete="off" value={minText} onChange={(e) => setMin(e.target.value)} placeholder={autoMin ? `${n(autoMin)} (${sats(MIN_BET_SATS)})` : ""} />
                </label>
                <label className="field">
                    <span>Expires</span>
                    <select value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                        {EXPIRY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                </label>
            </div>
            {expiry === "custom" && (
                <label className="field">
                    <span>Expires at (local time)</span>
                    <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
                </label>
            )}
            {price && size ? (
                <p className="muted small">
                    {side === "buy"
                        ? `Sets aside ${sats(size * price + CARRIER_SATS)} now (your order plus ${CARRIER_SATS} sats held with it). Shares you get wait in the order until it fills completely or you cancel it.`
                        : `Sets aside ${n(size)} ${label} shares and ${CARRIER_SATS} sats. Your cash collects in the order and is paid out on the last fill or when you cancel.`}
                </p>
            ) : null}
            {crosses && <p className="notice warn">You can already get this price right now. Orders here never match existing prices automatically: use Place a bet above instead.</p>}
            {blocker && <p className="hint">{blocker}</p>}
            <button type="button" className="btn primary wide" disabled={!!blocker || act.busy} onClick={() => void submit()}>
                {price && size ? `Post order: ${side === "buy" ? "bet on" : "cash out"} ${n(size)} ${label} at ${n(price)} sats` : "Post order"}
            </button>
            <ActionStatus s={act} />
        </Panel>
    );
}

function MyOrders({ m, onChanged, session, offers }: Live & { offers?: OfferJson[] }) {
    if (!offers) return null;
    const mine = offers.filter((o) => o.terms.makerScript === session.script && o.status === "open");
    return (
        <Panel title="Open orders">
            {m.status === "halted" && mine.length > 0 && <p className="notice warn">Others can still take these orders while betting is paused here. Cancel any you no longer want.</p>}
            {mine.length === 0 ? <p className="state">No open orders in this market.</p> : (
                <table className="data compact">
                    <thead><tr><th scope="col">Order</th><th scope="col" className="num">Price</th><th scope="col" className="num">Shares left</th><th scope="col">Expires</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
                    <tbody>
                        {mine.map((o) => {
                            const label = `${o.terms.side === "buy" ? "Bet on" : "Cash out"} ${m.outcomes[o.outcome === "yes" ? 0 : 1]}`;
                            return (
                                <tr key={o.id}>
                                    <td>{label}</td>
                                    <td className="num">{n(o.terms.priceSats)}</td>
                                    <td className="num">{n(o.remaining)}</td>
                                    <td><Time t={fromUnix(o.terms.expiresAtUnix)} /></td>
                                    <td><CancelButton o={o} label={`${label} @ ${o.terms.priceSats}`} onDone={onChanged} /></td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            )}
        </Panel>
    );
}

export function CancelButton({ o, label, onDone }: { o: OfferJson; label: string; onDone(): void }) {
    const { chain, session, refreshHoldings } = useApp();
    const act = useAction();
    if (!chain || !session) return null;
    const cancel = () => act.run(async (step) => {
        step("Cancelling");
        const r = await logged(chain, session, { kind: "cancel", label: `Cancel ${label}`, marketId: o.marketId, outcome: o.outcome },
            (ctx) => cancelFresh(ctx, session.party, o));
        await refreshOffers([o.id]);
        onDone();
        void refreshHoldings();
        return <>Cancelled. <Txid txid={r.txid} /></>;
    });
    return (
        <>
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void cancel()}>{act.busy ? "Cancelling…" : "Cancel"}</button>
            <ActionStatus s={act} />
        </>
    );
}

function Resolve({ m, chain, session, onChanged }: Live) {
    const { config } = useApp();
    const [outcome, setOutcome] = useState<BinaryOutcome>("yes");
    const [note, setNote] = useState("");
    const [sure, setSure] = useState(false);
    const [unsent, setUnsent] = useState<CertificateJson | null>(null);
    const act = useAction();
    const early = Date.now() < Number(m.terms!.closeAtUnix) * 1000;
    const resolve = () => act.run(async (step) => {
        step(VERIFYING);
        const terms = await verifiedTerms(chain, config, m);
        step("Signing the attestation and resolving the vault");
        const r = await resolveAsOracle(chain, session, m, terms, outcome, note.trim());
        onChanged();
        setUnsent(r.postError ? r.certificate : null);
        if (!r.txid && r.postError) throw new Error(`The resolve transaction failed (${r.resolveError}) and the server refused the certificate (${r.postError}).`);
        return (
            <>
                {r.txid ? <>Vault resolved to {outcomeName(m, outcome)}. <Txid txid={r.txid} /></> : <>The resolve transaction failed: {r.resolveError}. The server's keeper can submit it from your certificate.</>}
                {r.postError ? ` The server refused the certificate: ${r.postError}.` : " Certificate delivered to the server."}
            </>
        );
    });
    const resend = () => act.run(async () => {
        const { postError } = await sendCertificate(m.id, unsent!);
        if (postError) throw new Error(postError);
        setUnsent(null);
        onChanged();
        return "Certificate delivered to the server.";
    });
    return (
        <Panel title="Resolve this market" className="resolve">
            <p className="muted small">This wallet holds the market's oracle key. Your signature decides the payout and is final and public.</p>
            {early && <p className="notice warn">The vault accepts a resolution only after close time ({when(fromUnix(m.terms!.closeAtUnix))}).</p>}
            <fieldset className="choices">
                <legend>Outcome</legend>
                {(["yes", "no", "invalid"] as const).map((o) => (
                    <label key={o} className="radio">
                        <input type="radio" name="resolve-outcome" value={o} checked={outcome === o} onChange={() => setOutcome(o)} />
                        {o === "invalid" ? "Invalid: every share pays half" : `${outcomeName(m, o)} wins`}
                    </label>
                ))}
            </fieldset>
            <label className="field">
                <span>Note (part of the signed evidence)</span>
                <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <label className="check">
                <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} /> I understand this cannot be undone.
            </label>
            <button type="button" className="btn danger wide" disabled={!sure || early || act.busy} onClick={() => void resolve()}>
                Sign and resolve: {outcomeName(m, outcome)}
            </button>
            {unsent && <button type="button" className="btn wide" disabled={act.busy} onClick={() => void resend()}>Re-send certificate</button>}
            <ActionStatus s={act} />
        </Panel>
    );
}
