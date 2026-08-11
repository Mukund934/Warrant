import { CompactSign, compactVerify, decodeProtectedHeader } from "jose";
import { canonicalBytes, encodeBase64Url } from "./canonical.js";
import { importPrivateKey, importPublicKey, SIGNING_ALG } from "./keys.js";
import type { PrivateKeyJwk, PublicKeyJwk } from "./keys.js";
import type { Proof } from "./types.js";

const PROOF_TYP = "warrant-proof+jws";

export interface SignerIdentity {
  keyId: string;
  privateKeyJwk: PrivateKeyJwk;
}

function secondsOf(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

export async function signDetached(
  document: unknown,
  signer: SignerIdentity,
  createdAt: string,
): Promise<Proof> {
  const key = await importPrivateKey(signer.privateKeyJwk);
  const compact = await new CompactSign(canonicalBytes(document))
    .setProtectedHeader({
      alg: SIGNING_ALG,
      typ: PROOF_TYP,
      kid: signer.keyId,
      iat: secondsOf(createdAt),
    })
    .sign(key);

  const [header, , signature] = compact.split(".");
  if (!header || !signature) {
    throw new Error("signing produced a malformed JWS");
  }

  return {
    type: "JsonWebSignature2020",
    created: createdAt,
    verificationMethod: signer.keyId,
    alg: SIGNING_ALG,
    jws: `${header}..${signature}`,
  };
}

export interface ProofVerification {
  valid: boolean;
  reason?: string;
}

export async function verifyDetached(
  document: unknown,
  proof: Proof,
  publicKeyJwk: PublicKeyJwk,
): Promise<ProofVerification> {
  const [header, signature] = proof.jws.split("..");
  if (!header || !signature) {
    return { valid: false, reason: "proof is not a detached compact JWS" };
  }

  let protectedHeader;
  try {
    protectedHeader = decodeProtectedHeader(`${header}..${signature}`);
  } catch {
    return { valid: false, reason: "protected header is not decodable" };
  }

  if (protectedHeader.typ !== PROOF_TYP) {
    return { valid: false, reason: `unexpected proof type \`${String(protectedHeader.typ)}\`` };
  }
  if (protectedHeader.alg !== proof.alg) {
    return { valid: false, reason: "protected header algorithm does not match the proof" };
  }
  if (protectedHeader.kid !== proof.verificationMethod) {
    return { valid: false, reason: "protected header key id does not match the proof" };
  }
  if ((protectedHeader as { iat?: number }).iat !== secondsOf(proof.created)) {
    return { valid: false, reason: "signed timestamp does not match the stated creation time" };
  }

  const encodedPayload = encodeBase64Url(canonicalBytes(document));
  try {
    const key = await importPublicKey(publicKeyJwk);
    await compactVerify(`${header}.${encodedPayload}.${signature}`, key, {
      algorithms: [SIGNING_ALG],
    });
    return { valid: true };
  } catch {
    return { valid: false, reason: "signature does not verify over the canonical document" };
  }
}
