import { createApp } from "./app.js";
import type { AppOptions } from "./app.js";
import {
  createPool,
  createPostgresRepositories,
  nonceRetentionSeconds,
  pingDatabase,
} from "./persistence/postgres.js";
import { REQUEST_FRESHNESS } from "./warrant/context.js";

const port = Number(process.env.PORT ?? 4000);
const allowedOrigin = process.env.WARRANT_ALLOWED_ORIGIN ?? "*";
const connectionString = process.env.DATABASE_URL;
const caCertificate = process.env.DATABASE_CA_CERT;

const pool = connectionString
  ? createPool({ connectionString, ...(caCertificate ? { caCertificate } : {}) })
  : undefined;

const options: AppOptions = {
  allowedOrigin,
  ...(pool
    ? {
        repositories: createPostgresRepositories(pool, nonceRetentionSeconds(REQUEST_FRESHNESS)),
        database: { probe: () => pingDatabase(pool) },
      }
    : {}),
};

createApp(options).listen(port, () => {
  const persistence = pool ? "postgres" : "in-memory, no database";
  console.log(`warrant api listening on http://localhost:${port} (${persistence})`);
});
