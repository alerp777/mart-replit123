import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

// ADMIN_PORT_OVERRIDE (set in userenv) beats the workflow-command's ADMIN_DEV_PORT=3001,
// then ADMIN_DEV_PORT, then PORT, then falls back to 23744.
// The Replit artifact platform monitors port 23744 for this workflow, so
// ADMIN_PORT_OVERRIDE=23744 must be set in userenv.shared to match it.
const rawPort =
  process.env.ADMIN_PORT_OVERRIDE ||
  process.env.ADMIN_DEV_PORT ||
  process.env.PORT ||
  "23744";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// BASE_PATH defaults to "/" (root) for standalone deployments
// Can be overridden via process.env.BASE_PATH
const basePath = process.env.BASE_PATH || "/";

// API proxy target for local development
// Defaults to http://127.0.0.1:8080 (same machine, port 8080)
const apiProxyTarget = process.env.VITE_API_PROXY_TARGET || "http://127.0.0.1:8080";

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    ...(process.env.NODE_ENV !== "production" &&
    process.env.REPL_ID !== undefined
      ? [
          await import("@replit/vite-plugin-cartographer").then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, ".."),
            }),
          ),
          await import("@replit/vite-plugin-dev-banner").then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      "@assets": path.resolve(import.meta.dirname, "..", "..", "assets"),
      // Force all packages (including react-leaflet) to use the same React instance
      "react": path.resolve(import.meta.dirname, "node_modules/react"),
      "react-dom": path.resolve(import.meta.dirname, "node_modules/react-dom"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
    esbuild: {
      drop: ["console", "debugger"],
    },
    /**
     * Browser support matrix (mirrored in `package.json#browserslist`):
     *   Chrome ≥100, Firefox ≥100, Safari ≥15.4, Edge ≥100, iOS ≥15.4.
     * The esbuild targets below ensure the emitted JS only uses syntax
     * supported by every entry in the matrix.
     */
    target: ["chrome100", "firefox100", "safari15.4", "edge100"],
    /**
     * Heavy third-party deps split into their own chunks. Without this
     * the entry chunk balloons (recharts + leaflet + mapbox-gl alone are
     * ~1MB minified) and a single deploy invalidates every cache.
     * Splitting lets browsers cache the libraries across releases.
     */
    rollupOptions: {
      output: {
        /**
         * Only bare-import packages are listed here. `react-map-gl` and
         * `mapbox-gl` are pulled in via dynamic imports inside
         * UniversalMap, so Rollup naturally chunks them — listing them
         * statically breaks the build because `react-map-gl` only
         * publishes subpath exports.
         */
        manualChunks: {
          "react-vendor": ["react", "react-dom"],
          "react-query": ["@tanstack/react-query"],
          "charts": ["recharts"],
          "leaflet": ["leaflet", "react-leaflet"],
        },
      },
    },
  },
  server: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
    headers: {
      "Cache-Control": "no-store",
    },
    hmr: process.env.REPLIT_DEV_DOMAIN
      ? { clientPort: 443, protocol: "wss", host: process.env.REPLIT_DEV_DOMAIN }
      : { port: port },
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
      },
    },
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
