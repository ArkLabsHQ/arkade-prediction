import type { ReactNode } from "react";
import type { MarketJson, ProofJobJson, ProofStage } from "../../shared/api.js";
import { api, enc, useLive } from "../api.js";
import { duration, n } from "../format.js";
import { ErrorBox, Link, Loading, Panel, Time, useAsync, useNow } from "../ui.js";

const STEPS = [
    ["Polymarket result", "Polymarket records the final result on the Polygon blockchain."],
    ["Polygon checkpoint on Ethereum", "Polygon anchors a batch of its blocks, including that one, on Ethereum."],
    ["Ethereum finality", "Ethereum makes that anchor permanent; it can no longer be rolled back."],
    ["Proving", "A zero-knowledge proof checks the whole chain, from the result to Ethereum."],
    ["Verified", "The market's vault accepts the proof, with no one trusted in between."],
] as const;

const STEP_OF: Record<ProofStage, number> = {
    "waiting-source": 0, "waiting-checkpoint": 1, "waiting-l1-finality": 2, "witness-ready": 3, proving: 3, verified: 5, failed: -1,
};

const STAGE_LABEL: Record<ProofStage, string> = {
    "waiting-source": "Waiting for the result",
    "waiting-checkpoint": "Waiting for the Ethereum checkpoint",
    "waiting-l1-finality": "Waiting for Ethereum finality",
    "witness-ready": "Ready to prove",
    proving: "Proving",
    verified: "Verified",
    failed: "Failed",
};

const BADGE: Record<ProofStage, string> = {
    "waiting-source": "s-closed", "waiting-checkpoint": "s-closed", "waiting-l1-finality": "s-closed",
    "witness-ready": "s-open", proving: "s-closed", verified: "s-resolved", failed: "s-failed",
};

