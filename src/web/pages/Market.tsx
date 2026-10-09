import type { CertificateJson, MarketJson, OfferJson, OraclePolicy, SourceJson, TradeJson } from "../../shared/api.js";
import { api, enc, useLive } from "../api.js";
import { useApp } from "../ctx.js";
import { fillable } from "../fills.js";
import { chanceOf, fromUnix, isReplay, n, pct, refPct, safeHref, sats, unavailableReason, when } from "../format.js";
import { ErrorBox, Link, Loading, Panel, PixBar, StatusBadge, Time, Txid, outcomeName, useAsync, useNow } from "../ui.js";
import { TradePanels } from "./Trade.js";

const POLICY: Record<OraclePolicy, string> = {
    "platform-attestor": "Platform attestor: signs only after verifying the source's final on-chain resolution",
    "external-key": "External key: whoever holds this key decides the outcome",
    "dev-oracle": "Development oracle: operator-controlled key, test networks only",
    redstone: "RedStone's signed prices: the vault verifies the signatures itself, with no attestor in between",
};

export function MarketPage({ id }: { id: string }) {
    const { config, session } = useApp();
    const market = useAsync(() => api<MarketJson>(`/api/markets/${enc(id)}`), [id]);
    const offers = useAsync(() => api<{ offers: OfferJson[] }>(`/api/markets/${enc(id)}/offers?status=open`).then((r) => r.offers), [id]);
    const trades = useAsync(() => api<{ trades: TradeJson[] }>(`/api/markets/${enc(id)}/trades?limit=50`).then((r) => r.trades), [id]);
    const reload = () => {
        market.reload();
        offers.reload();
        trades.reload();
    };
    useLive((c) => {
        if (c === "all" || c.has(id)) reload();
    });
    const now = useNow(15_000);
    if (!market.data) return market.error ? <ErrorBox error={market.error} onRetry={market.reload} /> : <Loading what="market" />;
    const m = market.data;
    const unit = m.terms?.unitSats ?? config.unitSats;
    const awaiting = Date.parse(m.closeAt) <= now && m.vault.phase !== "resolved";
    const reason = unavailableReason(m);
    return (
        <div className="stack">
            <header className="mhead">
                <div className="crumbs"><Link to="/">Markets</Link> / {m.source?.event?.title ?? m.category ?? "Uncategorised"}</div>
                <div className="title-row">
                    {safeHref(m.source?.image)?.startsWith("https://") && <img className="thumb big" src={m.source!.image!} alt="" referrerPolicy="no-referrer" />}
                    <h1>{m.question}</h1>
                </div>
                <div className="meta-row">
                    <StatusBadge m={m} />
                    <span>{m.kind === "polymarket" ? "Polymarket mirror" : "Custom market"}</span>
                    <span>Closes <Time t={m.closeAt} now={now} /> · {when(m.closeAt)}</span>
                    <span>Collateral BTC: a winning share pays {n(unit)} sats</span>
                    {m.oracle.policy === "dev-oracle" && <span className="badge dev">dev oracle</span>}
                    {isReplay(m) && <span className="badge dev">historical replay</span>}
                </div>
                {reason && <p className="notice danger">{reason}</p>}
                {m.status === "halted" && (
                    <p className="notice warn" role="status">
                        {m.resolution.status === "certified"
                            ? `The oracle certified the outcome before the close${m.resolution.detail ? `: ${m.resolution.detail}` : ""}`
                            : m.resolution.detail || "The source market resolved early"}
                        . Trading is halted; payouts open after the close.
                    </p>
                )}
                {isReplay(m) && <p className="notice">Historical replay: this mirrors a Polymarket market that has already resolved, to exercise settlement on a test network. Its outcome is public.</p>}
                {awaiting && (
                    <p className="notice warn">
                        Closed, awaiting resolution: {m.resolution.status}{m.resolution.detail ? `. ${m.resolution.detail}` : ""}.
                        {m.terms && m.terms.timeoutAtUnix !== "0" && ` If nobody resolves it by ${when(fromUnix(m.terms.timeoutAtUnix))}, every complete set splits 50/50.`}
                    </p>
                )}
                {m.oracle.policy === "dev-oracle" && <p className="notice">This market is resolved by a development oracle the operator controls. It exists for testing only.</p>}
            </header>
            <div className="mcols">
                <div className="stack mtop">
                    <Quotes m={m} unit={unit} />
                    <Panel title="Order book">
                        {offers.data ? <Books m={m} offers={offers.data} unit={unit} mine={session?.script} now={now} />
                            : offers.error ? <ErrorBox error={offers.error} onRetry={offers.reload} /> : <Loading what="order book" />}
                    </Panel>
                </div>
                <div className="stack mrest">
                    <Panel title="Recent trades">
                        {trades.data ? <Trades m={m} trades={trades.data} unit={unit} now={now} />
                            : trades.error ? <ErrorBox error={trades.error} onRetry={trades.reload} /> : <Loading what="trades" />}
                    </Panel>
                    <Panel title="Question and rules">
                        <p className="prose strong">{m.question}</p>
                        <p className="prose">{m.rules || "No rules text was provided."}</p>
                        <p className="muted small">Outcomes: “{m.outcomes[0]}” and “{m.outcomes[1]}”. Market text is shown exactly as submitted.</p>
                    </Panel>
                    <Oracle m={m} />
                    <Vault m={m} />
                    {m.source && <Source s={m.source} />}
                </div>
                <aside className="stack mside" aria-label="Trading">
                    <TradePanels m={m} offers={offers.data} onChanged={reload} />
                </aside>
            </div>
        </div>
    );
}

