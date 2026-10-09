import { useCallback, useEffect, useState } from "react";
import type { MarketJson } from "../../shared/api.js";
import { SECTIONS, type Section } from "../../shared/sections.js";
import { api, enc, useLive } from "../api.js";
import { useApp } from "../ctx.js";
import { chanceOf, isTest, n, providerName, refPct, safeHref, sectionFor, unavailableReason } from "../format.js";
import { ErrorBox, Link, Logo, PixBar, StatusBadge, Time, navigate, useNow, useSearch } from "../ui.js";

type Page = { markets: MarketJson[]; next: string | null };
const DAY = 86_400_000;
const VIEWS = [["", "Open"], ["results", "Results"], ["all", "All"]] as const;
const QUICK = [["live", "Live now"], ["soon", "Closing soon"], ["new", "New"]] as const;
type Quick = (typeof QUICK)[number][0];

const liveWindow = (m: MarketJson, now: number) => {
    const p = m.terms?.price;
    return m.status === "open" && p?.kind === "updown" && Number(p.startAtMs) <= now && now < Number(p.endAtMs);
};
const QUICK_TEST: Record<Quick, (m: MarketJson, now: number) => boolean> = {
    live: liveWindow,
    soon: (m, now) => m.status === "open" && Date.parse(m.closeAt) - now < DAY,
    new: (m, now) => now - Date.parse(m.createdAt) < DAY,
};
const inView = (v: string, m: MarketJson) =>
    v === "all" || (v === "results" ? m.status !== "open" && m.status !== "activating" : m.status === "open" && !isTest(m));