const polygonTx = (tx: string) => `https://polygonscan.com/tx/${tx}`;
const polygonBlock = (b: number) => `https://polygonscan.com/block/${b}`;
const ethereumBlock = (b: number) => `https://etherscan.io/block/${b}`;
const Ext = ({ href, children }: { href: string; children: ReactNode }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;

const settled = (j: ProofJobJson) => j.stage === "witness-ready" || j.stage === "verified" || j.stage === "failed";
const elapsed = (j: ProofJobJson, now: number) => duration((settled(j) ? Date.parse(j.updatedAt) : now) - Date.parse(j.startedAt));

export const isProofTracked = (m: MarketJson) => m.kind === "polymarket" && m.source?.provider === "polymarket" && m.oracle.policy === "platform-attestor";

export function ProofPanel({ m }: { m: MarketJson }) {
    const proof = useAsync(() => api<{ job: ProofJobJson | null }>(`/api/markets/${enc(m.id)}/proof`).then((r) => r.job), [m.id]);
    useLive((c) => {
        if (c === "all" || c.has(m.id)) proof.reload();
    });
    const now = useNow(1000);
    const j = proof.data;
    return (
        <Panel title="Trustless proof" actions={j && <span className={`badge ${BADGE[j.stage]}`}>{STAGE_LABEL[j.stage]}</span>}>
            <p className="notice">
                Proving is not enabled yet. Today this market settles through the platform attestor, which signs only after checking
                Polymarket's final on-chain result. This tracker shows each piece of public evidence a proof of the same result needs, as it appears.
            </p>
            {proof.error && !j ? <ErrorBox error={proof.error} onRetry={proof.reload} />
                : j === undefined ? <Loading what="proof progress" />
                : j === null ? <p className="state">{Date.parse(m.closeAt) > now ? "Tracking starts when the market closes." : "This server is not tracking it yet."}</p>
                : <ProofSteps j={j} now={now} />}
        </Panel>
    );
}

function ProofSteps({ j, now }: { j: ProofJobJson; now: number }) {
    const at = STEP_OF[j.stage];
    const facts: ReactNode[] = [
        j.polygonBlock !== null && <>Polygon block <Ext href={polygonBlock(j.polygonBlock)}>{n(j.polygonBlock)}</Ext>{j.txHash && <> · <Ext href={polygonTx(j.txHash)}>transaction</Ext></>}</>,
        j.headerBlockId !== null && <>Checkpoint {n(j.headerBlockId)}</>,
        j.checkpointL1Block !== null && <>Ethereum block <Ext href={ethereumBlock(j.checkpointL1Block)}>{n(j.checkpointL1Block)}</Ext></>,
    ];
    return (
        <>
            <ol className="steps">
                {STEPS.map(([label, text], i) => {
                    const state = i < at ? "done" : i === at ? (i === 3 ? "off" : "now") : "todo";
                    return (
                        <li key={label} className={state} aria-current={state === "now" ? "step" : undefined}>
                            <strong>{label}</strong>
                            <span className="muted small">
                                {state === "done" ? "Done. " : state === "now" ? "In progress. " : state === "off" ? "Not enabled yet. " : ""}{text}
                            </span>
                            {facts[i] && <span className="small">{facts[i]}</span>}
                        </li>
                    );
                })}
            </ol>
            <p className="muted small">
                {settled(j) ? `Reached in ${elapsed(j, now)}` : `Tracking for ${elapsed(j, now)}`}. {j.detail}
            </p>
            <details>
                <summary>Technical details</summary>
                <dl className="kv">
                    <dt>Stage</dt><dd className="mono">{j.stage}</dd>
                    <dt>Resolution tx</dt><dd className="mono break">{j.txHash ? <Ext href={polygonTx(j.txHash)}>{j.txHash}</Ext> : "—"}{j.logIndex !== null && ` (log ${j.logIndex})`}</dd>
                    <dt>Checkpoint</dt><dd className="mono break">{j.headerBlockId ?? "—"}{j.checkpointRoot && `\nroot ${j.checkpointRoot}`}</dd>
                    <dt>Ethereum block</dt><dd className="mono">{j.checkpointL1Block ?? "—"}</dd>
                    <dt>Read errors</dt><dd>{j.attempts}</dd>
                    <dt>Last checked</dt><dd><Time t={j.updatedAt} now={now} /></dd>
                </dl>
            </details>
        </>
    );
}

export function ProofsPage() {
    const list = useAsync(() => api<{ jobs: ProofJobJson[] }>("/api/proofs?limit=100").then((r) => r.jobs), []);
    useLive(() => list.reload());
    const now = useNow(1000);
    return (
        <div className="stack">
            <div className="page-head">
                <h1>Proofs</h1>
                <p className="muted">
                    Progress towards trustless proofs of Polymarket results. Proving is not enabled yet: markets settle through the platform attestor today.
                </p>
            </div>
            <Panel title="Tracked results">
                {list.data ? (list.data.length === 0 ? <p className="state">No closed Polymarket markets are being tracked yet.</p> : (
                    <div className="table-wrap">
                        <table className="data compact">
                            <thead>
                                <tr><th scope="col">Market</th><th scope="col">Stage</th><th scope="col" className="num">Polygon block</th><th scope="col">Checkpoint</th><th scope="col">Time</th></tr>
                            </thead>
                            <tbody>
                                {list.data.map((j) => (
                                    <tr key={j.marketId}>
                                        <td><Link to={`/markets/${enc(j.marketId)}`}>{j.question}</Link></td>
                                        <td><span className={`badge ${BADGE[j.stage]}`}>{STAGE_LABEL[j.stage]}</span></td>
                                        <td className="num">{j.polygonBlock !== null ? <Ext href={polygonBlock(j.polygonBlock)}>{n(j.polygonBlock)}</Ext> : "—"}</td>
                                        <td>{j.checkpointL1Block !== null ? <Ext href={ethereumBlock(j.checkpointL1Block)}>{n(j.headerBlockId!)}</Ext> : j.headerBlockId ?? "—"}</td>
                                        <td>{elapsed(j, now)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )) : list.error ? <ErrorBox error={list.error} onRetry={list.reload} /> : <Loading what="proofs" />}
            </Panel>
        </div>
    );
}
