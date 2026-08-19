import { describe, expect, it } from "vitest";
import {
  DelegationError,
  assess,
  delegateMandate,
  effectiveScope,
  issueRootMandate,
  meet,
  narrows,
  resolveDelta,
  signActionRequest,
  signDetached,
  signerFromJwk,
} from "../src/index.js";
import type { Mandate, RevocationSnapshot, Scope } from "../src/index.js";
import { apAgentKey, ledgerKey, payAgentKey, principalKey } from "../src/fixtures/keys.js";
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
import { trustRoots } from "../src/fixtures/index.js";

const principalSigner = signerFromJwk(principalKey.keyId, principalKey.privateKeyJwk);
const apSigner = signerFromJwk(apAgentKey.keyId, apAgentKey.privateKeyJwk);
const paySigner = signerFromJwk(payAgentKey.keyId, payAgentKey.privateKeyJwk);
const recorder = signerFromJwk(ledgerKey.keyId, ledgerKey.privateKeyJwk);

const ERP = rootScope.audience[0]!;

const withApproval = (above: number): Scope => ({
  ...rootScope,
  approval: { above: inr(above) },
});

async function emptyRevocation(): Promise<RevocationSnapshot> {
  const body = { asOf: TIMELINE.evaluatedAt, revoked: [] };
  return { ...body, proof: await signDetached(body, recorder, body.asOf) };
}

async function root(scope: Scope): Promise<Mandate> {
  return issueRootMandate(
    {
      id: "mnd_root_approval",
      organisation,
      liablePrincipal: priyaSharma,
      subject: apAgent,
      scope,
      maxDelegationDepth: 2,
      notBefore: TIMELINE.rootNotBefore,
      expiresAt: TIMELINE.rootExpiresAt,
      issuedAt: TIMELINE.rootIssuedAt,
    },
    principalSigner,
  );
}

async function decide(chain: Mandate[], amount: number, escalationThreshold?: ReturnType<typeof inr>) {
  const leaf = chain[chain.length - 1]!;
  const signer = leaf.subject.keyId === apAgentKey.keyId ? apSigner : paySigner;

  const request = await signActionRequest(
    {
      id: "req_approval",
      nonce: `nonce-approval-${amount}-${chain.length}`,
      actor: leaf.subject.id,
      action: "payment.execute",
      resource: ERP,
      counterparty: KALYANI,
      description: "Invoice settlement",
      requestedAt: TIMELINE.evaluatedAt,
      amount: inr(amount),
    },
    signer,
  );

  return assess(request, chain, {
    trustRoots,
    revocation: await emptyRevocation(),
    inputs: {
      evaluatedAt: TIMELINE.evaluatedAt,
      replayStatus: "fresh",
      ...(escalationThreshold ? { escalationThreshold } : {}),
    },
  });
}

describe("an approval requirement is part of the authority, and may only tighten", () => {
  it("refuses a delegation that drops it", () => {
    const violations = narrows(rootScope, withApproval(500_000));

    expect(violations.map((violation) => violation.code)).toContain("scope/approval_removed");
    expect(violations[0]?.message).toMatch(/never less/);
  });

  it("refuses a delegation that raises the threshold", () => {
    const violations = narrows(withApproval(900_000), withApproval(500_000));

    expect(violations.map((violation) => violation.code)).toContain("scope/approval_weakened");
  });

  it("permits a delegation that lowers it", () => {
    expect(narrows(withApproval(100_000), withApproval(500_000))).toEqual([]);
  });

  it("permits an identical requirement", () => {
    expect(narrows(withApproval(500_000), withApproval(500_000))).toEqual([]);
  });

  it("refuses a threshold restated in another currency", () => {
    const child: Scope = { ...rootScope, approval: { above: { currency: "USD", minor: 1000 } } };
    const violations = narrows(child, withApproval(500_000));

    expect(violations.map((violation) => violation.code)).toContain("scope/approval_currency_changed");
  });

  it("inherits the parent's requirement when a delegation says nothing", () => {
    const resolved = resolveDelta({ actions: ["payment.execute"] }, withApproval(500_000));

    expect(resolved.approval).toEqual({ above: inr(500_000) });
    expect(narrows(resolved, withApproval(500_000))).toEqual([]);
  });

  it("takes the tightest requirement across a chain", () => {
    const combined = meet(withApproval(500_000), withApproval(100_000));
    expect(combined.approval).toEqual({ above: inr(100_000) });

    const chain = effectiveScope([withApproval(800_000), withApproval(200_000), rootScope]);
    expect(chain.approval).toEqual({ above: inr(200_000) });
  });

  it("leaves the scope free of the field when no hop imposes one", () => {
    expect(meet(rootScope, rootScope).approval).toBeUndefined();
    expect("approval" in meet(rootScope, rootScope)).toBe(false);
  });
});

