import { generateMnemonic, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { useState } from "react";
import { openSession, type Session } from "../chain.js";
import { useApp } from "../ctx.js";
import { MIN_PASSPHRASE, createKeystore, forgetKeystore, hasKeystore, isOpenKeystore, unlockKeystore } from "../keystore.js";
import { ActionStatus, Copy, ErrorBox, Loading, Panel, useAction } from "../ui.js";
import { Balances, ClaimsTable, useMarketIndex } from "./Portfolio.js";

export function WalletPage() {
    const { session } = useApp();
    const [, rerender] = useState(0);
    return (
        <div className="stack narrow">
            <div className="page-head"><h1>Wallet</h1></div>
            {session ? <Overview session={session} /> : hasKeystore() ? <Unlock onForget={() => rerender((x) => x + 1)} /> : <Onboarding />}
        </div>
    );
}

function Onboarding() {
    const [mode, setMode] = useState<"choose" | "create" | "restore">("choose");
    if (mode === "create") return <CreateWallet onBack={() => setMode("choose")} />;
    if (mode === "restore") return <RestoreWallet onBack={() => setMode("choose")} />;
    return (
        <Panel title="Set up a wallet">
            <p>Keys live only in this browser. The server never sees them: this page builds and signs every transaction itself.</p>
            <div className="row2">
                <button type="button" className="btn primary" onClick={() => setMode("create")}>Create a new wallet</button>
                <button type="button" className="btn" onClick={() => setMode("restore")}>Restore from a phrase</button>
            </div>
        </Panel>
    );
}

function pickIndexes(total: number, k: number): number[] {
    const picked = new Set<number>();
    while (picked.size < k) picked.add(crypto.getRandomValues(new Uint32Array(1))[0]! % total);
    return [...picked].sort((a, b) => a - b);
}

function CreateWallet({ onBack }: { onBack(): void }) {
    const [mnemonic] = useState(() => generateMnemonic(wordlist, 128));
    const words = mnemonic.split(" ");
    const [checks] = useState(() => pickIndexes(words.length, 3));
    const [stage, setStage] = useState<"show" | "confirm" | "protect">("show");
    const [answers, setAnswers] = useState(["", "", ""]);
    const correct = checks.every((i, k) => answers[k]?.trim().toLowerCase() === words[i]);
    if (stage === "protect") return <Protect mnemonic={mnemonic} onBack={() => setStage("confirm")} />;
    if (stage === "confirm") {
        return (
            <Panel title="Confirm your recovery phrase">
                <form className="stack" onSubmit={(e) => { e.preventDefault(); if (correct) setStage("protect"); }}>
                    <p className="muted">Type these words from your written copy.</p>
                    {checks.map((i, k) => (
                        <label key={i} className="field">
                            <span>Word #{i + 1}</span>
                            <input autoComplete="off" autoCapitalize="none" spellCheck={false} value={answers[k] ?? ""}
                                onChange={(e) => setAnswers((a) => a.map((v, j) => (j === k ? e.target.value : v)))} />
                        </label>
                    ))}
                    {!correct && answers.every((a) => a.trim()) && <p className="hint">At least one word does not match. Check your copy.</p>}
                    <div className="row2">
                        <button type="button" className="btn" onClick={() => setStage("protect")}>Skip</button>
                        <button type="submit" className="btn primary" disabled={!correct}>Continue</button>
                    </div>
                </form>
            </Panel>
        );
    }
    return (
        <Panel title="Write down your recovery phrase">
            <p className="notice warn">These 12 words are the only backup of this wallet. Anyone who sees them can take its funds. Write them down offline, in order, and keep them private.</p>
            <ol className="words">{words.map((w, i) => <li key={i}><span className="muted">{i + 1}.</span> {w}</li>)}</ol>
            <Copy text={mnemonic} label="Copy phrase" />
            <div className="row2">
                <button type="button" className="btn" onClick={() => setStage("protect")}>Skip backup check</button>
                <button type="button" className="btn primary" onClick={() => setStage("confirm")}>I wrote them down</button>
            </div>
            <button type="button" className="linklike" onClick={onBack}>Back</button>
        </Panel>
    );
}

function RestoreWallet({ onBack }: { onBack(): void }) {
    const [text, setText] = useState("");
    const [phrase, setPhrase] = useState<string | null>(null);
    const normalized = text.trim().toLowerCase().split(/\s+/).join(" ");
    const valid = validateMnemonic(normalized, wordlist);
    if (phrase) return <Protect mnemonic={phrase} onBack={() => setPhrase(null)} />;
    return (
        <Panel title="Restore from a recovery phrase">
            <form className="stack" onSubmit={(e) => { e.preventDefault(); if (valid) setPhrase(normalized); }}>
                <label className="field">
                    <span>Recovery phrase (12 or 24 words)</span>
                    <textarea rows={3} autoComplete="off" autoCapitalize="none" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
                </label>
                {text.trim() && !valid && <p className="hint">Not a valid BIP39 phrase. Check the spelling and the number of words.</p>}
                <p className="muted small">Restores your balance, your bets, and markets you resolve with your wallet key. Oracle keys generated by earlier versions are not in the phrase.</p>
                <div className="row2">
                    <button type="button" className="btn" onClick={onBack}>Back</button>
                    <button type="submit" className="btn primary" disabled={!valid}>Continue</button>
                </div>
            </form>
        </Panel>
    );
}

function Protect({ mnemonic, onBack }: { mnemonic: string; onBack(): void }) {
    const { chain, config, setSession } = useApp();
    const [pass, setPass] = useState("");
    const [pass2, setPass2] = useState("");
    const act = useAction();
    const problem = !chain ? "Waiting for the Arkade service"
        : pass.length < MIN_PASSPHRASE ? `Use at least ${MIN_PASSPHRASE} characters`
        : pass !== pass2 ? "The passphrases differ" : null;
    const submit = (passphrase: string) => act.run(async (step) => {
        step("Saving the recovery phrase");
        const ks = await createKeystore(passphrase, mnemonic);
        step("Opening the wallet");
        setSession(await openSession(chain!, config, ks));
        return "Wallet ready.";
    });
    return (
        <Panel title="Protect this wallet (optional)">
            <form className="stack" onSubmit={(e) => { e.preventDefault(); if (!problem) void submit(pass); }}>
                <p className="muted small">The phrase is stored encrypted in this browser (PBKDF2-SHA256 with 600,000 iterations, AES-256-GCM). The passphrase itself is never stored; if you lose it, restore from the phrase.</p>
                <input type="text" name="username" autoComplete="username" value="Arkade wallet" readOnly hidden />
                <label className="field">
                    <span>Passphrase</span>
                    <input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
                </label>
                <label className="field">
                    <span>Repeat passphrase</span>
                    <input type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
                </label>
                {pass && problem && <p className="hint">{problem}</p>}
                <p className="muted small">Without a passphrase the wallet opens automatically in this browser, and anyone using this browser profile can spend from it.</p>
                <div className="row2">
                    <button type="button" className="btn" disabled={!chain || act.busy} onClick={() => void submit("")}>Skip, no passphrase</button>
                    <button type="submit" className="btn primary" disabled={!!problem || act.busy}>Encrypt and open</button>
                </div>
                <ActionStatus s={act} />
                <button type="button" className="linklike" onClick={onBack} disabled={act.busy}>Back</button>
            </form>
        </Panel>
    );
}

function Unlock({ onForget }: { onForget(): void }) {
    const { chain, config, setSession } = useApp();
    const [pass, setPass] = useState("");
    const [confirm, setConfirm] = useState("");
    const act = useAction();
    const open = isOpenKeystore();
    const submit = () => act.run(async (step) => {
        step("Decrypting");
        const ks = await unlockKeystore(open ? "" : pass);
        step("Opening the wallet");
        setSession(await openSession(chain!, config, ks));
        return "Unlocked.";
    });
    return (
        <Panel title="Unlock wallet">
            <form className="stack" onSubmit={(e) => { e.preventDefault(); if (chain && (open || pass)) void submit(); }}>
                {!open && (
                    <>
                        <input type="text" name="username" autoComplete="username" value="Arkade wallet" readOnly hidden />
                        <label className="field">
                            <span>Passphrase</span>
                            <input type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} />
                        </label>
                    </>
                )}
                {!chain && <p className="hint">Waiting for the Arkade service before the wallet can open.</p>}
                <button type="submit" className="btn primary" disabled={(!open && !pass) || !chain || act.busy}>{open ? "Open wallet" : "Unlock"}</button>
                <ActionStatus s={act} />
            </form>
            <details className="danger-zone">
                <summary>Forgot the passphrase?</summary>
                <div className="stack">
                    <p>Remove this wallet from the browser, then restore it from its recovery phrase. Without the phrase, its funds and any oracle keys stored here are lost for good.</p>
                    <label className="field">
                        <span>Type FORGET to confirm</span>
                        <input autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                    </label>
                    <button type="button" className="btn danger" disabled={confirm !== "FORGET"} onClick={() => { forgetKeystore(); onForget(); }}>
                        Remove wallet from this browser
                    </button>
                </div>
            </details>
        </Panel>
    );
}

