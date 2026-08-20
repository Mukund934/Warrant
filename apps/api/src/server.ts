import { geminiProvider } from "./assistant/gemini.js";
import { createApp } from "./app.js";
import type { AppOptions } from "./app.js";
import { supabaseTokenVerifier } from "./auth/principal.js";
import type { AuthMode, TokenVerifier } from "./auth/principal.js";
import {
  createPool,
  createPostgresRepositories,
  nonceRetentionSeconds,
  pingDatabase,
} from "./persistence/postgres.js";
import type { AssistantOptions } from "./routes/assistant.js";
import { REQUEST_FRESHNESS } from "./warrant/context.js";

const port = Number(process.env.PORT ?? 4000);
const allowedOrigin = process.env.WARRANT_ALLOWED_ORIGIN ?? "*";
const connectionString = process.env.DATABASE_URL;
const caCertificate = process.env.DATABASE_CA_CERT;
const projectUrl = process.env.SUPABASE_URL;

const declaredMode = process.env.WARRANT_AUTH_MODE;
if (declaredMode !== undefined && declaredMode !== "open" && declaredMode !== "required") {
  console.error(`warrant api: WARRANT_AUTH_MODE must be "open" or "required", not "${declaredMode}"`);
  process.exit(2);
}
const mode: AuthMode = declaredMode ?? "open";

let verifier: TokenVerifier | undefined;
if (projectUrl) {
  verifier = supabaseTokenVerifier(projectUrl);
}

if (mode === "required" && !verifier) {
  console.error("warrant api: WARRANT_AUTH_MODE=required needs SUPABASE_URL so tokens can be checked");
  process.exit(2);
}

// Absent means the advisory layer is switched off, and that is a supported deployment rather than
// a broken one: the gate, the evidence plane and offline verification never consult it.
const geminiKey = process.env.GEMINI_API_KEY;
const geminiModel = process.env.GEMINI_MODEL;
const assistant: AssistantOptions = geminiKey
  ? { provider: geminiProvider({ apiKey: geminiKey, ...(geminiModel ? { model: geminiModel } : {}) }) }
  : {};

const pool = connectionString
  ? createPool({ connectionString, ...(caCertificate ? { caCertificate } : {}) })
  : undefined;

const options: AppOptions = {
  allowedOrigin,
  auth: { mode, ...(verifier ? { verifier } : {}) },
  assistant,
  ...(pool
    ? {
        repositories: createPostgresRepositories(pool, nonceRetentionSeconds(REQUEST_FRESHNESS)),
        database: { probe: () => pingDatabase(pool) },
      }
    : {}),
};

createApp(options).listen(port, () => {
  const persistence = pool ? "postgres" : "in-memory, no database";
  console.log(`warrant api listening on http://localhost:${port} (${persistence}, auth ${mode})`);
  console.log(
    assistant.provider
      ? `warrant api: assistant enabled (${assistant.provider.id}/${assistant.provider.model}), advisory only`
      : "warrant api: assistant disabled (no GEMINI_API_KEY); every other endpoint is unaffected",
  );
  if (mode === "open") {
    console.warn("warrant api: authority endpoints accept unauthenticated callers (WARRANT_AUTH_MODE=open)");
  }
});
