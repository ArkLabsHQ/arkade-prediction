import { useRef, useState } from "react";
import { ApiError, api, enc, useLive } from "../api.js";
import { count, sats } from "../format.js";
import { ActionStatus, ErrorBox, Link, Loading, Panel, useAction, useAsync } from "../ui.js";

/** Admin routes exist only on the server's admin port, which is protected at the edge rather than by a token. */
export function Operator() {
    const overview = useAsync(() => api<OverviewJson>("/api/admin/overview"), []);
    // The overview reads wallets and remote health, so live events refresh it at most every 30 s.
    const lastLive = useRef(0);
    useLive(() => {
        if (overview.loading || Date.now() - lastLive.current < 30_000) return;
        lastLive.current = Date.now();
        overview.reload();
    });
    const act = useAction();
    const importAct = useAction();
    const [marketId, setMarketId] = useState("");
    const [sets, setSets] = useState("10");
    const [yesAsk, setYesAsk] = useState("");
    const [noAsk, setNoAsk] = useState("");
    const id = marketId.trim();
    const post = (path: string, body?: unknown, a = act) => a.run(async (step) => {
        step(`POST ${path}`);
        const r = await api<unknown>(path, { method: "POST", body });
        overview.reload();
        return <pre className="json">{JSON.stringify(r, null, 2)}</pre>;
    });
    const elsewhere = overview.error instanceof ApiError && overview.error.status === 404;
    const liquidityOk = !!id && !!count(sets) && !!count(yesAsk) && !!count(noAsk);
    return (
        <div className="stack">
            <div className="page-head">
                <h1>Operator</h1>
            </div>
            <div className="cols">
                <Panel title="Overview" actions={<button type="button" className="btn small" onClick={overview.reload}>Refresh</button>}>
                    {overview.data ? <Dashboard o={overview.data} />
                        : elsewhere ? <p className="muted" role="status">The operator console is served on the admin port, not this one.</p>
                        : overview.error ? <ErrorBox error={overview.error} onRetry={overview.reload} /> : <Loading what="overview" />}
                </Panel>
                <div className="stack side">
                    <Panel title="Import">
                        <button type="button" className="btn" disabled={importAct.busy} onClick={() => void post("/api/admin/import/run", undefined, importAct)}>Run one discovery pass</button>
                        <ActionStatus s={importAct} />
                    </Panel>
                    <Panel title="Market actions">
                        <label className="field">
                            <span>Market id</span>
                            <input className="mono" autoComplete="off" spellCheck={false} value={marketId} onChange={(e) => setMarketId(e.target.value)} />
                        </label>
                        <div className="row2">
                            <button type="button" className="btn" disabled={!id || act.busy} onClick={() => void post(`/api/admin/markets/${enc(id)}/activate`)}>Activate</button>
                            <button
                                type="button"
                                className="btn danger"
                                disabled={!id || act.busy}
                                onClick={() => { if (window.confirm(`Hide market ${id} from public listings?`)) void post(`/api/admin/markets/${enc(id)}/hide`); }}
                            >
                                Hide
                            </button>
                        </div>
                        <fieldset className="choices">
                            <legend>Seed liquidity (LP mints sets and posts asks)</legend>
                            <div className="row2">
                                <label className="field"><span>Sets</span><input inputMode="numeric" value={sets} onChange={(e) => setSets(e.target.value)} /></label>
                                <span />
                            </div>
                            <div className="row2">
                                <label className="field"><span>Outcome A ask (sats)</span><input inputMode="numeric" value={yesAsk} onChange={(e) => setYesAsk(e.target.value)} /></label>
                                <label className="field"><span>Outcome B ask (sats)</span><input inputMode="numeric" value={noAsk} onChange={(e) => setNoAsk(e.target.value)} /></label>
                            </div>
                            <button type="button" className="btn" disabled={!liquidityOk || act.busy}
                                onClick={() => void post(`/api/admin/markets/${enc(id)}/liquidity`, { sets: sets.trim(), yesAsk: yesAsk.trim(), noAsk: noAsk.trim() })}>
                                Seed liquidity
                            </button>
                        </fieldset>
                        <ActionStatus s={act} />
                    </Panel>
                </div>
            </div>
        </div>
    );
}

