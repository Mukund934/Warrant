import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";

export type AuthMode = "open" | "required";

export interface Principal {
  subject: string;
  issuer: string;
  email?: string;
  sessionId?: string;
  expiresAt: string;
}

export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export interface TokenVerifier {
  readonly issuer: string;
  verify(token: string): Promise<Principal>;
}

export interface TokenVerifierOptions {
  issuer: string;
  audience: string;
  keys: JWTVerifyGetKey;
}

const ACCEPTED_ALGORITHMS = ["ES256"];

function principalFrom(payload: JWTPayload, issuer: string): Principal {
  if (typeof payload.sub !== "string" || payload.sub.length === 0) {
    throw new AuthenticationError("the token carries no subject, so it identifies nobody");
  }
  if (typeof payload.exp !== "number") {
    throw new AuthenticationError("the token carries no expiry, so it never stops being valid");
  }

  const email = typeof payload.email === "string" ? payload.email : undefined;
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : undefined;

  return {
    subject: payload.sub,
    issuer,
    ...(email ? { email } : {}),
    ...(sessionId ? { sessionId } : {}),
    expiresAt: new Date(payload.exp * 1000).toISOString().replace(/\.\d+Z$/, "Z"),
  };
}

export function tokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  return {
    issuer: options.issuer,
    async verify(token: string): Promise<Principal> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, options.keys, {
          issuer: options.issuer,
          audience: options.audience,
          algorithms: ACCEPTED_ALGORITHMS,
        }));
      } catch (error) {
        throw new AuthenticationError(`the access token was refused: ${(error as Error).message}`);
      }
      return principalFrom(payload, options.issuer);
    },
  };
}

export function supabaseIssuer(projectUrl: string): string {
  return `${projectUrl.replace(/\/+$/, "")}/auth/v1`;
}

export function supabaseTokenVerifier(projectUrl: string): TokenVerifier {
  const issuer = supabaseIssuer(projectUrl);
  return tokenVerifier({
    issuer,
    audience: "authenticated",
    keys: createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)),
  });
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}
