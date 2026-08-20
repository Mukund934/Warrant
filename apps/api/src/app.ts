import express from "express";
import type { Express } from "express";
import { assertCoherent, identify, requirePrincipal } from "./auth/middleware.js";
import type { AuthOptions } from "./auth/middleware.js";
import { requireTenant, resolveTenant, writesNeed } from "./auth/tenancy.js";
import { errorHandler, notFoundHandler } from "./http/errors.js";
import { rateLimit } from "./http/rate-limit.js";
import { createInMemoryRepositories } from "./persistence/memory.js";
import type { Repositories } from "./persistence/types.js";
import { agentRoutes } from "./routes/agents.js";
import { assistantRoutes } from "./routes/assistant.js";
import type { AssistantOptions } from "./routes/assistant.js";
import { authorityRoutes } from "./routes/authority.js";
import { capabilityRoutes } from "./routes/capabilities.js";
import { catalogueRoutes } from "./routes/catalogue.js";
import { directoryRoutes } from "./routes/directory.js";
import { searchRoutes } from "./routes/search.js";

export const AUTHORITY_PATHS = ["/v1/mandates", "/v1/actions", "/v1/checkpoint", "/v1/pending"];
// A simulation records nothing, so it needs a tenant but not a write role. An auditor may ask.
export const SIMULATION_PATHS = ["/v1/simulations", "/v1/reconstructions"];
// Fetching one pack by its unguessable id stays open, because evidence is meant to be handed to a
// relying party. Enumerating evidence is a different act and needs a tenant.
export const SEARCH_PATHS = ["/v1/search", "/v1/replays", "/v1/statements"];
// The assistant reads evidence, so it needs a tenant. It writes nothing and records nothing, so
// it needs no write role: an auditor may ask it questions.
export const ASSISTANT_PATHS = ["/v1/assistant"];
export const DIRECTORY_PATHS = [
  "/v1/organisations",
  "/v1/agents",
  "/v1/capabilities",
  "/v1/house-scope",
];
export const PROTECTED_PATHS = [
  ...AUTHORITY_PATHS,
  ...DIRECTORY_PATHS,
  ...SIMULATION_PATHS,
  ...SEARCH_PATHS,
  ...ASSISTANT_PATHS,
];

export interface DatabaseProbe {
  probe(): Promise<boolean>;
}

export interface AppOptions {
  repositories?: Repositories;
  allowedOrigin?: string;
  database?: DatabaseProbe;
  auth?: AuthOptions;
  assistant?: AssistantOptions;
}

export function createApp(options: AppOptions = {}): Express {
  const repositories = options.repositories ?? createInMemoryRepositories();
  const allowedOrigin = options.allowedOrigin ?? "*";
  const database = options.database;
  const auth: AuthOptions = options.auth ?? { mode: "open" };
  const assistant: AssistantOptions = options.assistant ?? {};

  assertCoherent(auth);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(express.json({ limit: "512kb" }));

  app.use((_request, response, next) => {
    response.set("x-content-type-options", "nosniff");
    response.set("access-control-allow-origin", allowedOrigin);
    response.set(
      "access-control-allow-headers",
      "content-type,authorization,x-warrant-organisation",
    );
    response.set("access-control-allow-methods", "GET,POST,OPTIONS");
    next();
  });

  app.options(/.*/, (_request, response) => {
    response.status(204).end();
  });

  app.get("/health", async (_request, response) => {
    const reachable = database ? await database.probe() : false;
    const healthy = database ? reachable : true;

    response.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "degraded",
      persistence: database ? "postgres" : "in-memory",
      database: Boolean(database),
      databaseReachable: reachable,
      replayScope: repositories.nonces.scope,
      auth: auth.mode,
      authIssuer: auth.verifier ? auth.verifier.issuer : null,
      // Declared rather than discovered, for the same reason `auth` is (D31). A reader can see
      // that the advisory layer is off without being able to tell from any other endpoint - which
      // is itself the §13a claim: nothing else changes when it is.
      assistant: assistant.provider ? assistant.provider.id : null,
    });
  });

  app.use("/v1", rateLimit({ windowMs: 60_000, max: 240 }));
  app.use("/v1", identify(auth), resolveTenant(repositories));
  app.use("/v1", catalogueRoutes(repositories));

  app.use(DIRECTORY_PATHS, requirePrincipal(auth));
  app.use(AUTHORITY_PATHS, requirePrincipal(auth), requireTenant(), writesNeed("member"));
  app.use(SIMULATION_PATHS, requirePrincipal(auth), requireTenant());
  app.use(SEARCH_PATHS, requirePrincipal(auth), requireTenant());
  app.use(ASSISTANT_PATHS, requirePrincipal(auth), requireTenant());

  app.use("/v1", directoryRoutes(repositories));
  app.use("/v1", agentRoutes(repositories));
  app.use("/v1", capabilityRoutes(repositories));
  app.use("/v1", authorityRoutes(repositories));
  app.use("/v1", searchRoutes(repositories));
  app.use("/v1", assistantRoutes(repositories, assistant));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
