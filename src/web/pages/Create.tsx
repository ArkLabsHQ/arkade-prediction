import { hex } from "@scure/base";
import { useState } from "react";
import { CARRIER_SATS } from "../../core/actions.js";
import { MAX_TIMEOUT_AFTER_CLOSE_SECONDS } from "../../shared/api.js";
import { enc } from "../api.js";
import { MAX_SETS, VAULT_BASE_SATS, clearDraft, loadDraft, runCreate, saveDraft, type Chain, type CreateDraft, type Session } from "../chain.js";
import { useApp } from "../ctx.js";
import { fromUnix, n, sats, when } from "../format.js";
import { isAttestorKey } from "../keystore.js";
import { ActionStatus, Copy, LockedNotice, Panel, Txid, navigate, useAction } from "../ui.js";

// The server only checks these at registration, after the vault is funded, so they are enforced here first.
const MAX_QUESTION = 300;
const MAX_RULES = 10_000;
const MAX_LABEL = 40;
const MIN_LEAD_SECONDS = 300;
// ponytail: mirrors the server default IMPORT_MAX_HORIZON_SECONDS; expose it in ConfigJson if deployments change it.
const MAX_HORIZON_SECONDS = 30 * 86400;
const DEFAULT_TIMEOUT_DAYS = 30;
const CATEGORIES = ["Crypto", "Politics", "Sports", "Economics", "Science", "Culture"];

const pad = (x: number) => String(x).padStart(2, "0");
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const unixOf = (local: string) => Math.floor(new Date(local).getTime() / 1000);

export function CreatePage() {
    const { session, chain } = useApp();
    return (
        <div className="stack narrow">
            <div className="page-head">
                <h1>Create a market</h1>
                <p className="muted">A custom two-outcome market collateralised in BTC on Arkade. You lock its bitcoin and keep one share of each outcome.</p>
            </div>
            {session && chain ? <Creator key={session.script} session={session} chain={chain} /> : <LockedNotice what="create a market" />}
        </div>
    );
}

function Creator({ session, chain }: { session: Session; chain: Chain }) {
    const { refreshHoldings } = useApp();
    const [draft, setDraft] = useState(() => loadDraft(session.script));
    const act = useAction();
    const create = (d: CreateDraft) => act.run(async (step) => {
        const m = await runCreate(chain, session, d, step);
        void refreshHoldings();
        navigate(`/markets/${enc(m.id)}`);
        return "Market created.";
    });
    if (!draft) return <Form session={session} onStart={(d) => { saveDraft(session.script, d); setDraft(d); void create(d); }} />;
    const stage = draft.vaultTxid ? "registering it with the server" : draft.genesisTxid ? "funding the vault" : "issuing its assets";
    const late = Number(draft.definition.closeAtUnix) - Date.now() / 1000 < 60;
    return (
        <Panel title={act.busy ? "Creating market" : "Unfinished market"}>
            <p className="prose strong">{draft.definition.question}</p>
            <p>{act.busy ? `Step: ${act.step ?? "working"}.` : `Stopped while ${stage}.`}</p>
            {(draft.genesisTxid || draft.vaultTxid) && (
                <p className="small">
                    {draft.genesisTxid && <>Assets <Txid txid={draft.genesisTxid} /></>}
                    {draft.vaultTxid && <> · vault <Txid txid={draft.vaultTxid} /></>}
                </p>
            )}
            {late && !act.busy && <p className="notice danger">Its close time ({when(fromUnix(draft.definition.closeAtUnix))}) is too near or past, so the server will refuse to list it.</p>}
            {!act.busy && (
                <div className="row2">
                    <button type="button" className="btn primary" onClick={() => void create(draft)}>Resume</button>
                    <button
                        type="button"
                        className="btn ghost"
                        onClick={() => {
                            if (!window.confirm(draft.vaultTxid ? "The vault is already funded. Discarding leaves its collateral locked in an unlisted market. Discard anyway?" : "Discard this unfinished market?")) return;
                            clearDraft(session.script);
                            setDraft(null);
                        }}
                    >
                        Discard
                    </button>
                </div>
            )}
            <ActionStatus s={act} />
        </Panel>
    );
}

