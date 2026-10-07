import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const api = process.env.APM_API_URL ?? "http://localhost:37400";

export default defineConfig({
    plugins: [react()],
    build: { outDir: "dist/web", emptyOutDir: true, target: "es2022" },
    server: { proxy: { "/api": { target: api, changeOrigin: true } } },
    preview: { proxy: { "/api": { target: api, changeOrigin: true } } },
});
