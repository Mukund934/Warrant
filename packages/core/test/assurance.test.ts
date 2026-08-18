import { describe, expect, it } from "vitest";
import {
  delegateMandate,
  issueRootMandate,
  signerFromJwk,
  unsignedPartOf,
  validateChain,
  verifyDetached,
} from "../src/index.js";
import type { IdentityAssurance, LegalPerson, Mandate, RevocationSnapshot } from "../src/index.js";
import { apAgentKey, ledgerKey, principalKey } from "../src/fixtures/keys.js";
import {
  TIMELINE,
  apAgent,
  organisation,
  paymentAgent,
  priyaSharma,
  rootScope,
} from "../src/fixtures/parties.js";
import { trustRoots } from "../src/fixtures/index.js";

const principalSigner = signerFromJwk(principalKey.keyId, principalKey.privateKeyJwk);
const apSigner = signerFromJwk(apAgentKey.keyId, apAgentKey.privateKeyJwk);
const recorder = signerFromJwk(ledgerKey.keyId, ledgerKey.privateKeyJwk);

const SERVICE_HELD: IdentityAssurance = {
  identity: "authenticated",
  keyCustody: "service",
  method: "OpenID Connect, email claim from the identity provider",
  assertedBy: "https://project.supabase.co/auth/v1",
  assertedAt: TIMELINE.rootIssuedAt,
};

async function emptyRevocation(): Promise<RevocationSnapshot> {
  const body = { asOf: TIMELINE.evaluatedAt, revoked: [] };
  const { signDetached } = await import("../src/sign.js");
  return { ...body, proof: await signDetached(body, recorder, body.asOf) };
}

async function rootWith(principal: LegalPerson): Promise<Mandate> {
  return issueRootMandate(
    {
      id: "mnd_root_assurance",
      organisation,
      liablePrincipal: principal,
      subject: apAgent,
      scope: rootScope,
      maxDelegationDepth: 2,
      notBefore: TIMELINE.rootNotBefore,
      expiresAt: TIMELINE.rootExpiresAt,
      issuedAt: TIMELINE.rootIssuedAt,
    },
    principalSigner,
  );
}

async function checksFor(chain: Mandate[]) {
  const report = await validateChain(chain, {
    trustRoots,
    now: TIMELINE.evaluatedAt,
    revocation: await emptyRevocation(),
  });
  return report.checks;
}

const find = (checks: Awaited<ReturnType<typeof checksFor>>, id: string) =>
  checks.find((check) => check.id === id);

describe("what a mandate says about how its accountable human was identified", () => {
  it("says nothing, and admits it, when no assurance was recorded", async () => {
    const checks = await checksFor([await rootWith(priyaSharma)]);
    const assurance = find(checks, "principal.assurance");

    expect(assurance?.status).toBe("skip");
    expect(assurance?.detail).toMatch(/records nothing about how Priya Sharma was identified/);
    expect(assurance?.detail).toMatch(/a claim by the issuer and no more/);
  });

  it("warns that the service holds the key, not the person it names", async () => {
    const checks = await checksFor([
      await rootWith({ ...priyaSharma, assurance: SERVICE_HELD }),
    ]);
    const assurance = find(checks, "principal.assurance");

    expect(assurance?.status).toBe("warn");
    expect(assurance?.detail).toMatch(/identity authenticated by OpenID Connect/);
    expect(assurance?.detail).toMatch(/signing key is held by the service rather than by Priya Sharma/);
    expect(assurance?.detail).toMatch(/no external register was cited/);
  });

  it("passes only when the accountable person holds the signing key", async () => {
    const checks = await checksFor([
      await rootWith({
        ...priyaSharma,
        assurance: { ...SERVICE_HELD, keyCustody: "principal" },
      }),
    ]);

    expect(find(checks, "principal.assurance")?.status).toBe("pass");
  });

  it("reports an external register when one was cited", async () => {
    const checks = await checksFor([
      await rootWith({
        ...priyaSharma,
        assurance: {
          ...SERVICE_HELD,
          identity: "registry-verified",
          reference: { scheme: "sec-edgar-cik", value: "0000320193" },
        },
      }),
    ]);

    expect(find(checks, "principal.assurance")?.detail).toMatch(/sec-edgar-cik 0000320193/);
  });

  it("never changes the verdict, whatever it says", async () => {
    const withoutAssurance = await checksFor([await rootWith(priyaSharma)]);
    const withAssurance = await checksFor([
      await rootWith({ ...priyaSharma, assurance: SERVICE_HELD }),
    ]);

    const failing = (checks: Awaited<ReturnType<typeof checksFor>>) =>
      checks.filter((check) => check.status === "fail");

    expect(failing(withoutAssurance)).toEqual([]);
    expect(failing(withAssurance)).toEqual([]);
  });
});

