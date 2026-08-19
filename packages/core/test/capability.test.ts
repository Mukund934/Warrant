import { describe, expect, it } from "vitest";
import {
  GENESIS_DIGEST,
  assess,
  buildEvidencePack,
  digestOf,
  evaluate,
  formatMoney,
  issueRootMandate,
  ledgerEntryDigest,
  signActionRequest,
  signDetached,
  signerFromJwk,
  verifyEvidencePack,
} from "../src/index.js";
import type {
  ActionRequest,
  CapabilityResolution,
  Check,
  Decision,
  EvaluationInputs,
  LedgerEntry,
  Mandate,
  Money,
  RevocationSnapshot,
  Scope,
  SignedHead,
} from "../src/index.js";
import { apAgentKey, gateKey, ledgerKey, principalKey } from "../src/fixtures/keys.js";
import {
  KALYANI,
  TIMELINE,
  apAgent,
  inr,
  organisation,
  priyaSharma,
  rootScope,
} from "../src/fixtures/parties.js";
import { trustRoots } from "../src/fixtures/index.js";

const principalSigner = signerFromJwk(principalKey.keyId, principalKey.privateKeyJwk);
const apSigner = signerFromJwk(apAgentKey.keyId, apAgentKey.privateKeyJwk);
const recorder = signerFromJwk(ledgerKey.keyId, ledgerKey.privateKeyJwk);
const gateSigner = signerFromJwk(gateKey.keyId, gateKey.privateKeyJwk);

const ERP = rootScope.audience[0]!;

const PAYMENT: CapabilityResolution = {
  id: "payment.execute",
  status: "registered",
  enforcement: "required",
  risk: "high",
  contract: { amount: "required", currencies: ["INR"] },
};

const UNKNOWN: CapabilityResolution = {
  id: "payment.execute",
  status: "unregistered",
  enforcement: "required",
};

let counter = 0;
const unique = () => (counter += 1).toString().padStart(4, "0");

const checkFor = (checks: Check[], id: string): Check | undefined =>
  checks.find((check) => check.id === id);

async function emptyRevocation(): Promise<RevocationSnapshot> {
  const body = { asOf: TIMELINE.evaluatedAt, revoked: [] };
  return { ...body, proof: await signDetached(body, recorder, body.asOf) };
}

async function root(scope: Scope = rootScope): Promise<Mandate> {
  return issueRootMandate(
    {
      id: `mnd_root_fc1_${unique()}`,
      organisation,
      liablePrincipal: priyaSharma,
      subject: apAgent,
      scope,
      maxDelegationDepth: 1,
      notBefore: TIMELINE.rootNotBefore,
      expiresAt: TIMELINE.rootExpiresAt,
      issuedAt: TIMELINE.rootIssuedAt,
    },
    principalSigner,
  );
}

interface RequestShape {
  action?: string;
  amount?: Money | null;
}

async function requestFor(shape: RequestShape = {}): Promise<ActionRequest> {
  const id = unique();
  const amount = shape.amount === undefined ? inr(100_000) : shape.amount;

  return signActionRequest(
    {
      id: `req_fc1_${id}`,
      nonce: `nonce-fc1-${id}`,
      actor: apAgent.id,
      action: shape.action ?? "payment.execute",
      resource: ERP,
      counterparty: KALYANI,
      description: "Invoice settlement",
      requestedAt: TIMELINE.evaluatedAt,
      ...(amount ? { amount } : {}),
    },
    apSigner,
  );
}

async function outcomeFor(
  request: ActionRequest,
  capability?: CapabilityResolution,
  extra: Partial<EvaluationInputs> = {},
  scope: Scope = rootScope,
) {
  return assess(request, [await root(scope)], {
    trustRoots,
    revocation: await emptyRevocation(),
    inputs: {
      evaluatedAt: TIMELINE.evaluatedAt,
      replayStatus: "fresh",
      ...(capability ? { capability } : {}),
      ...extra,
    },
  });
}

async function ledgerFor(decision: Decision): Promise<{ entries: LedgerEntry[]; head: SignedHead }> {
  const body = {
    seq: 0,
    prevDigest: GENESIS_DIGEST,
    type: "decision.recorded" as const,
    recordedAt: decision.evaluatedAt,
    ref: decision.id,
    payloadDigest: await digestOf(decision),
  };
  const entry: LedgerEntry = { ...body, digest: await ledgerEntryDigest(body) };
  const head = { seq: entry.seq, digest: entry.digest, entryCount: 1, signedAt: TIMELINE.evaluatedAt };

  return {
    entries: [entry],
    head: { ...head, proof: await signDetached(head, recorder, TIMELINE.evaluatedAt) },
  };
}

