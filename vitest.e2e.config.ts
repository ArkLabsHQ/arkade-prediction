import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        include: ["test/e2e/**/*.test.ts"],
        globalSetup: ["test/e2e/global-setup.ts"],
        fileParallelism: false,
        testTimeout: 300_000,
        hookTimeout: 120_000,
    },
});
