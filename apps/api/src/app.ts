import express from "express";
import type { Express } from "express";
import { errorHandler, notFoundHandler } from "./http/errors.js";
import { rateLimit } from "./http/rate-limit.js";
import { createInMemoryRepositories } from "./persistence/memory.js";
import type { Repositories } from "./persistence/types.js";
import { authorityRoutes } from "./routes/authority.js";
import { catalogueRoutes } from "./routes/catalogue.js";

export interface AppOptions {
  repositories?: Repositories;
  allowedOrigin?: string;
}

export function createApp(options: AppOptions = {}): Express {
  const repositories = options.repositories ?? createInMemoryRepositories();
  const allowedOrigin = options.allowedOrigin ?? "*";

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use(express.json({ limit: "512kb" }));

  app.use((_request, response, next) => {
    response.set("x-content-type-options", "nosniff");
    response.set("access-control-allow-origin", allowedOrigin);
    response.set("access-control-allow-headers", "content-type");
    response.set("access-control-allow-methods", "GET,POST,OPTIONS");
    next();
  });

  app.options(/.*/, (_request, response) => {
    response.status(204).end();
  });

  app.get("/health", (_request, response) => {
    response.json({
      status: "ok",
      persistence: "in-memory",
      database: false,
      replayScope: repositories.nonces.scope,
    });
  });

  app.use("/v1", rateLimit({ windowMs: 60_000, max: 240 }));
  app.use("/v1", catalogueRoutes(repositories));
  app.use("/v1", authorityRoutes(repositories));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
