import { calculateJwkThumbprint, exportJWK, generateKeyPair, importJWK } from "jose";
import type { JWK } from "jose";
import { WarrantError } from "./types.js";

export const SIGNING_ALG = "ES256" as const;

export interface PublicKeyJwk extends JWK {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface PrivateKeyJwk extends PublicKeyJwk {
  d: string;
}

export interface KeyPairRecord {
  keyId: string;
  subject: string;
  role: "principal" | "agent" | "gate" | "ledger";
  publicKeyJwk: PublicKeyJwk;
  privateKeyJwk: PrivateKeyJwk;
}

export function publicPartOf(jwk: PrivateKeyJwk | PublicKeyJwk): PublicKeyJwk {
  return { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y };
}

export async function thumbprintOf(jwk: PublicKeyJwk): Promise<string> {
  return calculateJwkThumbprint(publicPartOf(jwk), "sha256");
}

export async function createKeyPair(
  subject: string,
  role: KeyPairRecord["role"],
): Promise<KeyPairRecord> {
  const { privateKey, publicKey } = await generateKeyPair(SIGNING_ALG, { extractable: true });
  const privateKeyJwk = (await exportJWK(privateKey)) as PrivateKeyJwk;
  const publicKeyJwk = publicPartOf((await exportJWK(publicKey)) as PublicKeyJwk);
  const thumbprint = await thumbprintOf(publicKeyJwk);
  return {
    keyId: `key:${role}:${thumbprint.slice(0, 16)}`,
    subject,
    role,
    publicKeyJwk,
    privateKeyJwk: { ...privateKeyJwk, ...publicKeyJwk },
  };
}

export async function importPrivateKey(jwk: PrivateKeyJwk) {
  if (!jwk.d) {
    throw new WarrantError("keys/not_private", "expected a private JWK with a `d` parameter");
  }
  return importJWK({ ...jwk, alg: SIGNING_ALG }, SIGNING_ALG);
}

export async function importPublicKey(jwk: PublicKeyJwk) {
  if ((jwk as PrivateKeyJwk).d) {
    throw new WarrantError("keys/private_leak", "a private JWK was supplied where a public key is expected");
  }
  return importJWK({ ...publicPartOf(jwk), alg: SIGNING_ALG }, SIGNING_ALG);
}