function Quotes({ m, unit }: { m: MarketJson; unit: string }) {
    const chance = chanceOf(m);
    const share = (o: 0 | 1) => (chance ? Math.round((o === 0 ? chance.p : 1 - chance.p) * 100) : null);
    return (
        <section className="scoreboard" aria-label="Prices">
            <div className="quotes">
                {(["yes", "no"] as const).map((o, i) => {
                    const q = m.book[o];
                    const s = share(i as 0 | 1);
                    return (
                        <div key={o} className={`quote-card ${i === 0 ? "a" : "b"}`}>
                            <div className="olabel">{m.outcomes[i]}</div>
                            <div className="big">{s === null ? "—" : `${s}%`}</div>
                            <div className="qline"><span className="muted">Bid</span> <span className="bid num">{q.bid ? n(q.bid) : "—"}</span> <span className="muted">Ask</span> <span className="ask num">{q.ask ? n(q.ask) : "—"}</span></div>
                            {!q.bid && !q.ask && <div className="muted small">No liquidity</div>}
                        </div>
                    );
                })}
            </div>
            <PixBar p={chance?.p ?? null} />
            <p className="muted small">
                {chance?.from === "resolved" ? "Resolved." : chance?.from === "reference" ? "Polymarket's odds for reference; nothing is executable here until someone posts an order."
                    : chance ? `Midpoint of the best ${m.outcomes[0]} bid and ask, in sats per ${n(unit)}-sat share.` : "No orders yet."}
            </p>
        </section>
    );
}

const priceOf = (o: OfferJson) => BigInt(o.terms.priceSats);
const byPriceDesc = (a: OfferJson, b: OfferJson) => (priceOf(a) === priceOf(b) ? 0 : priceOf(a) < priceOf(b) ? 1 : -1);

