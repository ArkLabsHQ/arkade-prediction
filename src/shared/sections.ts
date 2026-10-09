/** The browse sections every market falls into, whatever its source's own tag vocabulary. */
export const SECTIONS = ["Sports", "Crypto", "Politics", "Economy", "Tech", "Culture", "World", "Other"] as const;
export type Section = (typeof SECTIONS)[number];

// Checked in order: the first section with a matching tag or question keyword wins.
const RULES: [Section, RegExp][] = [
    ["Crypto", /\b(crypto|bitcoin|btc|ethereum|eth|solana|sol|xrp|doge|bnb|stablecoin|defi|memecoin|up or down|updown)\b/i],
    ["Sports", /\b(sports?|nfl|nba|mlb|nhl|soccer|football|tennis|golf|f1|formula ?1|ufc|mma|boxing|cricket|epl|premier league|champions league|la liga|serie a|bundesliga|olympics?|super bowl|world cup|ncaa|esports|basketball|baseball|hockey|games|counter strike|valorant|league of legends|dota|vs\.?)\b/i],
    ["Economy", /\b(economy|economics|fed|fomc|interest rates?|inflation|cpi|gdp|recession|jobs report|unemployment|tariffs?|finance|business|stocks?|s&p|nasdaq|earnings|ipo|oil|gold)\b/i],
    ["Politics", /\b(politics|elections?|president(ial)?|senate|congress|house|governor|mayor|parliament|prime minister|trump|biden|harris|democrats?|republicans?|primary|cabinet|supreme court)\b/i],
    ["Tech", /\b(tech|ai|openai|chatgpt|gpt|gemini|anthropic|claude|apple|google|microsoft|nvidia|tesla|spacex|science|space|nasa)\b/i],
    ["Culture", /\b(culture|pop-culture|movies?|box office|oscars?|grammys?|emmys?|music|album|billboard|tv|netflix|celebrit(y|ies)|awards?|youtube|tiktok|twitter|mrbeast)\b/i],
    ["World", /\b(world|geopolitics|war|ceasefire|russia|ukraine|china|taiwan|israel|gaza|iran(ian)?|blockade|sanctions?|nato|un|middle east|nobel)\b/i],
];

export function sectionOf(tags: readonly string[], question = ""): Section {
    const text = tags.join(" ").replace(/-/g, " ");
    for (const [section, re] of RULES) if (re.test(text)) return section;
    for (const [section, re] of RULES) if (re.test(question)) return section;
    return "Other";
}
