import { useCallback, useEffect, useState, useSyncExternalStore, type DependencyList, type ReactNode } from "react";
import type { MarketJson } from "../shared/api.js";
import { ApiError } from "./api.js";
import { useApp } from "./ctx.js";
import { errMsg, rel, safeHref, short, when } from "./format.js";
import { isOpenKeystore } from "./keystore.js";

// --- routing ----------------------------------------------------------------------------------

const navListeners = new Set<() => void>();
const notify = () => navListeners.forEach((l) => l());
window.addEventListener("popstate", notify);

export function navigate(to: string) {
    if (to !== location.pathname + location.search) history.pushState(null, "", to);
    notify();
    window.scrollTo(0, 0);
}

export function usePath(): string {
    return useSyncExternalStore(
        (cb) => {
            navListeners.add(cb);
            return () => {
                navListeners.delete(cb);
            };
        },
        () => location.pathname,
    );
}

export function Link(props: { to: string; className?: string; children: ReactNode; current?: boolean }) {
    return (
        <a
            href={props.to}
            className={props.className}
            aria-current={props.current ? "page" : undefined}
            onClick={(e) => {
                if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                e.preventDefault();
                navigate(props.to);
            }}
        >
            {props.children}
        </a>
    );
}

// --- hooks ------------------------------------------------------------------------------------

export interface Async<T> {
    data?: T;
    error?: unknown;
    loading: boolean;
    reload(): void;
}

/** Keeps the last good data across reloads so live refreshes never blank the screen. */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): Async<T> {
    const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
    const [tick, setTick] = useState(0);
    useEffect(() => {
        let live = true;
        setState((s) => ({ ...s, loading: true }));
        fn().then(
            (data) => live && setState({ data, loading: false }),
            (error: unknown) => live && setState((s) => ({ data: s.data, error, loading: false })),
        );
        return () => {
            live = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [...deps, tick]);
    const reload = useCallback(() => setTick((t) => t + 1), []);
    return { ...state, reload };
}

export function useNow(intervalMs: number): number {
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        const t = setInterval(() => setNow(Date.now()), intervalMs);
        return () => clearInterval(t);
    }, [intervalMs]);
    return now;
}

export interface ActionState {
    busy: boolean;
    step?: string;
    error?: string;
    done?: ReactNode;
}

export function useAction() {
    const [state, setState] = useState<ActionState>({ busy: false });
    const run = useCallback(async (fn: (step: (s: string) => void) => Promise<ReactNode>) => {
        setState({ busy: true, step: "Working" });
        try {
            const done = await fn((step) => setState({ busy: true, step }));
            setState({ busy: false, done });
        } catch (e) {
            setState({ busy: false, error: errMsg(e) });
        }
    }, []);
    return { ...state, run };
}

// --- components -------------------------------------------------------------------------------

export function ActionStatus({ s }: { s: ActionState }) {
    return (
        <div className="action-status" aria-live="polite">
            {s.busy && <p className="state busy">{s.step}…</p>}
            {s.error && <p className="error" role="alert">{s.error}</p>}
            {s.done && <div className="ok">{s.done}</div>}
        </div>
    );
}

export function Panel(props: { title: ReactNode; children: ReactNode; actions?: ReactNode; className?: string }) {
    return (
        <section className={`panel ${props.className ?? ""}`}>
            <header>
                <h2>{props.title}</h2>
                {props.actions}
            </header>
            <div className="panel-body">{props.children}</div>
        </section>
    );
}

export const Loading = ({ what }: { what: string }) => <p className="state busy" role="status">Loading {what}…</p>;

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
    const down = error instanceof ApiError && error.status === 0;
    return (
        <div className="error" role="alert">
            <p>{down ? "Server unavailable. The API did not answer; it may be restarting." : errMsg(error)}</p>
            {onRetry && <button type="button" className="btn" onClick={onRetry}>Retry</button>}
        </div>
    );
}

