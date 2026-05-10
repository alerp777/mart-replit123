import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import runtimeErrorOverlay from "@replit/vite-plugin-runtime-error-modal";

/* VENDOR_DEV_PORT takes priority, then PORT, then falls back to 3002.
   This avoids conflicts when PORT=5000 is set globally for the API server. */
const rawPort = process.env.VENDOR_DEV_PORT || process.env.PORT;
const port = rawPort ? Number(rawPort) : 3002;

if (rawPort && (Number.isNaN(port) || port <= 0)) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

/* BASE_PATH defaults to "/vendor/" so the in-app router base matches the
   most common deployment (path-routed behind the Replit proxy). Standalone
   deployments or local quick-starts override via env. */
const basePath = process.env.BASE_PATH || "/vendor/";
const _rawProxyTarget = process.env.VITE_API_PROXY_TARGET;
if (!_rawProxyTarget && process.env.NODE_ENV === "production") {
  throw new Error(
    "[vendor-app/vite.config] VITE_API_PROXY_TARGET is not set. " +
    "Set it to the API server URL (e.g. http://127.0.0.1:5000) before running a production build.",
  );
}
const apiProxyTarget = _rawProxyTarget ?? "http://127.0.0.1:5000";

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
      "@workspace/ui": path.resolve(import.meta.dirname, "../../lib/ui/src"),
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
      "/vendor/api": {
        target: apiProxyTarget,
        changeOrigin: true,
        ws: true,
        rewrite: (requestPath) => requestPath.replace(/^\/vendor\/api/, "/api"),
      },
    },
    fs: {
      strict: true,
      deny: ["**/.*"],
      allow: ["../../lib/ui"],
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
