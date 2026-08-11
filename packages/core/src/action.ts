import { withoutProof } from "./canonical.js";
import { signDetached, verifyDetached } from "./sign.js";
import type { ProofVerification, SignerIdentity } from "./sign.js";
import type { PublicKeyJwk } from "./keys.js";
import type { ActionRequest, UnsignedActionRequest } from "./types.js";

export async function signActionRequest(
  request: UnsignedActionRequest,
  signer: SignerIdentity,
): Promise<ActionRequest> {
  const proof = await signDetached(request, signer, request.requestedAt);
  return { ...request, proof };
}

export async function verifyActionRequest(
  request: ActionRequest,
  publicKeyJwk: PublicKeyJwk,
): Promise<ProofVerification> {
  return verifyDetached(withoutProof(request), request.proof, publicKeyJwk);
}
