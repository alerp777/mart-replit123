import * as esbuild from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  outfile: "dist/index.mjs",
  format: "esm",
  sourcemap: true,
  external: ["pg", "pg-native", "drizzle-orm", "bcrypt", "sharp", "canvas", "@sentry/node", "firebase-admin", "twilio"],
  plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
  logLevel: "info",
});
