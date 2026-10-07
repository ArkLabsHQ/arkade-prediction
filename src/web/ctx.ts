import { createContext, useContext } from "react";
import type { ConfigJson } from "../shared/api.js";
import type { Chain, Holdings, Session } from "./chain.js";

export interface AppState {
    config: ConfigJson;
    chain: Chain | null;
    chainError: string | null;
    reconnect(): void;
    session: Session | null;
    setSession(s: Session | null): void;
    lock(): Promise<void>;
    holdings: Holdings | null;
    holdingsError: string | null;
    refreshHoldings(): Promise<void>;
}

export const AppCtx = createContext<AppState | null>(null);

export function useApp(): AppState {
    const app = useContext(AppCtx);
    if (!app) throw new Error("useApp outside AppCtx");
    return app;
}
