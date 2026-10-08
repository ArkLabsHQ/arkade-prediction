import type { MarketJson } from "../shared/api.js";

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

export function rel(t: string | Date, now = Date.now()): string {
    const d = (typeof t === "string" ? new Date(t) : t).getTime() - now;
    const a = Math.abs(d) / 1000;
    const span =
        a < 60 ? `${Math.round(a)}s`
        : a < 3600 ? `${Math.floor(a / 60)}m`
        : a < 86400 ? `${Math.floor(a / 3600)}h ${Math.floor((a % 3600) / 60)}m`
        : `${Math.floor(a / 86400)}d ${Math.floor((a % 86400) / 3600)}h`;
    return d >= 0 ? `in ${span}` : `${span} ago`;
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