function Books(props: { m: MarketJson; offers: OfferJson[]; unit: string; mine?: string; now: number }) {
    const nowUnix = Math.floor(props.now / 1000);
    return (
        <div className="books">
            {(["yes", "no"] as const).map((o, i) => {
                const live = props.offers.filter((x) => x.outcome === o && fillable(x, nowUnix));
                // Asks descend so the best ask sits just above the spread line, bids descend below it.
                const asks = live.filter((x) => x.terms.side === "sell").sort(byPriceDesc);
                const bids = live.filter((x) => x.terms.side === "buy").sort(byPriceDesc);
                const bestAsk = asks.at(-1);
                const spread = bestAsk && bids[0] ? priceOf(bestAsk) - priceOf(bids[0]) : null;
                return (
                    <div key={o} className="book">
                        <h3>{props.m.outcomes[i]}</h3>
                        {live.length === 0 ? <p className="state">No liquidity</p> : (
                            <div className="table-wrap">
                                <table className="data compact">
                                    <thead>
                                        <tr><th scope="col">Side</th><th scope="col" className="num">Price</th><th scope="col" className="num">Implied</th><th scope="col" className="num">Shares</th><th scope="col" className="num">Min fill</th><th scope="col">Expires</th></tr>
                                    </thead>
                                    <tbody>
                                        {asks.map((x) => <BookRow key={x.id} o={x} unit={props.unit} mine={props.mine} now={props.now} />)}
                                        <tr className="spread"><td colSpan={6}>{spread === null ? "One-sided book" : `Spread ${n(spread)} sats`}</td></tr>
                                        {bids.map((x) => <BookRow key={x.id} o={x} unit={props.unit} mine={props.mine} now={props.now} />)}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}

function BookRow({ o, unit, mine, now }: { o: OfferJson; unit: string; mine?: string; now: number }) {
    const ask = o.terms.side === "sell";
    return (
        <tr className={ask ? "ask-row" : "bid-row"}>
            <td>{ask ? "Ask" : "Bid"}{o.terms.makerScript === mine && <span className="badge mine">yours</span>}</td>
            <td className={`num ${ask ? "ask" : "bid"}`}>{n(o.terms.priceSats)}</td>
            <td className="num muted">{pct(o.terms.priceSats, unit)}</td>
            <td className="num">{n(o.remaining)}</td>
            <td className="num">{n(o.terms.minFill)}</td>
            <td>{o.terms.expiresAtUnix === "0" ? "never" : <Time t={fromUnix(o.terms.expiresAtUnix)} now={now} />}</td>
        </tr>
    );
}

function Trades({ m, trades, unit, now }: { m: MarketJson; trades: TradeJson[]; unit: string; now: number }) {
    if (trades.length === 0) return <p className="state">No trades yet.</p>;
    return (
        <div className="table-wrap">
            <table className="data compact">
                <thead>
                    <tr><th scope="col">Time</th><th scope="col">Outcome</th><th scope="col">Taker</th><th scope="col" className="num">Shares</th><th scope="col" className="num">Price</th><th scope="col">Tx</th></tr>
                </thead>
                <tbody>
                    {trades.map((t, i) => (
                        <tr key={`${t.txid}:${t.offerId ?? ""}:${i}`}>
                            <td><Time t={t.at} now={now} /></td>
                            <td>{m.outcomes[t.outcome === "yes" ? 0 : 1]}</td>
                            <td>{t.kind === "mint-match" ? "mint match" : t.makerSide === "sell" ? "bought" : "sold"}</td>
                            <td className="num">{n(t.qty)}</td>
                            <td className="num">{n(t.priceSats)} <span className="muted">{pct(t.priceSats, unit)}</span></td>
                            <td><Txid txid={t.txid} /></td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function Oracle({ m }: { m: MarketJson }) {
    return (
        <Panel title="Oracle and resolution">
            <dl className="kv">
                <dt>Policy</dt><dd>{POLICY[m.oracle.policy]}{m.oracle.label ? ` (${m.oracle.label})` : ""}</dd>
                <dt>Keys</dt><dd className="mono break">{m.oracle.keys.join("\n") || "—"}</dd>
                <dt>Threshold</dt><dd>{m.oracle.threshold} of {m.oracle.keys.length}, epoch {m.oracle.epoch}</dd>
                <dt>Status</dt><dd>{m.resolution.status}</dd>
                {m.resolution.detail && <><dt>Detail</dt><dd className="prose">{m.resolution.detail}</dd></>}
            </dl>
            {m.resolution.certificate && <Certificate m={m} c={m.resolution.certificate} />}
        </Panel>
    );
}

function Certificate({ m, c }: { m: MarketJson; c: CertificateJson }) {
    return (
        <>
            <h3>Certificate</h3>
            <dl className="kv">
                <dt>Outcome</dt><dd>{outcomeName(m, c.outcome)} (vector {c.numerators.join(", ")} / {c.denominator})</dd>
                <dt>Issued</dt><dd>{when(c.issuedAt)}</dd>
                <dt>Signer</dt><dd className="mono break">{c.signer}</dd>
                <dt>Evidence digest</dt><dd className="mono break">{c.evidenceDigest}</dd>
                <dt>Signature</dt><dd className="mono break">{c.signature}</dd>
                {c.sourceBlock && <><dt>Source block</dt><dd className="mono break">{c.sourceBlock.number} {c.sourceBlock.hash}</dd></>}
            </dl>
        </>
    );
}

function Vault({ m }: { m: MarketJson }) {
    const t = m.terms;
    return (
        <Panel title="Vault and terms">
            <dl className="kv">
                <dt>Phase</dt><dd>{m.vault.phase}{m.vault.outcome ? `: ${outcomeName(m, m.vault.outcome)}` : ""}</dd>
                <dt>Collateral</dt><dd>{m.vault.valueSats ? sats(m.vault.valueSats) : "—"}</dd>
                <dt>Vault coin</dt><dd className="mono break">{m.vault.outpoint ?? "—"}</dd>
                <dt>Coin expiry</dt><dd>{m.vault.expiresAt ? when(m.vault.expiresAt) : "—"}</dd>
                <dt>Open interest</dt><dd>{n(m.stats.openInterestSets)} sets, volume {sats(m.stats.volumeSats)} in {m.stats.trades} trades</dd>
                {t && (
                    <>
                        <dt>Unit</dt><dd>{sats(t.unitSats)} per complete set (1 {m.outcomes[0]} + 1 {m.outcomes[1]})</dd>
                        <dt>Cap</dt><dd>{sats(t.capSats)} in the vault</dd>
                        <dt>Timeout</dt><dd>{t.timeoutAtUnix === "0" ? "None" : `${when(fromUnix(t.timeoutAtUnix))}: unresolved markets then split 50/50 per set`}</dd>
                        <dt>Exit delay</dt><dd>{t.exitDelaySeconds} s</dd>
                        <dt>Binding</dt><dd className="mono break">{t.binding}</dd>
                        <dt>Asset ids</dt>
                        <dd className="mono break">{`CTRL ${t.assets.ctrl}\n${m.outcomes[0]} ${t.assets.yes}\n${m.outcomes[1]} ${t.assets.no}`}</dd>
                    </>
                )}
            </dl>
        </Panel>
    );
}

function Source({ s }: { s: SourceJson }) {
    const href = safeHref(s.url);
    return (
        <Panel title="Source">
            <dl className="kv">
                <dt>Provider</dt><dd>Polymarket {href ? <a href={href} target="_blank" rel="noopener noreferrer">{s.slug}</a> : s.slug}</dd>
                <dt>Source status</dt><dd>{s.sourceStatus ?? "—"}</dd>
                <dt>Resolution source</dt><dd className="prose">{s.resolutionSource || "—"}</dd>
                <dt>Protocol</dt><dd>{s.protocol}</dd>
                <dt>Condition id</dt><dd className="mono break">{s.conditionId}</dd>
                <dt>Question id</dt><dd className="mono break">{s.questionId}</dd>
                <dt>Resolver</dt><dd className="mono break">{s.resolver ?? "—"}</dd>
            </dl>
            {s.referencePrices && s.referencePrices.length > 0 && (
                <>
                    <h3>Polymarket reference (not executable here)</h3>
                    <table className="data compact">
                        <thead><tr><th scope="col">Outcome</th><th scope="col" className="num">Reference</th><th scope="col">As of</th></tr></thead>
                        <tbody>{s.referencePrices.map((r) => <tr key={r.outcome}><td>{r.outcome}</td><td className="num">{refPct(r.price)}</td><td>{when(r.asOf)}</td></tr>)}</tbody>
                    </table>
                </>
            )}
            {s.clarifications.length > 0 && (
                <>
                    <h3>Clarifications</h3>
                    <ul className="plain">{s.clarifications.map((c, i) => <li key={i}><span className="muted">{when(c.observedAt)}</span> <span className="prose">{c.note}</span></li>)}</ul>
                </>
            )}
        </Panel>
    );
}
