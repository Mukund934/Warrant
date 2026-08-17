import { compactVerify, decodeProtectedHeader } from "jose";
import { canonicalBytes, encodeBase64Url } from "./canonical.js";
import { importPrivateKey, importPublicKey, SIGNING_ALG } from "./keys.js";
import type { PrivateKeyJwk, PublicKeyJwk } from "./keys.js";
import { WarrantError } from "./types.js";
import type { Proof } from "./types.js";

const PROOF_TYP = "warrant-proof+jws";
const ECDSA_SHA256 = { name: "ECDSA", hash: "SHA-256" } as const;

export interface SignerIdentity {
  keyId: string;
  sign(signingInput: Uint8Array): Promise<Uint8Array>;
}

export function signerFromJwk(keyId: string, privateKeyJwk: PrivateKeyJwk): SignerIdentity {
  let imported: Promise<CryptoKey> | undefined;
  return {
    keyId,
    async sign(signingInput) {
      imported ??= importPrivateKey(privateKeyJwk).then((key) => {
        if (!(key instanceof CryptoKey)) {
          throw new WarrantError("keys/not_signable", "the private JWK did not import as a signing key");
        }
        return key;
      });
      const input = Uint8Array.from(signingInput);
      return new Uint8Array(await crypto.subtle.sign(ECDSA_SHA256, await imported, input));
    },
  };
}

function secondsOf(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

export async function signDetached(
  document: unknown,
  signer: SignerIdentity,
  createdAt: string,
): Promise<Proof> {
  const header = encodeBase64Url(
    canonicalBytes({
      alg: SIGNING_ALG,
      typ: PROOF_TYP,
      kid: signer.keyId,
      iat: secondsOf(createdAt),
    }),
  );
  const payload = encodeBase64Url(canonicalBytes(document));
  const signature = await signer.sign(new TextEncoder().encode(`${header}.${payload}`));

  if (signature.length !== 64) {
    throw new WarrantError(
      "sign/malformed_signature",
      `ES256 requires a 64-byte raw R‖S signature; the signer returned ${signature.length} bytes`,
    );
  }

  return {
    type: "JsonWebSignature2020",
    created: createdAt,
    verificationMethod: signer.keyId,
    alg: SIGNING_ALG,
    jws: `${header}..${encodeBase64Url(signature)}`,
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
