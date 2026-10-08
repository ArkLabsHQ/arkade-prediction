import { useCallback, useEffect, useState } from "react";
import type { MarketJson, MarketStatus } from "../../shared/api.js";
import { api, enc, useLive } from "../api.js";
import { useApp } from "../ctx.js";
import { chanceOf, isReplay, n, pct, unavailableReason } from "../format.js";
import { ErrorBox, Gauge, Link, Logo, PixBar, StatusBadge, Time, useNow } from "../ui.js";

const STATUSES: MarketStatus[] = ["open", "halted", "activating", "closed", "resolving", "resolved", "failed"];
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

    const shown = page?.markets ?? [];
    const sum = (f: (m: MarketJson) => string) => shown.reduce((a, m) => a + BigInt(f(m)), 0n);
    return (
        <div className="stack">
            <section className="hero">
                <div>
                    <div className="eyebrow">Bitcoin-settled prediction markets · {config.network}</div>
                    <h1>Call it. <em>Settle in sats.</em></h1>
                    <p>Every share is backed by BTC locked in an Arkade covenant. A winning share pays {n(config.unitSats)} sats; the price is the crowd's odds.</p>
                    <div className="stats">
                        <div className="stat"><b>{shown.filter((m) => m.status === "open").length}</b><span>Live markets</span></div>
                        <div className="stat"><b>{n(sum((m) => m.stats.volumeSats))}</b><span>Volume (sats)</span></div>
                        <div className="stat"><b>{n(sum((m) => m.stats.collateralSats))}</b><span>Collateral (sats)</span></div>
                    </div>
                </div>
                <Logo className="art" color="var(--orange-hi)" />
            </section>
            <form className="toolbar" role="search" onSubmit={(e) => e.preventDefault()}>
                <label className="search">
                    <span className="sr-only">Search</span>
                    <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search questions or categories" />
                </label>
                <div className="pills" role="group" aria-label="Kind">
                    {([["", "All"], ["polymarket", "Polymarket"], ["custom", "Custom"]] as const).map(([v, l]) => (
                        <button key={v} type="button" className="pill" aria-pressed={kind === v} onClick={() => setKind(v)}>{l}</button>
                    ))}
                </div>
                <label className="field" style={{ flex: "0 1 170px" }}>
                    <span className="sr-only">Status</span>
                    <select value={status} onChange={(e) => setStatus(e.target.value)}>
                        <option value="">Any status</option>
                        {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                </label>
            </form>
            {error ? <ErrorBox error={error} onRetry={() => void load()} /> : null}
            {!page ? (loading ? <div className="grid">{[0, 1, 2, 3, 4, 5].map((k) => <div key={k} className="skeleton" />)}</div> : null) : page.markets.length === 0 ? (
                <p className="state">{filtered ? "No markets match these filters." : "No markets yet."} <Link to="/create">Create one</Link></p>
            ) : (
                <div className="grid">{page.markets.map((m, i) => <Card key={m.id} m={m} now={now} i={i} />)}</div>
            )}
            {page?.next && (
                <button type="button" className="btn ghost" disabled={loading} onClick={() => void load(page.next!)}>
                    {loading ? "Loading…" : "Load more"}
                </button>
            )}
        </div>
    );
}

function Card({ m, now, i }: { m: MarketJson; now: number; i: number }) {
    const unit = m.terms?.unitSats ?? "0";
    const reason = unavailableReason(m);
    const chance = chanceOf(m);
    const href = `/markets/${enc(m.id)}`;
    return (
        <article className="card" style={{ ["--i" as string]: Math.min(i, 12) }}>
            <div className="card-top">
                <Link to={href} className="q">{m.question}</Link>
                <Gauge p={chance?.p ?? null} label={m.outcomes[0]} />
            </div>
            <div className="tags">
                <StatusBadge m={m} />
                {m.category && <span className={`badge cat${isReplay(m) ? " dev" : ""}`}>{m.category}</span>}
                <span className="badge cat">{m.kind === "polymarket" ? "Polymarket" : "Custom"}</span>
                {m.oracle.policy === "dev-oracle" && <span className="badge dev">dev oracle</span>}
                {chance?.from === "reference" && <span className="badge cat" title="Polymarket's price, not executable here">ref odds</span>}
            </div>
            {reason && <div className="reason">{reason}</div>}
            <PixBar p={chance?.p ?? null} />
            <div className="outs">
                <Out cls="a" label={m.outcomes[0]} ask={m.book.yes.ask} unit={unit} href={href} />
                <Out cls="b" label={m.outcomes[1]} ask={m.book.no.ask} unit={unit} href={href} />
            </div>
            <div className="foot-line">
                <span>{n(m.stats.volumeSats)} sats vol · {m.stats.trades} trades</span>
                <span>Closes <Time t={m.closeAt} now={now} /></span>
            </div>
        </article>
    );
}

function Out({ cls, label, ask, unit, href }: { cls: "a" | "b"; label: string; ask: string | null; unit: string; href: string }) {
    return (
        <Link to={href} className={`out ${cls}`}>
            <span className="lbl">{label}</span>
            <span className="num" title={ask ? `Best ask ${n(ask)} sats (${pct(ask, unit)})` : "No asks"}>{ask ? `${n(ask)} sats` : "—"}</span>
        </Link>
    );
}