function Overview({ session }: { session: Session }) {
    const { lock, holdings, holdingsError } = useApp();
    const { index, error, reload } = useMarketIndex();
    return (
        <>
            <Panel title="Account" actions={<button type="button" className="btn small" onClick={() => void lock()}>Lock</button>}>
                <dl className="kv">
                    <dt>Arkade address</dt><dd><span className="mono break">{session.address}</span> <Copy text={session.address} /></dd>
                </dl>
            </Panel>
            <Balances />
            <ExportPhrase session={session} />
            <Panel title="Your bets">
                {!holdings ? (holdingsError ? <p className="error">{holdingsError}</p> : <Loading what="bets" />)
                    : index ? <ClaimsTable index={index} holdings={holdings} />
                    : error ? <ErrorBox error={error} onRetry={() => void reload()} /> : <Loading what="markets" />}
            </Panel>
            <OracleKeys session={session} />
        </>
    );
}

function ExportPhrase({ session }: { session: Session }) {
    const [shown, setShown] = useState(false);
    const phrase = session.keystore.secrets.mnemonic;
    return (
        <Panel title="Recovery phrase">
            <p className="muted small">These 12 words restore this wallet anywhere. Anyone who sees them can spend your funds.</p>
            {shown ? (
                <div className="stack">
                    <ol className="words">{phrase.split(" ").map((w, i) => <li key={i}><span className="muted">{i + 1}.</span> {w}</li>)}</ol>
                    <div className="row-actions">
                        <Copy text={phrase} label="Copy phrase" />
                        <button type="button" className="btn small" onClick={() => setShown(false)}>Hide</button>
                    </div>
                </div>
            ) : <button type="button" className="btn" onClick={() => setShown(true)}>Reveal recovery phrase</button>}
        </Panel>
    );
}

function OracleKeys({ session }: { session: Session }) {
    const [shown, setShown] = useState<string | null>(null);
    const keys = Object.entries(session.keystore.secrets.oracleKeys);
    if (keys.length === 0) return null;
    return (
        <Panel title="Oracle keys">
            <p className="muted small">Keys for markets this wallet resolves, stored encrypted with the wallet. The recovery phrase does not restore them: back up each secret on its own.</p>
            <ul className="plain">
                {keys.map(([pub, secret]) => (
                    <li key={pub}>
                        <div className="mono break">{pub}</div>
                        {shown === pub ? (
                            <div className="row-actions">
                                <span className="mono break secret">{secret}</span>
                                <Copy text={secret} label="Copy secret" />
                                <button type="button" className="btn small" onClick={() => setShown(null)}>Hide</button>
                            </div>
                        ) : <button type="button" className="btn small" onClick={() => setShown(pub)}>Reveal secret</button>}
                    </li>
                ))}
            </ul>
        </Panel>
    );
}
