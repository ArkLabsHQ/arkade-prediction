import { useCallback, useEffect, useState } from "react";
import type { MarketJson, MarketStatus } from "../../shared/api.js";
import { api, enc, useLive } from "../api.js";
import { useApp } from "../ctx.js";
import { n, pct, refPct, safeHref, unavailableReason, when } from "../format.js";
import { ErrorBox, Link, Loading, StatusBadge, Time, useNow } from "../ui.js";

const STATUSES: MarketStatus[] = ["open", "activating", "closed", "resolving", "resolved", "failed"];
type Page = { markets: MarketJson[]; next: string | null };

export function Markets() {
    const { config } = useApp();
    const [q, setQ] = useState("");
    const [search, setSearch] = useState("");
    const [status, setStatus] = useState("");
    const [kind, setKind] = useState("");
    const [page, setPage] = useState<Page | null>(null);
    const [error, setError] = useState<unknown>(null);
    const [loading, setLoading] = useState(false);
    const now = useNow(30_000);
    useEffect(() => {
        const t = setTimeout(() => setSearch(q.trim()), 300);
        return () => clearTimeout(t);
    }, [q]);

    const filtered = !!(search || status || kind);
    const load = useCallback(async (cursor?: string) => {
        const p = new URLSearchParams({ limit: "50" });
        if (search) p.set("q", search);
        if (status) p.set("status", status);
        if (kind) p.set("kind", kind);
        if (cursor) p.set("cursor", cursor);
        setLoading(true);
        setError(null);
        try {
            const r = await api<Page>(`/api/markets?${p}`);
            setPage((prev) => (cursor && prev ? { markets: [...prev.markets, ...r.markets], next: r.next } : r));
        } catch (e) {
            setError(e);
        } finally {
            setLoading(false);
        }
    }, [search, status, kind]);
    useEffect(() => void load(), [load]);

    useLive((change) => {
        if (change === "all") return void load();
        for (const id of change) {
            api<MarketJson>(`/api/markets/${enc(id)}`).then((m) => setPage((prev) => {
                if (!prev) return prev;
                if (prev.markets.some((x) => x.id === m.id)) return { ...prev, markets: prev.markets.map((x) => (x.id === m.id ? m : x)) };
                return filtered || m.status === "hidden" ? prev : { ...prev, markets: [m, ...prev.markets] };
            }), () => undefined);
        }
    });

    return (
        <div className="stack">
            <div className="page-head">
                <h1>Markets</h1>
                <p className="muted">Prices are sats per share. A winning share pays its market's unit ({n(config.unitSats)} sats here), so price divided by unit is the implied probability.</p>
            </div>
            <form className="filters" role="search" onSubmit={(e) => e.preventDefault()}>
                <label className="field grow">
                    <span>Search</span>
                    <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Question or category" />
                </label>
                <label className="field">
                    <span>Status</span>
                    <select value={status} onChange={(e) => setStatus(e.target.value)}>
                        <option value="">All</option>
                        {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                </label>
                <label className="field">
                    <span>Kind</span>
                    <select value={kind} onChange={(e) => setKind(e.target.value)}>
                        <option value="">All</option>
                        <option value="polymarket">Polymarket mirror</option>
                        <option value="custom">Custom</option>
                    </select>
                </label>
            </form>
            {error ? <ErrorBox error={error} onRetry={() => void load()} /> : null}
            {!page ? (loading ? <Loading what="markets" /> : null) : page.markets.length === 0 ? (
                <p className="state">{filtered ? "No markets match these filters." : "No markets yet."} <Link to="/create">Create one</Link></p>
            ) : (
                <div className="table-wrap">
                    <table className="data markets">
                        <thead>
                            <tr>
                                <th scope="col">Market</th>
                                <th scope="col">Status</th>
                                <th scope="col" className="num">Outcome A bid / ask</th>
                                <th scope="col" className="num">Outcome B bid / ask</th>
                                <th scope="col">Closes</th>
                                <th scope="col" className="num">Volume (sats)</th>
                                <th scope="col" className="num">Collateral (sats)</th>
                            </tr>
                        </thead>
                        <tbody>{page.markets.map((m) => <Row key={m.id} m={m} now={now} />)}</tbody>
                    </table>
                </div>
            )}
            {page?.next && (
                <button type="button" className="btn" disabled={loading} onClick={() => void load(page.next!)}>
                    {loading ? "Loading…" : "Load more"}
                </button>
            )}
        </div>
    );
}

function Row({ m, now }: { m: MarketJson; now: number }) {
    const unit = m.terms?.unitSats ?? "0";
    const reason = unavailableReason(m);
    const source = safeHref(m.source?.url);
    const refs = m.source?.referencePrices;
    return (
        <tr>
            <td data-label="Market" className="mkt">
                <Link to={`/markets/${enc(m.id)}`} className="q">{m.question}</Link>
                <div className="meta">
                    {m.category && <span>{m.category}</span>}
                    {m.kind === "polymarket"
                        ? <span>Source: {source ? <a href={source} target="_blank" rel="noopener noreferrer">Polymarket</a> : "Polymarket"}</span>
                        : <span>Custom</span>}
                    {m.oracle.policy === "dev-oracle" && <span className="badge dev">dev oracle</span>}
                </div>
                {reason && <div className="reason">{reason}</div>}
                {refs && refs.length > 0 && (
                    <div className="ref">Polymarket reference (not executable here): {refs.map((r) => `${r.outcome} ${refPct(r.price)}`).join(" · ")}</div>
                )}
            </td>
            <td data-label="Status"><StatusBadge m={m} /></td>
            <Quote label={m.outcomes[0]} q={m.book.yes} unit={unit} />
            <Quote label={m.outcomes[1]} q={m.book.no} unit={unit} />
            <td data-label="Closes"><Time t={m.closeAt} now={now} /><div className="muted small">{when(m.closeAt)}</div></td>
            <td data-label="Volume (sats)" className="num">{n(m.stats.volumeSats)}<div className="muted small">{m.stats.trades} trades</div></td>
            <td data-label="Collateral (sats)" className="num">{n(m.stats.collateralSats)}<div className="muted small">{n(m.stats.openInterestSets)} sets</div></td>
        </tr>
    );
}

function Quote({ label, q, unit }: { label: string; q: { bid: string | null; ask: string | null }; unit: string }) {
    return (
        <td data-label={label} className="num quote">
            <span className="olabel">{label}</span>
            <span className="bid">{q.bid ? n(q.bid) : "—"}</span>
            <span className="muted"> / </span>
            <span className="ask">{q.ask ? n(q.ask) : "—"}</span>
            <div className="muted small">{q.bid || q.ask ? `${pct(q.bid, unit)} / ${pct(q.ask, unit)}` : "No liquidity"}</div>
        </td>
    );
}
