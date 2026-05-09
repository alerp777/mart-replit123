import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "@workspace/db/schema";
import { buildPgPoolConfig } from "@workspace/db/connection-url";
import { logger } from "./logger.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  logger.fatal("❌ DATABASE_URL not set");
  process.exit(1);
}
logger.info({ urlLength: databaseUrl.length }, "✅ DB URL loaded");

const pool = new Pool(buildPgPoolConfig(databaseUrl));
export const db = drizzle(pool, { schema });
export { pool };