export function Markets() {
    const { config } = useApp();
    const query = new URLSearchParams(useSearch());
    const view = query.get("v") ?? "";
    const quick = QUICK.find(([k]) => k === query.get("f"))?.[0] ?? null;
    const section = SECTIONS.find((s) => s === query.get("s")) ?? null;
    const [q, setQ] = useState("");
    const [all, setAll] = useState<MarketJson[] | null>(null);
    const [error, setError] = useState<unknown>(null);
    const now = useNow(30_000);

    const setParam = (k: string, v: string | null) => {
        const p = new URLSearchParams(query);
        if (v) p.set(k, v);
        else p.delete(k);
        const qs = p.toString();
        navigate(`${location.pathname}${qs ? `?${qs}` : ""}`, false);
    };

    // Sections, counts and quick filters need the whole board, so page through it once and filter here.
    // ponytail: client-side paging caps at 2,000 markets; add a server section filter if the board outgrows it.
    const load = useCallback(async () => {
        setError(null);
        try {
            const out: MarketJson[] = [];
            let cursor: string | null = null;
            for (let i = 0; i < 10; i++) {
                const r: Page = await api<Page>(`/api/markets?limit=200${cursor ? `&cursor=${enc(cursor)}` : ""}`);
                out.push(...r.markets);
                if (!(cursor = r.next)) break;
            }
            setAll(out);
        } catch (e) {
            setError(e);
        }
    }, []);
    useEffect(() => void load(), [load]);

    useLive((change) => {
        if (change === "all") return void load();
        for (const id of change) {
            api<MarketJson>(`/api/markets/${enc(id)}`).then((m) => setAll((prev) => {
                if (!prev) return prev;
                if (prev.some((x) => x.id === m.id)) return prev.map((x) => (x.id === m.id ? m : x));
                return m.status === "hidden" ? prev : [m, ...prev];
            }), () => undefined);
        }
    });

    const needle = q.trim().toLowerCase();
    const base = (all ?? []).filter((m) => inView(view, m) && (!needle
        || [m.question, m.category, m.source?.event?.title, sectionFor(m)].some((t) => t?.toLowerCase().includes(needle))));
    const quickOk = (m: MarketJson) => !quick || QUICK_TEST[quick](m, now);
    const sectionCounts = new Map<Section, number>();
    for (const m of base) if (quickOk(m)) sectionCounts.set(sectionFor(m), (sectionCounts.get(sectionFor(m)) ?? 0) + 1);
    const inSection = base.filter((m) => !section || sectionFor(m) === section);
    const shown = inSection.filter(quickOk).sort((a, b) => (Date.parse(a.closeAt) - Date.parse(b.closeAt)) * (view === "results" ? -1 : 1));
    const groups = section ? [[section, shown] as const]
        : SECTIONS.map((s) => [s, shown.filter((m) => sectionFor(m) === s)] as const).filter(([, ms]) => ms.length);

    const tradeable = (all ?? []).filter((m) => inView("", m));
    const sum = (f: (m: MarketJson) => string) => tradeable.reduce((a, m) => a + BigInt(f(m)), 0n);
    const filtered = !!(needle || quick || section || view);
    return (
        <div className="stack">
            <section className="hero">
                <div>
                    <div className="eyebrow">Bitcoin-settled prediction markets · {config.network}</div>
                    <h1>Call it. <em>Settle in sats.</em></h1>
                    <p>Every share is backed by BTC locked in an Arkade covenant. A winning share pays {n(config.unitSats)} sats; the price is the crowd's odds.</p>
                    <div className="stats">
                        <div className="stat"><b>{tradeable.length}</b><span>Live markets</span></div>
                        <div className="stat"><b>{n(sum((m) => m.stats.volumeSats))}</b><span>Volume (sats)</span></div>
                        <div className="stat"><b>{n(sum((m) => m.stats.collateralSats))}</b><span>Collateral (sats)</span></div>
                    </div>
                </div>
                <Logo className="art" color="var(--orange-hi)" />
            </section>
            <nav className="rail" aria-label="Sections">
                <div className="rail-row">
                    {[null, ...SECTIONS].filter((s) => !s || s === section || sectionCounts.has(s)).map((s) => (
                        <button key={s ?? "all"} type="button" className="tab" aria-pressed={section === s} onClick={() => setParam("s", s)}>
                            {s ?? "All"} <span className="count">{s ? sectionCounts.get(s) ?? 0 : [...sectionCounts.values()].reduce((a, b) => a + b, 0)}</span>
                        </button>
                    ))}
                </div>
            </nav>
            <form className="toolbar" role="search" onSubmit={(e) => e.preventDefault()}>
                <div className="pills" role="group" aria-label="Quick filters">
                    {QUICK.map(([k, l]) => (
                        <button key={k} type="button" className={`pill quick q-${k}`} aria-pressed={quick === k} onClick={() => setParam("f", quick === k ? null : k)}>
                            {l} <span className="count">{inSection.filter((m) => QUICK_TEST[k](m, now)).length}</span>
                        </button>
                    ))}
                </div>
                <label className="search">
                    <span className="sr-only">Search</span>
                    <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search questions, teams, coins" />
                </label>
                <div className="pills" role="group" aria-label="Market status">
                    {VIEWS.map(([v, l]) => (
                        <button key={v} type="button" className="pill" aria-pressed={view === v} onClick={() => setParam("v", v || null)}>{l}</button>
                    ))}
                </div>
            </form>
            {error ? <ErrorBox error={error} onRetry={() => void load()} /> : null}
            {!all ? (error ? null : <div className="grid">{[0, 1, 2, 3, 4, 5].map((k) => <div key={k} className="skeleton" />)}</div>) : shown.length === 0 ? (
                <p className="state">
                    {filtered ? "No markets match these filters. " : "No markets yet. "}
                    {filtered && <button type="button" className="linklike" onClick={() => { setQ(""); navigate(location.pathname, false); }}>Clear filters</button>}
                    {" "}<Link to="/create">Create one</Link>
                </p>
            ) : (
                groups.map(([s, ms]) => (
                    <section key={s} className="sect" aria-labelledby={`sect-${s}`}>
                        {!section && (
                            <header className="sect-head">
                                <h2 id={`sect-${s}`}>{s} <span className="count">{ms.length}</span></h2>
                                <button type="button" className="linklike" onClick={() => setParam("s", s)}>View {s}</button>
                            </header>
                        )}
                        {section && <h2 id={`sect-${s}`} className="sr-only">{s}</h2>}
                        <div className="grid">{ms.map((m, i) => <Card key={m.id} m={m} now={now} i={i} />)}</div>
                    </section>
                ))
            )}
        </div>
    );
}

