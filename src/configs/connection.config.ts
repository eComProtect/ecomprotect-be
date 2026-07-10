import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "@/schema/schema";
import { logger } from "@/utils/logger.util";
import { env } from "@/utils/env.util";
import { Pool } from "pg";

export const database = drizzle(env.CONNECTION_URL, {
  casing: "snake_case",
  schema,
});

export const connection = new Pool({ connectionString: env.CONNECTION_URL });

// Neon drops idle connections after ~5 minutes; pg emits this as an 'error'
// event on the pool (not a thrown exception). Without a listener, Node treats
// it as an unhandled 'error' event and crashes the process.
// `drizzle(connectionString, ...)` creates its own internal pg.Pool (exposed
// as `database.$client`), separate from the `connection` pool below — both
// need the listener since ORM queries go through the former and
// rate-limiter-flexible goes through the latter.
(database.$client as Pool).on("error", (err) => {
  logger.error(`Unexpected DB pool error: ${err.message}`);
});

connection.on("error", (err) => {
  logger.error(`Unexpected DB pool error: ${err.message}`);
});
