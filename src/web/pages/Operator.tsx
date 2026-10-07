import { Fragment, useState, type ReactNode } from "react";
import { ApiError, api, enc, useLive } from "../api.js";
import { count } from "../format.js";
import { ActionStatus, ErrorBox, Loading, Panel, useAction, useAsync } from "../ui.js";

const TOKEN_KEY = "apm.adminToken";

export function Operator() {
    const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_KEY) ?? "");
    const [typed, setTyped] = useState("");
    if (token) return <Console token={token} onForget={() => { sessionStorage.removeItem(TOKEN_KEY); setToken(""); }} />;
    return (
        <div className="stack narrow">
            <div className="page-head"><h1>Operator</h1></div>
            <Panel title="Admin token">
                <form className="stack" onSubmit={(e) => { e.preventDefault(); sessionStorage.setItem(TOKEN_KEY, typed.trim()); setToken(typed.trim()); }}>
                    <label className="field">
                        <span>Admin token</span>
                        <input type="password" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
                    </label>
                    <p className="muted small">Kept in this tab's session storage only, and sent as a bearer token to /api/admin.</p>
                    <button type="submit" className="btn primary" disabled={!typed.trim()}>Use token</button>
                </form>
            </Panel>
        </div>
    );
}

function Console({ token, onForget }: { token: string; onForget(): void }) {
    const overview = useAsync(() => api<Record<string, unknown>>("/api/admin/overview", { token }), [token]);
    useLive(() => overview.reload());
    const act = useAction();
    const importAct = useAction();
    const [marketId, setMarketId] = useState("");
    const [sets, setSets] = useState("10");
    const [yesAsk, setYesAsk] = useState("");
    const [noAsk, setNoAsk] = useState("");
    const id = marketId.trim();
    const post = (path: string, body?: unknown, a = act) => a.run(async (step) => {
        step(`POST ${path}`);
        const r = await api<unknown>(path, { method: "POST", body, token });
        overview.reload();
        return <pre className="json">{JSON.stringify(r, null, 2)}</pre>;
    });
    const rejected = overview.error instanceof ApiError && overview.error.status === 401;
    const liquidityOk = !!id && !!count(sets) && !!count(yesAsk) && !!count(noAsk);
    return (
        <div className="stack">
            <div className="page-head">
                <h1>Operator</h1>
                <button type="button" className="btn small ghost" onClick={onForget}>Forget token</button>
            </div>
            <div className="cols">
                <Panel title="Overview" actions={<button type="button" className="btn small" onClick={overview.reload}>Refresh</button>}>
                    {overview.data ? <DataView value={overview.data} />
                        : rejected ? <p className="error" role="alert">The server rejected this token. <button type="button" className="btn small" onClick={onForget}>Enter another</button></p>
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

/** Renders arbitrary server JSON as text: tables for row lists, definition lists for objects. */
function DataView({ value, depth = 0 }: { value: unknown; depth?: number }): ReactNode {
    if (value === null || value === undefined) return <span className="muted">—</span>;
    if (typeof value !== "object") return <span className={typeof value === "boolean" ? (value ? "bid" : "ask") : ""}>{String(value)}</span>;
    if (depth > 3) return <code className="mono small break">{JSON.stringify(value)}</code>;
    if (Array.isArray(value)) {
        if (value.length === 0) return <span className="muted">none</span>;
        if (value.every((v) => v !== null && typeof v === "object" && !Array.isArray(v))) {
            const rows = value as Record<string, unknown>[];
            const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].slice(0, 10);
            return (
                <div className="table-wrap">
                    <table className="data compact">
                        <thead><tr>{cols.map((c) => <th key={c} scope="col">{c}</th>)}</tr></thead>
                        <tbody>{rows.slice(0, 200).map((r, i) => <tr key={i}>{cols.map((c) => <td key={c}><DataView value={r[c]} depth={depth + 1} /></td>)}</tr>)}</tbody>
                    </table>
                </div>
            );
        }
        return <ul className="plain">{value.map((v, i) => <li key={i}><DataView value={v} depth={depth + 1} /></li>)}</ul>;
    }
    return (
        <dl className="kv">
            {Object.entries(value as Record<string, unknown>).map(([k, v]) => (
                <Fragment key={k}><dt>{k}</dt><dd><DataView value={v} depth={depth + 1} /></dd></Fragment>
            ))}
        </dl>
    );
}
