import type { NextFunction, Request, Response } from "express";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);

export const notFound = (message: string) => new HttpError(404, "not_found", message);

export const unprocessable = (code: string, message: string, details?: unknown) =>
  new HttpError(422, code, message, details);

export function notFoundHandler(request: Request, response: Response): void {
  response.status(404).json({
    error: "not_found",
    message: `no route matches ${request.method} ${request.path}`,
  });
}

export function errorHandler(
  error: unknown,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  if (error instanceof HttpError) {
    response.status(error.status).json({
      error: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
    return;
  }

  if (error instanceof SyntaxError && "body" in error) {
    response.status(400).json({ error: "malformed_json", message: "the request body is not valid JSON" });
    return;
  }

  console.error("unhandled error", error);
  response.status(500).json({
    error: "internal_error",
    message: "the request could not be completed",
  });
}
