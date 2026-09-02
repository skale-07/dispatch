import path from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * Social-preview URLs must be absolute (Open Graph scrapers do not
 * resolve relative paths), so index.html carries %VITE_PUBLIC_URL%
 * placeholders. Vite fills them when the variable is set at build time;
 * when it is not, Vite leaves the literal in place — this hook blanks it
 * so an unconfigured build ships a root-relative /og.png instead of a
 * broken "%VITE_PUBLIC_URL%/og.png".
 */
function publicUrlFallback(): Plugin {
  return {
    name: "dispatch:public-url-fallback",
    transformIndexHtml(html) {
      const base = (process.env.VITE_PUBLIC_URL ?? "").replace(/\/+$/, "");
      return html.replaceAll("%VITE_PUBLIC_URL%", base);
    },
  };
}

// Dev mode proxies /api to the console server (npm run console, port 8899).
// Production is served BY the console server from dist/.
export default defineConfig({
  plugins: [react(), tailwindcss(), publicUrlFallback()],
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