async function decisionWith(capability: CapabilityResolution) {
  const request = await requestFor();
  const chain = [await root()];
  const revocation = await emptyRevocation();

  const decision = await evaluate(
    request,
    chain,
    {
      trustRoots,
      revocation,
      inputs: { evaluatedAt: TIMELINE.evaluatedAt, replayStatus: "fresh", capability },
    },
    { id: "gate:test", signer: gateSigner },
  );

  const pack = await buildEvidencePack(
    {
      packId: `pack_fc1_${unique()}`,
      generatedAt: TIMELINE.evaluatedAt,
      generatedBy: "capability catalogue test",
      request,
      chain,
      decision,
      ledger: await ledgerFor(decision),
      revocation,
      trustRoots,
    },
    recorder,
  );

  return { decision, pack };
}

describe("a deployment that consults no catalogue", () => {
  it("decides exactly as it did before, and says the catalogue was not consulted", async () => {
    const outcome = await outcomeFor(await requestFor());

    expect(outcome.verdict).toBe("ALLOW");
    expect(checkFor(outcome.checks, "capability.registered")?.status).toBe("skip");
    expect(checkFor(outcome.checks, "capability.registered")?.detail).toMatch(/taken at face value/);
  });

  it("emits no contract check at all, rather than a passing one", async () => {
    const outcome = await outcomeFor(await requestFor());
    expect(checkFor(outcome.checks, "capability.contract")).toBeUndefined();
  });
});

describe("a capability the organisation defines", () => {
  it("passes and records the risk the organisation assigned it", async () => {
    const outcome = await outcomeFor(await requestFor(), PAYMENT);

    expect(outcome.verdict).toBe("ALLOW");
    expect(checkFor(outcome.checks, "capability.registered")?.status).toBe("pass");
    expect(checkFor(outcome.checks, "capability.registered")?.detail).toMatch(/at high risk/);
    expect(checkFor(outcome.checks, "capability.contract")?.status).toBe("pass");
  });

  it("warns but still carries authority once deprecated", async () => {
    const outcome = await outcomeFor(await requestFor(), { ...PAYMENT, status: "deprecated" });

    expect(outcome.verdict).toBe("ALLOW");
    expect(checkFor(outcome.checks, "capability.registered")?.status).toBe("warn");
    expect(checkFor(outcome.checks, "capability.registered")?.detail).toMatch(/going away/);
  });
});

describe("a capability the organisation does not define", () => {
  it("blocks the action where the catalogue is enforced", async () => {
    const outcome = await outcomeFor(await requestFor(), UNKNOWN);

    expect(outcome.verdict).toBe("BLOCK");
    expect(checkFor(outcome.checks, "capability.registered")?.status).toBe("fail");
    expect(outcome.reason).toMatch(/nothing states what it means/);
  });

  it("only warns where the catalogue is advisory, and says so in the evidence", async () => {
    const outcome = await outcomeFor(await requestFor(), { ...UNKNOWN, enforcement: "advisory" });

    expect(outcome.verdict).toBe("ALLOW");
    expect(checkFor(outcome.checks, "capability.registered")?.status).toBe("warn");
    expect(checkFor(outcome.checks, "capability.registered")?.detail).toMatch(
      /advisory, so the action was not refused/,
    );
  });

  it("distinguishes a withdrawn capability from one that never existed", async () => {
    const withdrawn = await outcomeFor(await requestFor(), { ...UNKNOWN, status: "withdrawn" });

    expect(withdrawn.verdict).toBe("BLOCK");
    expect(checkFor(withdrawn.checks, "capability.registered")?.detail).toMatch(/was withdrawn/);
    expect(checkFor(withdrawn.checks, "capability.registered")?.detail).not.toMatch(
      /matches no capability/,
    );
  });

  it("has no declared shape to check, so the contract check skips rather than passes", async () => {
    const outcome = await outcomeFor(await requestFor(), { ...UNKNOWN, enforcement: "advisory" });
    expect(checkFor(outcome.checks, "capability.contract")?.status).toBe("skip");
  });
});