export function Time({ t, now }: { t: string | Date; now?: number }) {
    const d = typeof t === "string" ? new Date(t) : t;
    return <time dateTime={d.toISOString()} title={when(d)}>{rel(d, now)}</time>;
}

export function Txid({ txid }: { txid: string }) {
    const { config } = useApp();
    const href = config.explorerUrl ? safeHref(`${config.explorerUrl.replace(/\/$/, "")}/tx/${txid}`) : undefined;
    const text = <span className="mono" title={txid}>{short(txid)}</span>;
    return href ? <a href={href} target="_blank" rel="noopener noreferrer">{text}</a> : text;
}

export function Copy({ text, label = "Copy" }: { text: string; label?: string }) {
    const [done, setDone] = useState(false);
    return (
        <button
            type="button"
            className="btn small"
            onClick={() => void navigator.clipboard.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); })}
        >
            {done ? "Copied" : label}
        </button>
    );
}

export function StatusBadge({ m }: { m: MarketJson }) {
    const label = m.status === "resolved" && m.vault.outcome ? `resolved: ${outcomeName(m, m.vault.outcome)}` : m.status;
    return <span className={`badge s-${m.status}`}>{label}</span>;
}

export const outcomeName = (m: MarketJson, o: "yes" | "no" | "invalid") => (o === "invalid" ? "invalid (50/50)" : m.outcomes[o === "yes" ? 0 : 1]);

export function LockedNotice({ what }: { what: string }) {
    const { chain, chainError } = useApp();
    if (!chain) return <p className="state">{chainError ? "The Arkade service is unreachable, so" : "Connecting to Arkade;"} you cannot {what} yet.</p>;
    if (isOpenKeystore()) return <p className="state">Opening your wallet…</p>;
    return <p className="state">Unlock your wallet to {what}. <Link to="/wallet">Open wallet</Link></p>;
}

/** Arkade's pixel "A" from the brand kit, on its native 4x4 grid. */
export function Logo({ className = "logo", color = "var(--orange)" }: { className?: string; color?: string }) {
    const cells = [[1, 0], [2, 0], [0, 1], [3, 1], [1, 2], [2, 2], [0, 3], [3, 3]];
    return (
        <svg className={className} viewBox="0 0 4 4" aria-hidden="true" shapeRendering="crispEdges">
            <path d="M1 0V1H0Z" fill={color} />
            <path d="M3 0L4 1H3Z" fill={color} />
            {cells.map(([x, y]) => <rect key={`${x}${y}`} x={x} y={y} width="1" height="1" fill={color} />)}
        </svg>
    );
}

/** 20-cell bar: outcome A cells first, outcome B the rest; empty when there is no price. */
export function PixBar({ p }: { p: number | null }) {
    const on = p === null ? 0 : Math.round(p * 20);
    return (
        <div className={`pixbar${p === null ? " empty" : ""}`} aria-hidden="true">
            {Array.from({ length: 20 }, (_, k) => <i key={k} className={k < on ? "on" : undefined} style={{ ["--k" as string]: k }} />)}
        </div>
    );
}

/** Ring of 20 pixel cells around the chance of outcome A. */
export function Gauge({ p, label }: { p: number | null; label: string }) {
    const on = p === null ? 0 : Math.round(p * 20);
    return (
        <div className="gauge" role="img" aria-label={p === null ? "No price yet" : `${Math.round(p * 100)}% ${label}`}>
            <svg viewBox="-32 -32 64 64" aria-hidden="true">
                {Array.from({ length: 20 }, (_, k) => {
                    const a = (k / 20) * 2 * Math.PI - Math.PI / 2;
                    return <rect key={k} x={Math.cos(a) * 26 - 3} y={Math.sin(a) * 26 - 3} width="6" height="6"
                        transform={`rotate(${(k / 20) * 360} ${Math.cos(a) * 26} ${Math.sin(a) * 26})`}
                        fill={k < on ? "var(--a)" : "var(--bg-3)"} />;
                })}
            </svg>
            <div><b>{p === null ? "—" : `${Math.round(p * 100)}%`}</b><small>chance</small></div>
        </div>
    );
}
