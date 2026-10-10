import { useCallback, useEffect, useState } from "react";
import { BINARY_VECTORS, redemptionPayout } from "../../core/payout.js";
import type { BoxJson, CoinJson, MarketJson, OfferJson, TradeJson } from "../../shared/api.js";
import { api, enc, useLive } from "../api.js";
import { confirmPending, logged, registerOffer, sleep, withdrawBox, type Holdings, type Session } from "../chain.js";
import { useApp } from "../ctx.js";
import { btc, errMsg, n, pct, sats, short } from "../format.js";
import { PENDING, updateLog, useLog, type LogEntry } from "../txlog.js";
import { ActionStatus, ErrorBox, Link, Loading, LockedNotice, Panel, StatusBadge, Time, Txid, useAction, useAsync } from "../ui.js";
import { verifiedTerms } from "../verify.js";
import { CancelButton } from "./Trade.js";

type Page = { markets: MarketJson[]; next: string | null };
const FAUCET_SATS = 100_000n;

export function Balances() {
    const { config, holdings, holdingsError, refreshHoldings } = useApp();
    const b = holdings?.balance;
    return (
        <Panel title="Balance" actions={<button type="button" className="btn small" onClick={() => void refreshHoldings()}>Refresh</button>}>
            {!b ? (holdingsError ? <p className="error">{holdingsError}</p> : <Loading what="balance" />) : (
                <div className="stack">
                    <p><strong className="num balance">{sats(b.available)}</strong> <span className="muted">{btc(b.available)}</span></p>
                    {b.recoverable > 0 && <p className="muted small">Plus {sats(b.recoverable)} in expired coins this app does not renew.</p>}
                    {holdingsError && <p className="error-text small">Last refresh failed: {holdingsError}</p>}
                </div>
            )}
            {config.devFaucet && <Faucet />}
        </Panel>
    );
}

function Faucet() {
    const { session, refreshHoldings } = useApp();
    const act = useAction();
    if (!session) return null;
    const get = () => act.run(async (step) => {
        step("Requesting test sats");
        const r = await api<{ txid: string }>("/api/dev/faucet", { body: { address: session.address, amountSats: FAUCET_SATS.toString() } })
            .catch((e: unknown) => { throw new Error(`Faucet failed: ${errMsg(e)}`); });
        await sleep(1500);
        await refreshHoldings();
        return <>Sent {sats(FAUCET_SATS)} of test coins. <Txid txid={r.txid} /></>;
    });
    return (
        <div className="row-actions">
            <button type="button" className="btn" disabled={act.busy} onClick={() => void get()}>Get test sats</button>
            <ActionStatus s={act} />
        </div>
    );
}

/** Every listed market by id, patched in place by live events. */
export function useMarketIndex() {
    const [index, setIndex] = useState<Map<string, MarketJson> | null>(null);
    const [error, setError] = useState<unknown>(null);
    const load = useCallback(async () => {
        try {
            const all = new Map<string, MarketJson>();
            let cursor: string | null = null;
            for (let i = 0; i < 20; i++) {
                const page: Page = await api<Page>(`/api/markets?limit=100${cursor ? `&cursor=${enc(cursor)}` : ""}`);
                for (const m of page.markets) all.set(m.id, m);
                cursor = page.next;
                if (!cursor) break;
            }
            setIndex(all);
            setError(null);
        } catch (e) {
            setError(e);
        }
    }, []);
    useEffect(() => void load(), [load]);
    useLive((change) => {
        if (change === "all") return void load();
        for (const id of change) {
            api<MarketJson>(`/api/markets/${enc(id)}`).then((m) => setIndex((prev) => prev && new Map(prev).set(m.id, m)), () => undefined);
        }
    });
    return { index, error, reload: load };
}

