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
import { authorityRoutes } from "./routes/authority.js";
import { capabilityRoutes } from "./routes/capabilities.js";
import { catalogueRoutes } from "./routes/catalogue.js";
import { directoryRoutes } from "./routes/directory.js";

export const AUTHORITY_PATHS = ["/v1/mandates", "/v1/actions", "/v1/checkpoint"];
export const DIRECTORY_PATHS = [
  "/v1/organisations",
  "/v1/agents",
  "/v1/capabilities",
  "/v1/house-scope",
];
export const PROTECTED_PATHS = [...AUTHORITY_PATHS, ...DIRECTORY_PATHS];

export interface DatabaseProbe {
  probe(): Promise<boolean>;
}

export interface AppOptions {
  repositories?: Repositories;
  allowedOrigin?: string;
  database?: DatabaseProbe;
  auth?: AuthOptions;
}

export function createApp(options: AppOptions = {}): Express {
  const repositories = options.repositories ?? createInMemoryRepositories();
  const allowedOrigin = options.allowedOrigin ?? "*";
  const database = options.database;
  const auth: AuthOptions = options.auth ?? { mode: "open" };

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
    });
  });

  app.use("/v1", rateLimit({ windowMs: 60_000, max: 240 }));
  app.use("/v1", identify(auth), resolveTenant(repositories));
  app.use("/v1", catalogueRoutes(repositories));

  app.use(DIRECTORY_PATHS, requirePrincipal(auth));
  app.use(AUTHORITY_PATHS, requirePrincipal(auth), requireTenant(), writesNeed("member"));

  app.use("/v1", directoryRoutes(repositories));
  app.use("/v1", agentRoutes(repositories));
  app.use("/v1", capabilityRoutes(repositories));
  app.use("/v1", authorityRoutes(repositories));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
