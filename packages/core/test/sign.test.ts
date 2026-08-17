import { describe, expect, it } from "vitest";
import { WarrantError, createKeyPair, signDetached, signerFromJwk, verifyDetached } from "../src/index.js";
import type { SignerIdentity } from "../src/index.js";
import { importPrivateKey } from "../src/keys.js";

const document = { action: "payment.execute", amount: { currency: "INR", minor: 420_000 } };
const createdAt = "2026-08-20T14:32:07Z";

describe("the signer seam", () => {
  it("verifies a proof from a signer that never exposes a private JWK", async () => {
    const pair = await createKeyPair("Remote signing service", "gate");
    const key = await importPrivateKey(pair.privateKeyJwk);

    const remote: SignerIdentity = {
      keyId: pair.keyId,
      async sign(signingInput) {
        const signature = await crypto.subtle.sign(
          { name: "ECDSA", hash: "SHA-256" },
          key as CryptoKey,
          Uint8Array.from(signingInput),
        );
        return new Uint8Array(signature);
      },
    };

    expect(remote).not.toHaveProperty("privateKeyJwk");

    const proof = await signDetached(document, remote, createdAt);
    expect(await verifyDetached(document, proof, pair.publicKeyJwk)).toEqual({ valid: true });
  });

  it("produces byte-identical proofs from the convenience constructor and a hand-built signer", async () => {
    const pair = await createKeyPair("Comparison", "gate");
    const convenient = await signDetached(document, signerFromJwk(pair.keyId, pair.privateKeyJwk), createdAt);
    const key = await importPrivateKey(pair.privateKeyJwk);
    const manual = await signDetached(
      document,
      {
        keyId: pair.keyId,
        async sign(signingInput) {
          return new Uint8Array(
            await crypto.subtle.sign(
              { name: "ECDSA", hash: "SHA-256" },
              key as CryptoKey,
              Uint8Array.from(signingInput),
            ),
          );
        },
      },
      createdAt,
    );

    expect(manual.jws.split("..")[0]).toBe(convenient.jws.split("..")[0]);
    expect(await verifyDetached(document, manual, pair.publicKeyJwk)).toEqual({ valid: true });
    expect(await verifyDetached(document, convenient, pair.publicKeyJwk)).toEqual({ valid: true });
  });

  it("rejects a signer returning a DER signature rather than raw R‖S", async () => {
    const der: SignerIdentity = {
      keyId: "key:gate:der",
      async sign() {
        return new Uint8Array(70);
      },
    };
    await expect(signDetached(document, der, createdAt)).rejects.toThrow(WarrantError);
    await expect(signDetached(document, der, createdAt)).rejects.toThrow(/64-byte raw/);
  });

  it("refuses a public JWK where a signing key is required", async () => {
    const pair = await createKeyPair("Public only", "gate");
    const signer = signerFromJwk(pair.keyId, pair.publicKeyJwk as never);
    await expect(signDetached(document, signer, createdAt)).rejects.toThrow(WarrantError);
  });

  it("fails verification when the document changes after signing", async () => {
    const pair = await createKeyPair("Tamper", "gate");
    const proof = await signDetached(document, signerFromJwk(pair.keyId, pair.privateKeyJwk), createdAt);
    const tampered = { ...document, amount: { currency: "INR", minor: 999_999 } };
    const outcome = await verifyDetached(tampered, proof, pair.publicKeyJwk);
    expect(outcome.valid).toBe(false);
  });
});