describe("the assurance is part of the signed mandate, not a label attached afterwards", () => {
  it("is covered by the issuer signature", async () => {
    const mandate = await rootWith({ ...priyaSharma, assurance: SERVICE_HELD });

    const intact = await verifyDetached(
      unsignedPartOf(mandate),
      mandate.proof,
      principalKey.publicKeyJwk,
    );
    expect(intact.valid).toBe(true);

    const upgraded: Mandate = {
      ...mandate,
      liablePrincipal: {
        ...mandate.liablePrincipal,
        assurance: { ...SERVICE_HELD, keyCustody: "principal", identity: "registry-verified" },
      },
    };

    const tampered = await verifyDetached(
      unsignedPartOf(upgraded),
      upgraded.proof,
      principalKey.publicKeyJwk,
    );
    expect(tampered.valid).toBe(false);
  });
});

describe("a delegation cannot restate the accountable human", () => {
  it("copies the principal down the chain untouched", async () => {
    const root = await rootWith({ ...priyaSharma, assurance: SERVICE_HELD });
    const child = await delegateMandate(
      {
        id: "mnd_child_assurance",
        parent: root,
        subject: paymentAgent,
        scopeDelta: { actions: ["payment.execute"] },
        notBefore: root.notBefore,
        expiresAt: root.expiresAt,
        issuedAt: TIMELINE.delegatedIssuedAt,
      },
      apSigner,
    );

    expect(child.liablePrincipal).toEqual(root.liablePrincipal);
    expect(find(await checksFor([root, child]), "chain.liable_principal")?.status).toBe("pass");
  });

  it("refuses a hop that keeps the identity but strengthens the claim", async () => {
    const root = await rootWith({ ...priyaSharma, assurance: SERVICE_HELD });
    const child = await delegateMandate(
      {
        id: "mnd_child_upgraded",
        parent: root,
        subject: paymentAgent,
        scopeDelta: { actions: ["payment.execute"] },
        notBefore: root.notBefore,
        expiresAt: root.expiresAt,
        issuedAt: TIMELINE.delegatedIssuedAt,
      },
      apSigner,
    );

    const forged: Mandate = {
      ...child,
      liablePrincipal: {
        ...child.liablePrincipal,
        assurance: {
          ...SERVICE_HELD,
          identity: "registry-verified",
          keyCustody: "principal",
          reference: { scheme: "sec-edgar-cik", value: "0000320193" },
        },
      },
    };

    const checks = await checksFor([root, forged]);
    const invariance = find(checks, "chain.liable_principal");

    expect(invariance?.status).toBe("fail");
    expect(invariance?.detail).toMatch(/restates the same person with different particulars/);
  });

  it("still refuses a hop that names a different person outright", async () => {
    const root = await rootWith(priyaSharma);
    const child = await delegateMandate(
      {
        id: "mnd_child_swapped",
        parent: root,
        subject: paymentAgent,
        scopeDelta: { actions: ["payment.execute"] },
        notBefore: root.notBefore,
        expiresAt: root.expiresAt,
        issuedAt: TIMELINE.delegatedIssuedAt,
      },
      apSigner,
    );

    const forged: Mandate = {
      ...child,
      liablePrincipal: { ...child.liablePrincipal, id: "person:someone-else" },
    };

    const invariance = find(await checksFor([root, forged]), "chain.liable_principal");
    expect(invariance?.status).toBe("fail");
    expect(invariance?.detail).toMatch(/names a different accountable person/);
  });
});
