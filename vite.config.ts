import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The web app lives in src/web. In dev, /api is proxied to the Node dev server
// (src/dev-server.ts), which runs the same Hono app that the Worker runs.
export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  root: ".",
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1600 }, // maplibre-gl is ~800 kB
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: true } },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
} as never);