export function ClaimsTable({ index, holdings }: { index: Map<string, MarketJson>; holdings: Holdings }) {
    const byAsset = new Map<string, { m: MarketJson; o: "yes" | "no" }>();
    for (const m of index.values()) {
        if (!m.terms) continue;
        byAsset.set(m.terms.assets.yes, { m, o: "yes" });
        byAsset.set(m.terms.assets.no, { m, o: "no" });
    }
    const rows: { m: MarketJson; o: "yes" | "no"; qty: bigint }[] = [];
    const other: [string, bigint][] = [];
    for (const [assetId, qty] of holdings.assets) {
        const hit = byAsset.get(assetId);
        if (hit) rows.push({ ...hit, qty });
        else other.push([assetId, qty]);
    }
    if (rows.length === 0 && other.length === 0) return <p className="state">No bets yet.</p>;
    return (
        <>
            {rows.length > 0 && (
                <div className="table-wrap">
                    <table className="data stacked">
                        <thead>
                            <tr><th scope="col">Market</th><th scope="col">Outcome</th><th scope="col" className="num">Shares</th><th scope="col" className="num">Cash-out price</th><th scope="col" className="num">Value (sats)</th><th scope="col">Status</th></tr>
                        </thead>
                        <tbody>
                            {rows.map(({ m, o, qty }) => {
                                const bid = m.book[o].bid;
                                const unit = m.terms!.unitSats;
                                const won = m.vault.phase === "resolved" && m.vault.outcome
                                    ? redemptionPayout(o === "yes" ? [qty, 0n] : [0n, qty], BINARY_VECTORS[m.vault.outcome], BigInt(unit)) : null;
                                return (
                                    <tr key={`${m.id}:${o}`}>
                                        <td data-label="Market"><Link to={`/markets/${enc(m.id)}`}>{m.question}</Link></td>
                                        <td data-label="Outcome">{m.outcomes[o === "yes" ? 0 : 1]}</td>
                                        <td data-label="Shares" className="num">{n(qty)}</td>
                                        <td data-label="Cash-out price" className="num">{bid ? `${n(bid)} (${pct(bid, unit)})` : "—"}</td>
                                        <td data-label="Value" className="num">{won !== null ? `${n(won)} to collect` : bid ? `${n(qty * BigInt(bid))} if cashed out` : "no buyers"}</td>
                                        <td data-label="Status"><StatusBadge m={m} /></td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            )}
            {other.length > 0 && (
                <p className="muted small">Other tokens, not linked to a listed market: {other.map(([id, q]) => `${n(q)} × ${short(id)}`).join(", ")}</p>
            )}
        </>
    );
}

export function Portfolio() {
    const { session } = useApp();
    return (
        <div className="stack">
            <div className="page-head"><h1>Portfolio</h1></div>
            {session ? <Body session={session} /> : <LockedNotice what="see your portfolio" />}
        </div>
    );
}

const STATUS_TEXT: Record<LogEntry["status"], string> = {
    signing: "not submitted (interrupted while signing)",
    submitting: "submitted, outcome unknown",
    accepted: "accepted, waiting for confirmation",
    confirmed: "confirmed",
    uncertain: "errored after submission, may have landed",
    failed: "failed",
    unregistered: "funded, but the server hasn't listed it yet",
    dismissed: "dismissed",
};

function Body({ session }: { session: Session }) {
    const { chain, holdings, holdingsError } = useApp();
    const { index, error: indexError, reload: reloadIndex } = useMarketIndex();
    const server = useAsync(() => api<{ offers: OfferJson[]; trades: TradeJson[] }>(`/api/portfolio?script=${session.script}`), [session.script]);
    useLive(() => server.reload());
    const log = useLog(session.script);
    const [checking, setChecking] = useState(false);
    const check = useCallback(async () => {
        if (!chain) return;
        setChecking(true);
        try {
            await confirmPending(chain, session.script);
        } finally {
            setChecking(false);
        }
    }, [chain, session.script]);
    useEffect(() => {
        void check();
        const t = setInterval(() => void check(), 20_000);
        return () => clearInterval(t);
    }, [check]);

    const pending = log.filter((e) => PENDING.includes(e.status));
    const payouts = log.filter((e) => e.kind === "redeem" && (e.status === "accepted" || e.status === "confirmed"));
    const paid = payouts.reduce((s, e) => s + BigInt(e.sats ?? "0"), 0n);
    const question = (id: string | null) => (id && index?.get(id)?.question) || id || "—";
    const openOffers = server.data?.offers.filter((o) => o.status === "open") ?? [];

    return (
        <>
            <Balances />
            <Panel title="Your bets">
                {!holdings ? (holdingsError ? <p className="error">{holdingsError}</p> : <Loading what="balances" />)
                    : index ? <ClaimsTable index={index} holdings={holdings} />
                    : indexError ? <ErrorBox error={indexError} onRetry={() => void reloadIndex()} /> : <Loading what="markets" />}
            </Panel>
            <Boxes session={session} index={index} />
            <Panel title="Open orders">
                {server.error && !server.data ? <ErrorBox error={server.error} onRetry={server.reload} /> : !server.data ? <Loading what="orders" />
                    : openOffers.length === 0 ? <p className="state">No open orders.</p> : (
                        <div className="table-wrap">
                            <table className="data stacked">
                                <thead><tr><th scope="col">Market</th><th scope="col">Order</th><th scope="col" className="num">Price</th><th scope="col" className="num">Shares left</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
                                <tbody>
                                    {openOffers.map((o) => {
                                        const m = index?.get(o.marketId);
                                        const label = `${o.terms.side === "buy" ? "Bet on" : "Cash out"} ${m ? m.outcomes[o.outcome === "yes" ? 0 : 1] : o.outcome}`;
                                        return (
                                            <tr key={o.id}>
                                                <td data-label="Market"><Link to={`/markets/${enc(o.marketId)}`}>{question(o.marketId)}</Link></td>
                                                <td data-label="Order">{label}</td>
                                                <td data-label="Price" className="num">{n(o.terms.priceSats)}</td>
                                                <td data-label="Shares left" className="num">{n(o.remaining)}</td>
                                                <td data-label="Status">{o.status}</td>
                                                <td><CancelButton o={o} label={`${label} @ ${o.terms.priceSats}`} onDone={server.reload} /></td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
            </Panel>
            <Panel title="Pending" actions={<button type="button" className="btn small" disabled={checking || !chain} onClick={() => void check()}>{checking ? "Checking…" : "Check now"}</button>}>
                {pending.length === 0 ? <p className="state">Nothing pending: everything you sent from this browser has gone through or failed.</p> : (
                    <ul className="plain pending">
                        {pending.map((e) => <PendingItem key={e.id} e={e} script={session.script} question={question(e.marketId)} />)}
                    </ul>
                )}
            </Panel>
            <Panel title={`Winnings collected: ${n(paid)} sats`}>
                {payouts.length === 0 ? <p className="state">Nothing collected yet.</p> : (
                    <ul className="plain">
                        {payouts.map((e) => <li key={e.id}><Time t={e.at} /> {n(e.sats ?? "0")} sats from {question(e.marketId)} {e.txid && <Txid txid={e.txid} />}</li>)}
                    </ul>
                )}
            </Panel>
            <Panel title="Activity (this browser)">
                <History log={log.filter((e) => e.status !== "dismissed")} question={question} />
            </Panel>
            <Panel title="Your orders that got matched">
                {!server.data ? (server.error ? <ErrorBox error={server.error} onRetry={server.reload} /> : <Loading what="matched orders" />)
                    : server.data.trades.length === 0 ? <p className="state">None of your orders has been matched yet.</p> : (
                        <div className="table-wrap">
                            <table className="data stacked">
                                <thead><tr><th scope="col">Time</th><th scope="col">Market</th><th scope="col">Your order</th><th scope="col" className="num">Shares</th><th scope="col" className="num">Price</th><th scope="col">Tx</th></tr></thead>
                                <tbody>
                                    {server.data.trades.map((t, i) => (
                                        <tr key={`${t.txid}:${i}`}>
                                            <td data-label="Time"><Time t={t.at} /></td>
                                            <td data-label="Market"><Link to={`/markets/${enc(t.marketId)}`}>{question(t.marketId)}</Link></td>
                                            <td data-label="Order">{t.makerSide === "sell" ? "cash-out matched" : "bet matched"} ({index?.get(t.marketId)?.outcomes[t.outcome === "yes" ? 0 : 1] ?? t.outcome})</td>
                                            <td data-label="Shares" className="num">{n(t.qty)}</td>
                                            <td data-label="Price" className="num">{n(t.priceSats)}</td>
                                            <td data-label="Tx"><Txid txid={t.txid} /></td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
            </Panel>
        </>
    );
}

const sharesIn = (c: CoinJson, assetId: string) => c.assets.filter((a) => a.assetId === assetId).reduce((s, a) => s + BigInt(a.amount), 0n);

function Boxes({ session, index }: { session: Session; index: Map<string, MarketJson> | null }) {
    const boxes = useAsync(() => api<{ boxes: BoxJson[] }>(`/api/boxes?ownerScript=${session.script}`).then((r) => r.boxes), [session.script]);
    useLive(() => boxes.reload());
    const rows = (boxes.data ?? []).flatMap((b) => b.coins.map((c) => ({ b, c, m: index?.get(b.marketId) })));
    return (
        <Panel title="Your bets: paid automatically">
            {!boxes.data ? (boxes.error ? <ErrorBox error={boxes.error} onRetry={boxes.reload} /> : <Loading what="automatic payouts" />)
                : rows.length === 0 ? <p className="state">No bets set to pay automatically.</p> : (
                    <div className="table-wrap">
                        <table className="data stacked">
                            <thead><tr><th scope="col">Market</th><th scope="col">Shares</th><th scope="col">Payout</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
                            <tbody>
                                {rows.map(({ b, c, m }) => (
                                    <tr key={`${c.txid}:${c.vout}`}>
                                        <td data-label="Market"><Link to={`/markets/${enc(b.marketId)}`}>{m?.question ?? b.marketId}</Link></td>
                                        <td data-label="Shares">
                                            {m?.terms
                                                ? `${n(sharesIn(c, m.terms.assets.yes))} ${m.outcomes[0]}, ${n(sharesIn(c, m.terms.assets.no))} ${m.outcomes[1]}`
                                                : c.assets.map((a) => `${n(a.amount)} × ${short(a.assetId)}`).join(", ")}
                                        </td>
                                        <td data-label="Payout">{b.status === "claimed" ? "paid out" : "waiting for the result"}</td>
                                        <td>{m && b.status === "watching" && <WithdrawButton session={session} m={m} coin={c} onDone={boxes.reload} />}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
        </Panel>
    );
}

function WithdrawButton({ session, m, coin, onDone }: { session: Session; m: MarketJson; coin: CoinJson; onDone(): void }) {
    const { chain, config, refreshHoldings } = useApp();
    const act = useAction();
    if (!chain) return null;
    const withdraw = () => act.run(async (step) => {
        step("Verifying the market against the Arkade indexer");
        const terms = await verifiedTerms(chain, config, m);
        step("Withdrawing to your wallet");
        const r = await logged(chain, session, { kind: "withdraw", label: `Withdraw from automatic payout: ${m.question.slice(0, 60)}`, marketId: m.id },
            (ctx) => withdrawBox(ctx, session, terms, coin));
        onDone();
        void refreshHoldings();
        return <>Moved to your wallet; you can cash out from the market page. <Txid txid={r.txid} /></>;
    });
    return (
        <>
            <button type="button" className="btn small" disabled={act.busy} onClick={() => void withdraw()}>{act.busy ? "Withdrawing…" : "Withdraw to cash out"}</button>
            <ActionStatus s={act} />
        </>
    );
}

function PendingItem({ e, script, question }: { e: LogEntry; script: string; question: string }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const retry = async () => {
        setBusy(true);
        setError(null);
        try {
            await registerOffer(e.post!);
            updateLog(script, e.id, { status: "accepted", error: undefined });
        } catch (err) {
            setError(errMsg(err));
        } finally {
            setBusy(false);
        }
    };
    return (
        <li>
            <div><strong>{e.label}</strong> <span className="muted">· {question} · <Time t={e.at} /></span></div>
            <div className="small">
                Status: {STATUS_TEXT[e.status]}{e.txid && <> · <Txid txid={e.txid} /></>}{e.error && <span className="muted"> · {e.error}</span>}
            </div>
            <div className="row-actions">
                {e.status === "unregistered" && e.post && <button type="button" className="btn small" disabled={busy} onClick={() => void retry()}>{busy ? "Listing…" : "Retry listing"}</button>}
                <button type="button" className="btn small ghost" onClick={() => updateLog(script, e.id, { status: "dismissed" })}>Dismiss</button>
            </div>
            {error && <p className="error small" role="alert">{error}</p>}
        </li>
    );
}

function History({ log, question }: { log: LogEntry[]; question: (id: string | null) => string }) {
    if (log.length === 0) return <p className="state">No actions from this browser yet.</p>;
    return (
        <div className="table-wrap">
            <table className="data stacked">
                <thead><tr><th scope="col">Time</th><th scope="col">Action</th><th scope="col">Market</th><th scope="col" className="num">Shares</th><th scope="col" className="num">Sats</th><th scope="col">Status</th><th scope="col">Tx</th></tr></thead>
                <tbody>
                    {log.map((e) => (
                        <tr key={e.id}>
                            <td data-label="Time"><Time t={e.at} /></td>
                            <td data-label="Action">{e.label}</td>
                            <td data-label="Market">{e.marketId ? <Link to={`/markets/${enc(e.marketId)}`}>{question(e.marketId)}</Link> : "—"}</td>
                            <td data-label="Shares" className="num">{e.qty ? n(e.qty) : "—"}</td>
                            <td data-label="Sats" className="num">{e.sats ? n(e.sats) : "—"}</td>
                            <td data-label="Status">{STATUS_TEXT[e.status]}</td>
                            <td data-label="Tx">{e.txid ? <Txid txid={e.txid} /> : "—"}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