describe("the shape a capability declares", () => {
  it("refuses an action defined as moving money that carries no amount", async () => {
    const outcome = await outcomeFor(await requestFor({ amount: null }), PAYMENT);

    expect(outcome.verdict).toBe("BLOCK");
    expect(checkFor(outcome.checks, "capability.contract")?.status).toBe("fail");
    expect(outcome.reason).toMatch(/carries none/);
  });

  it("refuses an amount on an action defined as moving no money", async () => {
    const outcome = await outcomeFor(await requestFor({ action: "invoice.read" }), {
      id: "invoice.read",
      status: "registered",
      enforcement: "required",
      risk: "low",
      contract: { amount: "forbidden" },
    });

    expect(outcome.verdict).toBe("BLOCK");
    expect(checkFor(outcome.checks, "capability.contract")?.status).toBe("fail");
    expect(outcome.reason).toMatch(/moves no money/);
  });

  it("refuses a currency the capability was never defined for", async () => {
    const outcome = await outcomeFor(await requestFor(), {
      ...PAYMENT,
      contract: { amount: "required", currencies: ["USD", "EUR"] },
    });

    expect(outcome.verdict).toBe("BLOCK");
    expect(checkFor(outcome.checks, "capability.contract")?.observed).toBe("INR");
  });

  it("warns instead of refusing while the catalogue is advisory", async () => {
    const outcome = await outcomeFor(await requestFor({ amount: null }), {
      ...PAYMENT,
      enforcement: "advisory",
    });

    expect(outcome.verdict).toBe("ALLOW");
    expect(checkFor(outcome.checks, "capability.contract")?.status).toBe("warn");
  });
});

describe("the catalogue composing with the approval the authority carries", () => {
  const CARRIES: Scope = { ...rootScope, approval: { above: inr(500_000) } };

  it("binds when it is tighter than the authority, and names the catalogue", async () => {
    const outcome = await outcomeFor(
      await requestFor({ amount: inr(300_000) }),
      { ...PAYMENT, approvalAbove: inr(200_000) },
      {},
      CARRIES,
    );

    expect(outcome.verdict).toBe("ESCALATE");
    const escalation = checkFor(outcome.checks, "policy.escalation");
    expect(escalation?.detail).toContain(formatMoney(inr(200_000)));
    expect(escalation?.detail).toMatch(/capability catalogue attaches that requirement/);
  });

  it("cannot loosen a tighter requirement the authority already carries", async () => {
    const outcome = await outcomeFor(
      await requestFor({ amount: inr(700_000) }),
      { ...PAYMENT, approvalAbove: inr(900_000) },
      {},
      CARRIES,
    );

    expect(outcome.verdict).toBe("ESCALATE");
    const escalation = checkFor(outcome.checks, "policy.escalation");
    expect(escalation?.detail).toContain(formatMoney(inr(500_000)));
    expect(escalation?.detail).toMatch(/the authority itself carries that requirement/);
  });

  it("cannot loosen a tighter threshold the deployment applies", async () => {
    const outcome = await outcomeFor(
      await requestFor({ amount: inr(300_000) }),
      { ...PAYMENT, approvalAbove: inr(800_000) },
      { escalationThreshold: inr(200_000) },
    );

    expect(outcome.verdict).toBe("ESCALATE");
    expect(checkFor(outcome.checks, "policy.escalation")?.detail).toMatch(
      /this deployment applies that threshold/,
    );
  });

  it("requires approval on its own where nothing else sets a threshold", async () => {
    const outcome = await outcomeFor(await requestFor({ amount: inr(300_000) }), {
      ...PAYMENT,
      approvalAbove: inr(200_000),
    });

    expect(outcome.verdict).toBe("ESCALATE");
    expect(checkFor(outcome.checks, "policy.escalation")?.status).toBe("warn");
  });

  it("is still honoured on a pack claiming the capability is unregistered", async () => {
    const outcome = await outcomeFor(await requestFor({ amount: inr(300_000) }), {
      ...UNKNOWN,
      enforcement: "advisory",
      approvalAbove: inr(200_000),
    });

    expect(outcome.verdict).toBe("ESCALATE");
  });
});

describe("a catalogue verdict a stranger receives", () => {
  it("reproduces offline from the decision alone, without holding the catalogue", async () => {
    const { decision, pack } = await decisionWith(UNKNOWN);
    expect(decision.verdict).toBe("BLOCK");

    const report = await verifyEvidencePack(pack, { trustRoots });
    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.verdict).toBe("BLOCK");
    expect(report.authority?.reproduced).toBe(true);
  });

  it("cannot be softened by editing the enforcement mode in the pack", async () => {
    const { pack } = await decisionWith(UNKNOWN);

    const edited = {
      ...pack,
      decision: {
        ...pack.decision,
        inputs: {
          ...pack.decision.inputs,
          capability: { ...pack.decision.inputs.capability!, enforcement: "advisory" as const },
        },
      },
    };

    expect((await verifyEvidencePack(edited, { trustRoots })).result).toBe("INVALID");
  });
});
