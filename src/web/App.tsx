import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConfigJson } from "../shared/api.js";
import { api, startLive, useLive, useLiveState } from "./api.js";
import { connectChain, openSession, readHoldings, type Chain, type Holdings, type Session } from "./chain.js";
import { AppCtx, useApp, type AppState } from "./ctx.js";
import { errMsg, n, short } from "./format.js";
import { hasKeystore, isOpenKeystore, unlockKeystore } from "./keystore.js";
import { CreatePage } from "./pages/Create.js";
import { MarketPage } from "./pages/Market.js";
import { Markets } from "./pages/Markets.js";
import { Operator } from "./pages/Operator.js";
import { Portfolio } from "./pages/Portfolio.js";
import { WalletPage } from "./pages/Wallet.js";
import { ErrorBox, Link, Loading, Logo, navigate, usePath } from "./ui.js";

export function App() {
    const [config, setConfig] = useState<ConfigJson | null>(null);
    const [error, setError] = useState<unknown>(null);
    const boot = useCallback(() => {
        setError(null);
        api<ConfigJson>("/api/config").then(setConfig, setError);
    }, []);
    useEffect(() => {
        boot();
        startLive();
    }, [boot]);
    useLive((change) => {
        if (change === "all" && !config) boot();
    });
    if (!config) {
        return (
            <div className="boot">
                <p className="brand-line"><Logo /> Arkade Prediction Markets</p>
                {error ? <ErrorBox error={error} onRetry={boot} /> : <Loading what="deployment config" />}
            </div>
        );
    }
    return <Shell config={config} />;
}

function Shell({ config }: { config: ConfigJson }) {
    const [chain, setChain] = useState<Chain | null>(null);
    const [chainError, setChainError] = useState<string | null>(null);
    const reconnect = useCallback(() => {
        setChainError(null);
        connectChain(config).then(setChain, (e) => setChainError(errMsg(e)));
    }, [config]);
    useEffect(reconnect, [reconnect]);

    const [session, setSession] = useState<Session | null>(null);
    const [holdings, setHoldings] = useState<Holdings | null>(null);
    const [holdingsError, setHoldingsError] = useState<string | null>(null);
    const refreshHoldings = useCallback(async () => {
        if (!session) return;
        try {
            setHoldings(await readHoldings(session));
            setHoldingsError(null);
        } catch (e) {
            setHoldingsError(errMsg(e));
        }
    }, [session]);
    useEffect(() => {
        setHoldings(null);
        if (!session) return;
        void refreshHoldings();
        const t = setInterval(() => void refreshHoldings(), 15_000);
        return () => clearInterval(t);
    }, [session, refreshHoldings]);
    // A wallet saved without a passphrase opens on load; Lock still closes it until the next load.
    const [autoOpened, setAutoOpened] = useState(false);
    useEffect(() => {
        if (!chain || autoOpened || !isOpenKeystore()) return;
        setAutoOpened(true);
        unlockKeystore("").then((ks) => openSession(chain, config, ks)).then(setSession, (e) => setChainError(errMsg(e)));
    }, [chain, config, autoOpened]);
    const lock = useCallback(async () => {
        setSession(null);
        await session?.wallet.dispose();
    }, [session]);

    const app = useMemo<AppState>(
        () => ({ config, chain, chainError, reconnect, session, setSession, lock, holdings, holdingsError, refreshHoldings }),
        [config, chain, chainError, reconnect, session, lock, holdings, holdingsError, refreshHoldings],
    );
    const path = usePath();
    // The admin domain opens on the console; the public one has no console at all.
    useEffect(() => void (config.admin && location.pathname === "/" && navigate("/operator")), [config.admin]);
    return (
        <AppCtx.Provider value={app}>
            {config.testNetwork && (
                <div className="banner test" role="note">
                    <strong>Test network ({config.network}).</strong> Coins here have no value. Never send real bitcoin to these addresses.
                </div>
            )}
            {chain?.emulatorWarning && <div className="banner danger" role="alert">{chain.emulatorWarning}</div>}
            {chainError && (
                <div className="banner danger" role="alert">
                    Arkade service unreachable: {chainError}. Browsing works; wallet and trading are disabled.{" "}
                    <button type="button" className="btn small" onClick={reconnect}>Retry</button>
                </div>
            )}
            <Header path={path} admin={config.admin} />
            <main className="page">{route(path, config.admin)}</main>
            <footer className="foot">
                <Logo />
                <span>Network {config.network}</span>
                <span>Deployment <span className="mono">{short(config.deploymentId)}</span></span>
                <span>1 winning share pays {n(config.unitSats)} sats</span>
            </footer>
        </AppCtx.Provider>
    );
}

function route(path: string, admin: boolean) {
    if (path === "/" || path === "/markets") return <Markets />;
    const m = /^\/markets\/([^/]+)$/.exec(path);
    if (m) return <MarketPage key={m[1]} id={decodeURIComponent(m[1]!)} />;
    if (path === "/portfolio") return <Portfolio />;
    if (path === "/create") return <CreatePage />;
    if (path === "/wallet") return <WalletPage />;
    if (admin && path === "/operator") return <Operator />;
    return <p className="state">No page at {path}. <Link to="/">Back to markets</Link></p>;
}

const NAV = [["/", "Markets"], ["/portfolio", "Portfolio"], ["/create", "Create"], ["/wallet", "Wallet"]] as const;

function Header({ path, admin }: { path: string; admin: boolean }) {
    const { session, holdings } = useApp();
    const live = useLiveState();
    const active = (to: string) => (to === "/" ? path === "/" || path.startsWith("/markets") : path === to);
    const wallet = session ? (holdings ? `${n(holdings.balance.available)} sats` : "Wallet…") : hasKeystore() ? "Locked" : "No wallet";
    return (
        <header className="topbar">
            <Link to="/" className="brand"><Logo /><span className="brand-name">Arkade <b>Prediction Markets</b></span></Link>
            <nav aria-label="Main">
                {[...NAV, ...(admin ? [["/operator", "Operator"] as const] : [])].map(([to, label]) => <Link key={to} to={to} current={active(to)}>{label}</Link>)}
            </nav>
            <div className="top-right">
                <span className={`live ${live}`} role="status">{live === "live" ? "Live" : live === "down" ? "Reconnecting" : "Connecting"}</span>
                <Link to="/wallet" className="chip">{wallet}</Link>
            </div>
        </header>
    );
}