describe("a delegation cannot escape an approval requirement", () => {
  it("is refused at issuance when it tries to widen", async () => {
    const parent = await root(withApproval(200_000));

    const attempt = delegateMandate(
      {
        id: "mnd_child_widened_approval",
        parent,
        subject: paymentAgent,
        scopeDelta: { approval: { above: inr(900_000) } },
        notBefore: parent.notBefore,
        expiresAt: parent.expiresAt,
        issuedAt: TIMELINE.delegatedIssuedAt,
      },
      apSigner,
    );

    await expect(attempt).rejects.toBeInstanceOf(DelegationError);
    await attempt.catch((error: DelegationError) => {
      expect(error.violations.map((violation) => violation.code)).toContain(
        "scope/approval_weakened",
      );
    });
  });

  it("is accepted when it tightens, and the tighter value binds", async () => {
    const parent = await root(withApproval(500_000));
    const child = await delegateMandate(
      {
        id: "mnd_child_tighter_approval",
        parent,
        subject: paymentAgent,
        scopeDelta: { approval: { above: inr(100_000) } },
        notBefore: parent.notBefore,
        expiresAt: parent.expiresAt,
        issuedAt: TIMELINE.delegatedIssuedAt,
      },
      apSigner,
    );

    expect(child.scope.approval).toEqual({ above: inr(100_000) });
    expect(effectiveScope([parent.scope, child.scope]).approval).toEqual({ above: inr(100_000) });
  });
});

describe("the gate reads the requirement from the chain, not from its own configuration", () => {
  it("escalates on a chain-carried threshold with no deployment threshold at all", async () => {
    const chain = [await root(withApproval(200_000))];
    const outcome = await decide(chain, 400_000);

    expect(outcome.verdict).toBe("ESCALATE");
    const check = outcome.checks.find((entry) => entry.id === "policy.escalation");
    expect(check?.detail).toMatch(/the authority itself carries that requirement/);
    expect(check?.detail).toMatch(/without knowing how this service is configured/);
  });

  it("allows an amount under the carried threshold", async () => {
    const chain = [await root(withApproval(500_000))];
    expect((await decide(chain, 100_000)).verdict).toBe("ALLOW");
  });

  it("still honours a deployment threshold when the authority carries none", async () => {
    const chain = [await root(rootScope)];
    const outcome = await decide(chain, 600_000, inr(450_000));

    expect(outcome.verdict).toBe("ESCALATE");
    expect(
      outcome.checks.find((entry) => entry.id === "policy.escalation")?.detail,
    ).toMatch(/not carried in the authority/);
  });

  it("lets the stricter of the two bind, whichever it is", async () => {
    const carriedIsStricter = await decide([await root(withApproval(100_000))], 200_000, inr(450_000));
    expect(carriedIsStricter.verdict).toBe("ESCALATE");
    expect(
      carriedIsStricter.checks.find((entry) => entry.id === "policy.escalation")?.expected,
    ).toMatch(/1,000\.00|100000|1,00,000/);

    const configuredIsStricter = await decide(
      [await root(withApproval(900_000))],
      200_000,
      inr(150_000),
    );
    expect(configuredIsStricter.verdict).toBe("ESCALATE");
    expect(
      configuredIsStricter.checks.find((entry) => entry.id === "policy.escalation")?.detail,
    ).toMatch(/not carried in the authority/);
  });

  it("escalates on the tightest hop of a delegated chain", async () => {
    const parent = await root(withApproval(800_000));
    const child = await delegateMandate(
      {
        id: "mnd_child_chain_approval",
        parent,
        subject: paymentAgent,
        scopeDelta: { approval: { above: inr(150_000) } },
        notBefore: parent.notBefore,
        expiresAt: parent.expiresAt,
        issuedAt: TIMELINE.delegatedIssuedAt,
      },
      apSigner,
    );

    const outcome = await decide([parent, child], 200_000);
    expect(outcome.verdict).toBe("ESCALATE");
    expect(outcome.checks.find((entry) => entry.id === "policy.escalation")?.detail).toMatch(
      /the authority itself carries that requirement/,
    );
  });

  it("carries the requirement into the effective scope the decision records", async () => {
    const chain = [await root(withApproval(200_000))];
    const outcome = await decide(chain, 100_000);

    expect(outcome.effectiveScope.approval).toEqual({ above: inr(200_000) });
  });

  it("reaches the same verdict on a re-run, which is what offline reproduction needs", async () => {
    const chain = [await root(withApproval(200_000))];
    const first = await decide(chain, 400_000);
    const second = await decide(chain, 400_000);

    expect(first.verdict).toBe(second.verdict);
    expect(first.checks.map((check) => check.id)).toEqual(second.checks.map((check) => check.id));
    expect(
      first.checks.find((check) => check.id === "policy.escalation")?.detail,
    ).toBe(second.checks.find((check) => check.id === "policy.escalation")?.detail);
  });
});
