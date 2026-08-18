import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { CryptoKey, JWK } from "jose";
import { tokenVerifier } from "../../src/auth/principal.js";
import type { TokenVerifier } from "../../src/auth/principal.js";

export const TEST_ISSUER = "https://project.supabase.co/auth/v1";

export interface TestIdentity {
  verifier: TokenVerifier;
  mint(subject: string, email?: string): Promise<string>;
}

export async function testIdentity(): Promise<TestIdentity> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = (await exportJWK(publicKey)) as JWK;

  const verifier = tokenVerifier({
    issuer: TEST_ISSUER,
    audience: "authenticated",
    keys: createLocalJWKSet({ keys: [{ ...publicJwk, alg: "ES256", use: "sig", kid: "test" }] }),
  });

  return {
    verifier,
    async mint(subject: string, email?: string): Promise<string> {
      return new SignJWT(email ? { email } : {})
        .setProtectedHeader({ alg: "ES256", kid: "test" })
        .setIssuer(TEST_ISSUER)
        .setAudience("authenticated")
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime("1h")
        .sign(privateKey as CryptoKey);
    },
  };
}
