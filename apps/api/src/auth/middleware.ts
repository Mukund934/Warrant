import type { NextFunction, Request, RequestHandler, Response } from "express";
import { HttpError } from "../http/errors.js";
import { AuthenticationError, bearerToken } from "./principal.js";
import type { AuthMode, Principal, TokenVerifier } from "./principal.js";

export interface AuthOptions {
  mode: AuthMode;
  verifier?: TokenVerifier;
}

declare module "express-serve-static-core" {
  interface Request {
    principal?: Principal;
  }
}

const unauthenticated = (message: string) => new HttpError(401, "unauthenticated", message);

export class AuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigurationError";
  }
}

export function assertCoherent(options: AuthOptions): void {
  if (options.mode === "required" && !options.verifier) {
    throw new AuthConfigurationError(
      "auth mode is 'required' but no token verifier is configured; refusing to start rather than accept every caller",
    );
  }
}

export function identify(options: AuthOptions): RequestHandler {
  return async (request: Request, response: Response, next: NextFunction) => {
    const token = bearerToken(request.header("authorization"));
    if (!token) {
      next();
      return;
    }

    if (!options.verifier) {
      response.set("www-authenticate", "Bearer");
      next(
        unauthenticated(
          "this deployment accepts no bearer tokens, so a token cannot be checked and will not be assumed valid",
        ),
      );
      return;
    }

    try {
      request.principal = await options.verifier.verify(token);
      next();
    } catch (error) {
      response.set("www-authenticate", 'Bearer error="invalid_token"');
      next(
        error instanceof AuthenticationError
          ? unauthenticated(error.message)
          : unauthenticated("the access token could not be checked"),
      );
    }
  };
}

export function requirePrincipal(options: AuthOptions): RequestHandler {
  return (request: Request, response: Response, next: NextFunction) => {
    if (options.mode === "open" || request.principal) {
      next();
      return;
    }

    response.set("www-authenticate", "Bearer");
    next(unauthenticated("this endpoint changes recorded authority and requires an authenticated caller"));
  };
}
