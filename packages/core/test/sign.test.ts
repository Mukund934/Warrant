import { describe, expect, it } from "vitest";
import {
  WarrantError,
  canonicalBytes,
  createKeyPair,
  decodeBase64Url,
  digestOf,
  encodeBase64Url,
  signDetached,
  signerFromJwk,
  verifyDetached,
} from "../src/index.js";
import type { Proof, SignerIdentity } from "../src/index.js";
import { importPrivateKey, thumbprintOf } from "../src/keys.js";
import type { KeyPairRecord } from "../src/keys.js";

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
        publicKeyJwk: pair.publicKeyJwk,
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

describe("the payload digest", () => {
  async function signed() {
    const pair = await createKeyPair("Digest", "gate");
    const proof = await signDetached(document, signerFromJwk(pair.keyId, pair.privateKeyJwk), createdAt);
    return { pair, proof };
  }

  function headerOf(proof: Proof): Record<string, unknown> {
    const [header] = proof.jws.split("..");
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(header!)));
  }

  it("states the digest of the document it signed", async () => {
    const { proof } = await signed();
    expect(proof.payloadDigest).toBe(await digestOf(document));
  });

  it("carries the digest inside the protected header, where the signature covers it", async () => {
    const { proof } = await signed();
    expect(headerOf(proof).payloadDigest).toBe(proof.payloadDigest);
  });

  it("names the digest mismatch instead of reporting a generic signature failure", async () => {
    const { pair, proof } = await signed();
    const tampered = { ...document, amount: { currency: "INR", minor: 999_999 } };
    const outcome = await verifyDetached(tampered, proof, pair.publicKeyJwk);
    expect(outcome.valid).toBe(false);
    expect(outcome.reason).toMatch(/payload digest/);
    expect(outcome.reason).toMatch(/sha256:/);
    expect(outcome.reason).not.toMatch(/does not verify over the canonical document/);
  });

  it("rejects a proof whose stated digest disagrees with the signed one", async () => {
    const { pair, proof } = await signed();
    const edited: Proof = { ...proof, payloadDigest: await digestOf({ different: true }) };
    const outcome = await verifyDetached(document, edited, pair.publicKeyJwk);
    expect(outcome.valid).toBe(false);
    expect(outcome.reason).toMatch(/does not match the signed one/);
  });

  it("rejects a digest the signature does not cover", async () => {
    const pair = await createKeyPair("Unsigned digest", "gate");
    const proof = await legacyProof(pair, document);
    const smuggled: Proof = { ...proof, payloadDigest: await digestOf(document) };
    const outcome = await verifyDetached(document, smuggled, pair.publicKeyJwk);
    expect(outcome.valid).toBe(false);
    expect(outcome.reason).toMatch(/does not cover/);
  });

  it("still verifies a proof issued before the digest existed", async () => {
    const pair = await createKeyPair("Legacy", "gate");
    const proof = await legacyProof(pair, document);
    expect(proof.payloadDigest).toBeUndefined();
    expect(await verifyDetached(document, proof, pair.publicKeyJwk)).toEqual({ valid: true });
  });
});