type Check = { ok: boolean; detail?: string };
type Failed = { error: string };
type Wf = { id: string; kind: string; marketId: string | null; state: string; attempts: number; error: string | null; txid: string | null };
interface OverviewJson {
    process: { rssBytes: number; uptimeSeconds: number };
    health: Record<string, Check> | Failed;
    importLag: { lastRun: string | null; lastError: string | null };
    oracleLag: { id: string; question: string; close_at: number }[];
    workflows: { failed: Wf[]; inFlight: Wf[]; pending: Wf[]; done?: Wf[] };
    liquidity: { market_id: string; outcome: string; side: string; offers: number; units: number }[];
    expiries: { id: string; vault_expires_at: string }[];
    wallets: Record<"operator" | "lp", { address: string; available: number } | Failed | null>;
}

const failed = (v: unknown): v is Failed => !!v && typeof v === "object" && "error" in v;
function ago(iso: string | null): string {
    if (!iso) return "never";
    const min = Math.round((Date.now() - Date.parse(iso)) / 60_000);
    return min < 90 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} d ago`;
}

function Dashboard({ o }: { o: OverviewJson }) {
    const wf = o.workflows;
    const books = new Set(o.liquidity.map((l) => l.market_id)).size;
    return (
        <div className="stack">
            <div className="pills">
                {failed(o.health) ? <span className="pill bad">health: {o.health.error}</span>
                    : Object.entries(o.health).map(([k, c]) => <span key={k} className={`pill ${c.ok ? "good" : "bad"}`} title={c.detail}>{k}</span>)}
            </div>
            <div className="kpis">
                {(["operator", "lp"] as const).map((k) => {
                    const w = o.wallets[k];
                    return (
                        <div key={k} className="kpi">
                            <span className="kpi-label">{k === "lp" ? "LP wallet" : "Operator wallet"}</span>
                            {!w ? <span className="muted">not configured</span>
                                : failed(w) ? <span className="error-text small">{w.error}</span>
                                : <><strong className="num">{sats(BigInt(w.available))}</strong><span className="mono small break muted">{w.address}</span></>}
                        </div>
                    );
                })}
                <div className="kpi"><span className="kpi-label">Markets with LP books</span><strong className="num">{books}</strong></div>
                <div className="kpi"><span className="kpi-label">Last import</span><strong>{ago(o.importLag.lastRun)}</strong>{o.importLag.lastError && <span className="error-text small">{o.importLag.lastError}</span>}</div>
                <div className="kpi"><span className="kpi-label">Process</span><strong className="num">{Math.round(o.process.rssBytes / 2 ** 20)} MB</strong><span className="muted small">up {Math.round(o.process.uptimeSeconds / 3600)} h</span></div>
            </div>
            <WorkflowTable title={`Failed workflows (${wf.failed.length})`} rows={wf.failed} />
            <WorkflowTable title={`Submitting (${wf.inFlight.length})`} rows={wf.inFlight} />
            <WorkflowTable title={`Pending (${wf.pending.length})`} rows={wf.pending} />
            <WorkflowTable title="Recently done" rows={wf.done ?? []} />
            <section>
                <h3>Awaiting resolution ({o.oracleLag.length})</h3>
                {o.oracleLag.length === 0 ? <p className="muted">None.</p> : (
                    <ul className="plain">{o.oracleLag.map((m) => <li key={m.id}><Link to={`/markets/${m.id}`}>{m.question}</Link> <span className="muted small">closed {ago(new Date(m.close_at * 1000).toISOString())}</span></li>)}</ul>
                )}
            </section>
            <details>
                <summary>Raw overview JSON</summary>
                <pre className="json">{JSON.stringify(o, null, 2)}</pre>
            </details>
        </div>
    );
}

function WorkflowTable({ title, rows }: { title: string; rows: Wf[] }) {
    if (rows.length === 0) return null;
    return (
        <section>
            <h3>{title}</h3>
            <div className="table-wrap">
                <table className="data compact">
                    <thead><tr><th scope="col">Kind</th><th scope="col">Market</th><th scope="col">Tries</th><th scope="col">Last error / tx</th></tr></thead>
                    <tbody>{rows.map((w) => (
                        <tr key={w.id}>
                            <td className="mono small">{w.kind}</td>
                            <td>{w.marketId ? <Link to={`/markets/${w.marketId}`} className="mono small">{w.marketId.slice(0, 8)}</Link> : "—"}</td>
                            <td className="num">{w.attempts}</td>
                            <td className="small break">{w.error ?? (w.txid ? <span className="mono">{w.txid.slice(0, 16)}…</span> : "")}</td>
                        </tr>
                    ))}</tbody>
                </table>
            </div>
        </section>
    );
}