function Card({ m, now, i }: { m: MarketJson; now: number; i: number }) {
    const reason = unavailableReason(m);
    const chance = chanceOf(m);
    const href = `/markets/${enc(m.id)}`;
    const img = safeHref(m.source?.image)?.startsWith("https://") ? m.source!.image! : undefined;
    const live = liveWindow(m, now);
    const closeIn = Date.parse(m.closeAt) - now;
    const provider = providerName(m);
    return (
        <article className="card" style={{ ["--i" as string]: Math.min(i, 12) }}>
            <div className="card-meta">
                <span className="sect-chip">{sectionFor(m)}</span>
                <span className={`src p-${m.source?.provider ?? "custom"}`}>{provider ?? "Custom"}</span>
                {live ? <span className="live-tag">Live</span> : m.status !== "open" && <StatusBadge m={m} />}
                <span className={`cd${m.status === "open" && closeIn > 0 && closeIn < 3_600_000 ? " soon" : ""}`}>
                    {closeIn > 0 ? <>{live ? "Ends" : "Closes"} <Time t={m.closeAt} now={now} /></> : <>Closed <Time t={m.closeAt} now={now} /></>}
                </span>
            </div>
            <div className="card-top">
                {img && <img className="thumb" src={img} alt="" loading="lazy" referrerPolicy="no-referrer" />}
                <div className="qwrap">
                    {m.source?.event && m.source.event.title !== m.question && <div className="event">{m.source.event.title}</div>}
                    <Link to={href} className="q">{m.question}</Link>
                </div>
            </div>
            {(isTest(m) || m.oracle.policy === "dev-oracle") && (
                <div className="tags">
                    {m.category && isTest(m) && <span className="badge dev">{m.category}</span>}
                    {m.oracle.policy === "dev-oracle" && <span className="badge dev">dev oracle</span>}
                </div>
            )}
            {reason && <div className="reason">{reason}</div>}
            <div className="odds">
                {([0, 1] as const).map((k) => <Odd key={k} m={m} k={k} href={href} />)}
            </div>
            <PixBar p={chance?.p ?? null} />
            <div className="foot-line">
                <span>{n(m.stats.volumeSats)} sats vol · {m.stats.trades} trades</span>
                {chance?.from === "reference" && <span title={`${provider ?? "Source"} price, not executable here`}>{provider ?? "Source"} odds</span>}
            </div>
        </article>
    );
}

function Odd({ m, k, href }: { m: MarketJson; k: 0 | 1; href: string }) {
    const o = k === 0 ? "yes" : "no";
    const label = m.outcomes[k];
    const ask = m.book[o].ask;
    const unit = Number(m.terms?.unitSats ?? 0);
    const refs = m.source?.referencePrices;
    const ref = refs?.find((r) => r.outcome === label)?.price ?? (refs?.[0] && k === 1 ? String(1 - Number(refs[0].price)) : refs?.[0]?.price);
    const odds = ask && unit > 0 ? `${Math.round((Number(ask) / unit) * 100)}%` : ref ? `${Math.round(Number(ref) * 100)}%` : "—";
    const sub = ask ? `${n(ask)} sats` : ref ? "ref · no asks" : "no asks";
    const desc = ask ? `${label}: best ask ${n(ask)} sats, ${odds} implied` : `${label}: no asks${ref ? `, source odds ${refPct(ref)}` : ""}`;
    return (
        <Link to={m.status === "open" ? `${href}?o=${o}` : href} className={`odd ${k === 0 ? "a" : "b"}${ask ? "" : " dry"}`} label={desc}>
            <span className="lbl">{label}</span>
            <span className="price">{odds}</span>
            <span className="sub">{sub}</span>
        </Link>
    );
}
