import type { MarketJson } from "../shared/api.js";
import { sectionOf, type Section } from "../shared/sections.js";

const int = new Intl.NumberFormat("en-US");
const date = new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
});

export type Num = string | number | bigint;
export const big = (v: Num) => (typeof v === "bigint" ? v : BigInt(v));
export const n = (v: Num) => int.format(big(v));
export const sats = (v: Num) => `${n(v)} sats`;

export function btc(v: Num): string {
    const s = big(v);
    const a = s < 0n ? -s : s;
    return `${s < 0n ? "-" : ""}${a / 100_000_000n}.${(a % 100_000_000n).toString().padStart(8, "0")} BTC`;
}

/** Implied probability of a per-share price, truncated to one decimal. */
export function pct(price: Num | null | undefined, unit: Num): string {
    if (price === null || price === undefined) return "—";
    const u = big(unit);
    if (u <= 0n) return "—";
    const t = (big(price) * 1000n) / u;
    return `${t / 10n}.${t % 10n}%`;
}

export const fromUnix = (u: Num) => new Date(Number(u) * 1000);
export const when = (t: string | Date) => date.format(typeof t === "string" ? new Date(t) : t);

export function duration(ms: number): string {
    const a = Math.abs(ms) / 1000;
    const two = (big: number, bu: string, small: number, su: string) => `${big}${bu}${small ? ` ${small}${su}` : ""}`;
    return a < 60 ? `${Math.round(a)}s`
        : a < 3600 ? `${Math.floor(a / 60)}m`
        : a < 86400 ? two(Math.floor(a / 3600), "h", Math.floor((a % 3600) / 60), "m")
        : two(Math.floor(a / 86400), "d", Math.floor((a % 86400) / 3600), "h");
}

export function rel(t: string | Date, now = Date.now()): string {
    const d = (typeof t === "string" ? new Date(t) : t).getTime() - now;
    return d >= 0 ? `in ${duration(d)}` : `${duration(d)} ago`;
}

export const short = (s: string, head = 8, tail = 6) => (s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s);
export const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Whole non-negative count typed by a user, or null. */
export function count(s: string): bigint | null {
    const t = s.trim();
    return /^\d{1,15}$/.test(t) ? BigInt(t) : null;
}

/** Source reference prices are decimal strings in [0, 1]; display only, never executable. */
export const refPct = (price: string) => `${(Number(price) * 100).toFixed(1)}%`;

/** Regtest demo markets that mirror an already-resolved source; the importer marks them by category. */
export const isReplay = (m: MarketJson) => m.kind === "polymarket" && m.category === "historical replay";

/** Ops and test-network markets that should not lead the public board. */
export const isTest = (m: MarketJson) => m.category === "test" || isReplay(m);

const PROVIDERS = { polymarket: "Polymarket", kalshi: "Kalshi", manifold: "Manifold", limitless: "Limitless", opinion: "Opinion" } as const;
export const providerName = (m: MarketJson) => (m.source ? PROVIDERS[m.source.provider] ?? m.source.provider : null);

// Servers deployed before the section field existed omit it.
export const sectionFor = (m: MarketJson): Section => m.section ?? sectionOf(m.category ? [m.category] : [], m.question);

export function unavailableReason(m: MarketJson): string | null {
    if (m.status === "failed") return m.resolution.detail || "Activation failed";
    if (m.status === "activating") return m.resolution.detail || "Activating: the vault is not confirmed yet";
    if (!m.terms) return "Not tradable: no funded vault yet";
    return null;
}

/** Only http(s) links from untrusted market data become clickable. */
export function safeHref(u: string | null | undefined): string | undefined {
    try {
        const p = new URL(u ?? "");
        return p.protocol === "https:" || p.protocol === "http:" ? p.href : undefined;
    } catch {
        return undefined;
    }
}

/** Display-only chance of outcome A: resolved outcome, else book midpoint (or one side), else the source reference. */
export function chanceOf(m: MarketJson): { p: number; from: "resolved" | "book" | "reference" } | null {
    if (m.vault.outcome === "yes" || m.vault.outcome === "no") return { p: m.vault.outcome === "yes" ? 1 : 0, from: "resolved" };
    const unit = Number(m.terms?.unitSats ?? 0);
    const { bid, ask } = m.book.yes;
    const sides = [bid, ask].filter((x): x is string => !!x).map(Number);
    if (unit > 0 && sides.length) return { p: Math.min(1, sides.reduce((a, b) => a + b, 0) / sides.length / unit), from: "book" };
    const ref = m.source?.referencePrices?.find((r) => r.outcome === m.outcomes[0]) ?? m.source?.referencePrices?.[0];
    return ref ? { p: Math.min(1, Math.max(0, Number(ref.price))), from: "reference" } : null;
}
