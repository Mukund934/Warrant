import { describe, expect, it } from "vitest";
import {
  DelegationError,
  WarrantError,
  delegateMandate,
  issueRootMandate,
  mandateDigest,
  unsignedPartOf,
  verifyDetached,
} from "../src/index.js";
import type { Mandate } from "../src/index.js";
import { apAgentKey, payAgentKey, principalKey } from "../src/fixtures/keys.js";
import {
  KALYANI,
  TIMELINE,
  apAgent,
  inr,
  organisation,
  paymentAgent,
  priyaSharma,
  rootScope,
} from "../src/fixtures/parties.js";

const principalSigner = { keyId: principalKey.keyId, privateKeyJwk: principalKey.privateKeyJwk };
const apSigner = { keyId: apAgentKey.keyId, privateKeyJwk: apAgentKey.privateKeyJwk };
const paySigner = { keyId: payAgentKey.keyId, privateKeyJwk: payAgentKey.privateKeyJwk };

async function root(overrides: Partial<Parameters<typeof issueRootMandate>[0]> = {}) {
  return issueRootMandate(
    {
      id: "mnd_root_test",
      organisation,
      liablePrincipal: priyaSharma,
      subject: apAgent,
      scope: rootScope,
      maxDelegationDepth: 2,
      notBefore: TIMELINE.rootNotBefore,
      expiresAt: TIMELINE.rootExpiresAt,
      issuedAt: TIMELINE.rootIssuedAt,
      ...overrides,
    },
    principalSigner,
  );
}

describe("root mandate issuance", () => {
  it("produces a mandate whose signature verifies against the principal key", async () => {
    const mandate = await root();
    const outcome = await verifyDetached(
      unsignedPartOf(mandate),
      mandate.proof,
      principalKey.publicKeyJwk,
    );
    expect(outcome.valid).toBe(true);
    expect(mandate.depth).toBe(0);
    expect(mandate.parent).toBeNull();
    expect(mandate.issuer).toEqual(priyaSharma);
  });

  it("refuses to be signed by a key that is not the liable principal's", async () => {
    await expect(
      issueRootMandate(
        {
          id: "mnd_root_bad",
          organisation,
          liablePrincipal: priyaSharma,
          subject: apAgent,
          scope: rootScope,
          maxDelegationDepth: 2,
          notBefore: TIMELINE.rootNotBefore,
          expiresAt: TIMELINE.rootExpiresAt,
          issuedAt: TIMELINE.rootIssuedAt,
        },
        apSigner,
      ),
    ).rejects.toThrow(WarrantError);
  });

  it("refuses a validity window that ends before it starts", async () => {
    await expect(root({ expiresAt: TIMELINE.rootNotBefore })).rejects.toThrow(/expire after/);
  });

  it("refuses an empty scope", async () => {
    await expect(root({ scope: { ...rootScope, actions: [] } })).rejects.toThrow(/at least one action/);
  });

  it("detects any alteration after signing", async () => {
    const mandate = await root();
    const tampered: Mandate = structuredClone(mandate);
    tampered.scope.limits.perAction = inr(9_000_000);
    const outcome = await verifyDetached(
      unsignedPartOf(tampered),
      tampered.proof,
      principalKey.publicKeyJwk,
    );
    expect(outcome.valid).toBe(false);
  });
});

describe("delegation", () => {
  it("issues a narrower mandate bound to the exact parent", async () => {
    const parent = await root();
    const child = await delegateMandate(
      {
        id: "mnd_dlg_test",
        parent,
        subject: paymentAgent,
        scopeDelta: { actions: ["payment.execute"], limits: { perAction: inr(200_000) } },
        notBefore: parent.notBefore,
        expiresAt: parent.expiresAt,
        issuedAt: TIMELINE.delegatedIssuedAt,
      },
      apSigner,
    );

    expect(child.depth).toBe(1);
    expect(child.parent?.digest).toBe(await mandateDigest(parent));
    expect(child.liablePrincipal).toEqual(priyaSharma);
    expect(child.scope.counterparties).toEqual(parent.scope.counterparties);
    expect(child.scope.limits.perPeriod).toEqual(parent.scope.limits.perPeriod);
  });

  it("refuses a delegation that claims more than the parent holds", async () => {
    const parent = await root();
    await expect(
      delegateMandate(
        {
          id: "mnd_dlg_escalating",
          parent,
          subject: paymentAgent,
          scopeDelta: { limits: { perAction: inr(8_000_000) } },
          notBefore: parent.notBefore,
          expiresAt: parent.expiresAt,
          issuedAt: TIMELINE.delegatedIssuedAt,
        },
        apSigner,
      ),
    ).rejects.toThrow(DelegationError);
  });

  it("reports exactly which constraint the delegation would have widened", async () => {
    const parent = await root();
    try {
      await delegateMandate(
        {
          id: "mnd_dlg_escalating",
          parent,
          subject: paymentAgent,
          scopeDelta: { counterparties: { allow: [KALYANI, "Vantage Global Trading FZE"] } },
          notBefore: parent.notBefore,
          expiresAt: parent.expiresAt,
          issuedAt: TIMELINE.delegatedIssuedAt,
        },
        apSigner,
      );
      expect.unreachable("delegation should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(DelegationError);
      expect((error as DelegationError).violations[0]?.code).toBe("scope/counterparty_not_delegable");
    }
  });

  it("refuses a delegation that outlives its parent", async () => {
    const parent = await root();
    await expect(
      delegateMandate(
        {
          id: "mnd_dlg_long",
          parent,
          subject: paymentAgent,
          scopeDelta: {},
          notBefore: parent.notBefore,
          expiresAt: "2027-01-01T00:00:00Z",
          issuedAt: TIMELINE.delegatedIssuedAt,
        },
        apSigner,
      ),
    ).rejects.toThrow(DelegationError);
  });

  it("refuses a delegation beyond the permitted depth", async () => {
    const parent = await root({ maxDelegationDepth: 0 });
    try {
      await delegateMandate(
        {
          id: "mnd_dlg_deep",
          parent,
          subject: paymentAgent,
          scopeDelta: {},
          notBefore: parent.notBefore,
          expiresAt: parent.expiresAt,
          issuedAt: TIMELINE.delegatedIssuedAt,
        },
        apSigner,
      );
      expect.unreachable("delegation should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(DelegationError);
      expect((error as DelegationError).violations.map((violation) => violation.code)).toContain(
        "scope/delegation_depth_exceeded",
      );
    }
  });

  it("refuses to let anyone but the holder delegate", async () => {
    const parent = await root();
    await expect(
      delegateMandate(
        {
          id: "mnd_dlg_wrong_signer",
          parent,
          subject: paymentAgent,
          scopeDelta: {},
          notBefore: parent.notBefore,
          expiresAt: parent.expiresAt,
          issuedAt: TIMELINE.delegatedIssuedAt,
        },
        paySigner,
      ),
    ).rejects.toThrow(/only the holder/);
  });
});