function Form({ session, onStart }: { session: Session; onStart(d: CreateDraft): void }) {
    const { config, holdings } = useApp();
    const [question, setQuestion] = useState("");
    const [rules, setRules] = useState("");
    const [labelA, setLabelA] = useState("YES");
    const [labelB, setLabelB] = useState("NO");
    const [category, setCategory] = useState("");
    const [closeAt, setCloseAt] = useState(() => localInput(new Date(Math.ceil(Date.now() / 3_600_000) * 3_600_000 + 7 * 86_400_000)));
    const [timeoutText, setTimeoutText] = useState<string | null>(null);
    const [mode, setMode] = useState<"self" | "paste">("self");
    const [pasted, setPasted] = useState("");
    const unit = BigInt(config.unitSats);
    const lock = VAULT_BASE_SATS + unit;
    const now = Date.now() / 1000;
    const closeUnix = unixOf(closeAt);
    const timeoutAt = timeoutText ?? (Number.isFinite(closeUnix) ? localInput(new Date((closeUnix + DEFAULT_TIMEOUT_DAYS * 86400) * 1000)) : "");
    const timeoutUnix = unixOf(timeoutAt);
    const oracleKey = mode === "self" ? session.pubkey : pasted.trim().toLowerCase();
    const a = labelA.trim();
    const b = labelB.trim();

    const problems: string[] = [];
    if (question.trim().length < 10 || question.length > MAX_QUESTION) problems.push(`Question: 10 to ${MAX_QUESTION} characters`);
    if (!rules.trim() || rules.length > MAX_RULES) problems.push("Rules: say exactly how the outcome will be decided");
    if (!a || !b || a.length > MAX_LABEL || b.length > MAX_LABEL || a.toLowerCase() === b.toLowerCase()) problems.push(`Outcomes: two different labels of 1 to ${MAX_LABEL} characters`);
    if (category.trim().length > MAX_LABEL) problems.push(`Category: at most ${MAX_LABEL} characters`);
    if (!(closeUnix >= now + MIN_LEAD_SECONDS && closeUnix <= now + MAX_HORIZON_SECONDS)) problems.push("Close time: between 5 minutes and 30 days from now");
    if (!(timeoutUnix > closeUnix && timeoutUnix <= closeUnix + MAX_TIMEOUT_AFTER_CLOSE_SECONDS)) problems.push("Timeout: after the close time and at most 365 days after it");
    if (mode === "paste" && !isAttestorKey(oracleKey)) problems.push("Oracle: paste an x-only key (64 hex) or a 0x10/0x11 ECDSA key (68 hex: secp256k1 or P-256)");
    if (holdings && holdings.plainSats < lock + CARRIER_SATS) problems.push(`Funds: you need ${sats(lock + CARRIER_SATS)} in your balance; you have ${sats(holdings.plainSats)}`);

    const start = () => onStart({
        marketId: hex.encode(crypto.getRandomValues(new Uint8Array(16))),
        network: config.network,
        definition: {
            question: question.trim(), rules: rules.trim(), outcomes: [a, b], category: category.trim() || null,
            closeAtUnix: String(closeUnix), timeoutAtUnix: String(timeoutUnix),
        },
        oracleKey,
        unitSats: config.unitSats,
        exitDelaySeconds: config.exitDelaySeconds,
    });

    return (
        <form className="stack" onSubmit={(e) => { e.preventDefault(); if (problems.length === 0) start(); }}>
            <Panel title="Question">
                <label className="field">
                    <span>Question</span>
                    <input value={question} maxLength={MAX_QUESTION} onChange={(e) => setQuestion(e.target.value)} placeholder="Will … happen by …?" />
                </label>
                <label className="field">
                    <span>Rules: the exact resolution criteria and source</span>
                    <textarea rows={6} maxLength={MAX_RULES} value={rules} onChange={(e) => setRules(e.target.value)} />
                </label>
                <div className="row2">
                    <label className="field"><span>Outcome A</span><input value={labelA} maxLength={MAX_LABEL} onChange={(e) => setLabelA(e.target.value)} /></label>
                    <label className="field"><span>Outcome B</span><input value={labelB} maxLength={MAX_LABEL} onChange={(e) => setLabelB(e.target.value)} /></label>
                </div>
                <label className="field">
                    <span>Category (optional)</span>
                    <input list="categories" value={category} maxLength={MAX_LABEL} onChange={(e) => setCategory(e.target.value)} />
                    <datalist id="categories">{CATEGORIES.map((c) => <option key={c} value={c} />)}</datalist>
                </label>
            </Panel>
            <Panel title="Timing">
                <div className="row2">
                    <label className="field">
                        <span>Close time (local)</span>
                        <input type="datetime-local" value={closeAt} onChange={(e) => setCloseAt(e.target.value)} />
                    </label>
                    <label className="field">
                        <span>Timeout (local)</span>
                        <input type="datetime-local" value={timeoutAt} onChange={(e) => setTimeoutText(e.target.value)} />
                        <small className="muted">
                            {timeoutText === null
                                ? `${DEFAULT_TIMEOUT_DAYS} days after the close until you change it`
                                : <button type="button" className="linklike" onClick={() => setTimeoutText(null)}>Reset to {DEFAULT_TIMEOUT_DAYS} days after the close</button>}
                        </small>
                    </label>
                </div>
                <p className="muted small">The oracle can resolve only after close. If nobody has resolved it by the timeout, anyone can settle the market as invalid: every share pays half.</p>
            </Panel>
            <Panel title="Oracle">
                <fieldset className="choices">
                    <legend>Who decides the outcome</legend>
                    <label className="radio"><input type="radio" name="oracle-mode" checked={mode === "self"} onChange={() => setMode("self")} /> You resolve it with your wallet key (your recovery phrase restores it)</label>
                    <label className="radio"><input type="radio" name="oracle-mode" checked={mode === "paste"} onChange={() => setMode("paste")} /> Someone else resolves it: paste their oracle public key</label>
                </fieldset>
                {mode === "paste" && (
                    <label className="field">
                        <span>Oracle public key (hex: x-only, or ECDSA secp256k1 / P-256)</span>
                        <input className="mono" autoComplete="off" spellCheck={false} value={pasted} onChange={(e) => setPasted(e.target.value)} />
                    </label>
                )}
            </Panel>
            <Panel title="Cost">
                <dl className="kv">
                    <dt>Vault lock</dt><dd>{sats(lock)}: base {n(VAULT_BASE_SATS)} plus one pair of shares at {n(unit)}</dd>
                    <dt>You receive</dt><dd>1 {a || "A"} + 1 {b || "B"}, together always worth {sats(unit)}</dd>
                    <dt>Capacity</dt><dd>the vault holds at most {n(MAX_SETS)} pairs of shares, including yours</dd>
                    <dt>Transactions</dt><dd>two, signed here: asset issuance, then vault funding</dd>
                </dl>
            </Panel>
            {problems.length > 0 && <ul className="plain hints">{problems.map((p) => <li key={p} className="hint">{p}</li>)}</ul>}
            <button type="submit" className="btn primary wide" disabled={problems.length > 0}>Create market and fund vault ({sats(lock)})</button>
        </form>
    );
}
