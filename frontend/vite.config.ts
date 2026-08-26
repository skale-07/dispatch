import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev mode proxies /api to the console server (npm run console, port 8899).
// Production is served BY the console server from dist/.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // The shadcn component convention (U2) — registry components import
    // from "@/components/ui" and "@/lib/utils".
    alias: { "@": path.resolve(__dirname, "src") },
  },
  build: { outDir: "dist", sourcemap: false },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8899" },
  },
});
