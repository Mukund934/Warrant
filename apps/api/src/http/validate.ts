import type { ZodType } from "zod";
import { badRequest } from "./errors.js";

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const outcome = schema.safeParse(body);
  if (!outcome.success) {
    throw badRequest(
      "invalid_request",
      "the request body does not match this endpoint",
      outcome.error.issues.map((issue) => ({
        path: issue.path.join(".") || "(root)",
        message: issue.message,
      })),
    );
  }
  return outcome.data;
}
