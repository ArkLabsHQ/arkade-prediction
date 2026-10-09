import { describe, expect, it } from "vitest";
import { sectionOf } from "../../../src/shared/sections.js";

describe("sectionOf", () => {
    it("maps source tags and question wording onto the browse sections", () => {
        expect(sectionOf(["crypto up/down"], "Bitcoin Up or Down - October 9")).toBe("Crypto");
        expect(sectionOf(["counter-strike-2"], "Counter-Strike: FURIA vs MOUZ")).toBe("Sports");
        expect(sectionOf(["games"], "Buccaneers vs. Cowboys")).toBe("Sports");
        expect(sectionOf(["economic-policy"], "Will the Fed increase interest rates?")).toBe("Economy");
        expect(sectionOf(["earn-4"], "Will the Republican Party control the House?")).toBe("Politics");
        expect(sectionOf(["blockade"], "US announces end of Iranian blockade?")).toBe("World");
        expect(sectionOf([], "Will it rain in Paris tomorrow?")).toBe("Other");
    });
});