describe("the embedded public key", () => {
  function headerOf(proof: Proof): Record<string, unknown> {
    const [header] = proof.jws.split("..");
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(header!)));
  }

  async function reheader(proof: Proof, mutate: (h: Record<string, unknown>) => void): Promise<Proof> {
    const header = headerOf(proof);
    mutate(header);
    const [, signature] = proof.jws.split("..");
    return { ...proof, jws: `${encodeBase64Url(canonicalBytes(header))}..${signature}` };
  }

  it("carries the signer's public key so a verifier needs no network call", async () => {
    const pair = await createKeyPair("Embedded", "gate");
    const proof = await signDetached(document, signerFromJwk(pair.keyId, pair.privateKeyJwk), createdAt);
    expect(headerOf(proof).jwk).toEqual(pair.publicKeyJwk);
  });

  it("never carries private key material", async () => {
    const pair = await createKeyPair("No leak", "gate");
    const proof = await signDetached(document, signerFromJwk(pair.keyId, pair.privateKeyJwk), createdAt);
    expect(JSON.stringify(headerOf(proof).jwk)).not.toContain(pair.privateKeyJwk.d);
    expect((headerOf(proof).jwk as Record<string, unknown>).d).toBeUndefined();
  });

  it("refuses a proof whose embedded key is not the key it is checked against", async () => {
    const real = await createKeyPair("Real", "gate");
    const attacker = await createKeyPair("Attacker", "gate");
    const proof = await signDetached(document, signerFromJwk(real.keyId, real.privateKeyJwk), createdAt);
    const substituted = await reheader(proof, (h) => {
      h.jwk = attacker.publicKeyJwk;
    });

    const outcome = await verifyDetached(document, substituted, real.publicKeyJwk);
    expect(outcome.valid).toBe(false);
    expect(outcome.reason).toMatch(/not the key this proof was checked against/);
  });

  it("refuses a header that smuggles private key material", async () => {
    const pair = await createKeyPair("Smuggler", "gate");
    const proof = await signDetached(document, signerFromJwk(pair.keyId, pair.privateKeyJwk), createdAt);
    const leaky = await reheader(proof, (h) => {
      h.jwk = pair.privateKeyJwk;
    });

    const outcome = await verifyDetached(document, leaky, pair.publicKeyJwk);
    expect(outcome.valid).toBe(false);
    expect(outcome.reason).toMatch(/private key material/);
  });

  it("refuses a header whose embedded key is not a P-256 public JWK", async () => {
    const pair = await createKeyPair("Malformed", "gate");
    const proof = await signDetached(document, signerFromJwk(pair.keyId, pair.privateKeyJwk), createdAt);
    const malformed = await reheader(proof, (h) => {
      h.jwk = { kty: "EC", crv: "P-256" };
    });

    const outcome = await verifyDetached(document, malformed, pair.publicKeyJwk);
    expect(outcome.valid).toBe(false);
    expect(outcome.reason).toMatch(/not a P-256 public JWK/);
  });

  it("still verifies a proof from a signer that does not publish its public key", async () => {
    const pair = await createKeyPair("Opaque", "gate");
    const key = await importPrivateKey(pair.privateKeyJwk);
    const opaque: SignerIdentity = {
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
    };

    const proof = await signDetached(document, opaque, createdAt);
    expect(headerOf(proof).jwk).toBeUndefined();
    expect(await verifyDetached(document, proof, pair.publicKeyJwk)).toEqual({ valid: true });
  });
});

describe("the keys this project publishes", () => {
  it("never carries private material in a trust root", async () => {
    const { trustRoots } = await import("../src/fixtures/scenarios.js");
    expect(trustRoots.length).toBeGreaterThan(0);
    for (const root of trustRoots) {
      expect(root.publicKeyJwk).not.toHaveProperty("d");
      expect(root).not.toHaveProperty("privateKeyJwk");
    }
    expect(JSON.stringify(trustRoots)).not.toMatch(/"d"\s*:/);
  });

  it("gives every trust root a key id derived from its own thumbprint", async () => {
    const { trustRoots } = await import("../src/fixtures/scenarios.js");
    for (const root of trustRoots) {
      const thumbprint = await thumbprintOf(root.publicKeyJwk);
      expect(root.keyId).toContain(thumbprint.slice(0, 16));
    }
  });
});

async function legacyProof(pair: KeyPairRecord, doc: unknown): Promise<Proof> {
  const key = await importPrivateKey(pair.privateKeyJwk);
  const header = encodeBase64Url(
    canonicalBytes({
      alg: "ES256",
      typ: "warrant-proof+jws",
      kid: pair.keyId,
      iat: Math.floor(new Date(createdAt).getTime() / 1000),
    }),
  );
  const payload = encodeBase64Url(canonicalBytes(doc));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      key as CryptoKey,
      new TextEncoder().encode(`${header}.${payload}`),
    ),
  );
  return {
    type: "JsonWebSignature2020",
    created: createdAt,
    verificationMethod: pair.keyId,
    alg: "ES256",
    jws: `${header}..${encodeBase64Url(signature)}`,
  };
}
