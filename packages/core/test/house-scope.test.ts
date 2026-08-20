import { describe, expect, it } from "vitest";
import {
  GENESIS_DIGEST,
  assess,
  buildEvidencePack,
  digestOf,
  evaluate,
  issueRootMandate,
  ledgerEntryDigest,
  signActionRequest,
  signDetached,
  signerFromJwk,
  verifyEvidencePack,
} from "../src/index.js";
import type {
  ActionRequest,
  Check,
  Decision,
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
  NAGPUR,
  SUNDARAM,
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
const BANK = rootScope.audience[1]!;

/** A ceiling that constrains nothing, so each test can tighten exactly one thing. */
const OPEN: Scope = {
  actions: [...rootScope.actions],
  audience: [...rootScope.audience],
  counterparties: { any: true },
  limits: {},
};

let counter = 0;
const unique = () => (counter += 1).toString().padStart(4, "0");

const checkFor = (checks: Check[], id: string): Check | undefined =>
  checks.find((check) => check.id === id);

async function emptyRevocation(): Promise<RevocationSnapshot> {
  const body = { asOf: TIMELINE.evaluatedAt, revoked: [] };
  return { ...body, proof: await signDetached(body, recorder, body.asOf) };
}

async function root(): Promise<Mandate> {
  return issueRootMandate(
    {
      id: `mnd_root_fx1_${unique()}`,
      organisation,
      liablePrincipal: priyaSharma,
      subject: apAgent,
      scope: rootScope,
      maxDelegationDepth: 1,
      notBefore: TIMELINE.rootNotBefore,
      expiresAt: TIMELINE.rootExpiresAt,
      issuedAt: TIMELINE.rootIssuedAt,
    },
    principalSigner,
  );
}

interface Shape {
  action?: string;
  resource?: string;
  counterparty?: string;
  amount?: Money;
}

async function requestFor(shape: Shape = {}): Promise<ActionRequest> {
  const id = unique();
  return signActionRequest(
    {
      id: `req_fx1_${id}`,
      nonce: `nonce-fx1-${id}`,
      actor: apAgent.id,
      action: shape.action ?? "payment.execute",
      resource: shape.resource ?? ERP,
      counterparty: shape.counterparty ?? KALYANI,
      description: "Invoice settlement",
      requestedAt: TIMELINE.evaluatedAt,
      amount: shape.amount ?? inr(100_000),
    },
    apSigner,
  );
}

async function outcomeFor(request: ActionRequest, houseScope?: Scope) {
  return assess(request, [await root()], {
    trustRoots,
    revocation: await emptyRevocation(),
    inputs: {
      evaluatedAt: TIMELINE.evaluatedAt,
      replayStatus: "fresh",
      ...(houseScope ? { houseScope } : {}),
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
  const head = { seq: 0, digest: entry.digest, entryCount: 1, signedAt: TIMELINE.evaluatedAt };
  return {
    entries: [entry],
    head: { ...head, proof: await signDetached(head, recorder, TIMELINE.evaluatedAt) },
  };
}

async function packWith(houseScope: Scope, shape: Shape = {}) {
  const request = await requestFor(shape);
  const chain = [await root()];
  const revocation = await emptyRevocation();

  const decision = await evaluate(
    request,
    chain,
    {
      trustRoots,
      revocation,
      inputs: { evaluatedAt: TIMELINE.evaluatedAt, replayStatus: "fresh", houseScope },
    },
    { id: "gate:test", signer: gateSigner },
  );

  const pack = await buildEvidencePack(
    {
      packId: `pack_fx1_${unique()}`,
      generatedAt: TIMELINE.evaluatedAt,
      generatedBy: "house scope test",
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

describe("an organisation that set no ceiling", () => {
  it("decides exactly as it did before, and says no ceiling was applied", async () => {
    const outcome = await outcomeFor(await requestFor());

    expect(outcome.verdict).toBe("ALLOW");
    expect(checkFor(outcome.checks, "house.ceiling")?.status).toBe("skip");
    expect(outcome.effectiveScope.actions).toEqual(rootScope.actions);
  });
});

describe("a ceiling the delegated authority is already inside", () => {
  it("passes and states plainly that it removed nothing", async () => {
    const outcome = await outcomeFor(await requestFor(), OPEN);

    expect(outcome.verdict).toBe("ALLOW");
    expect(checkFor(outcome.checks, "house.ceiling")?.status).toBe("pass");
    expect(checkFor(outcome.checks, "house.ceiling")?.detail).toMatch(/removed nothing/);
  });
});

describe("a ceiling that subtracts", () => {
  it("takes the authority away but lets an action that never needed it through", async () => {
    const outcome = await outcomeFor(await requestFor(), {
      ...OPEN,
      actions: ["payment.execute"],
    });

    expect(outcome.verdict).toBe("ALLOW");
    expect(outcome.effectiveScope.actions).toEqual(["payment.execute"]);

    const ceiling = checkFor(outcome.checks, "house.ceiling");
    expect(ceiling?.status).toBe("warn");
    expect(ceiling?.detail).toMatch(/dropped invoice\.read and payment\.approve/);
  });

  it("refuses an action the ceiling removed, and blames the ceiling rather than the mandate", async () => {
    const outcome = await outcomeFor(await requestFor(), { ...OPEN, actions: ["invoice.read"] });

    expect(outcome.verdict).toBe("BLOCK");
    expect(checkFor(outcome.checks, "action.in_scope")?.status).toBe("fail");
    expect(outcome.reason).toMatch(/ceiling narrowed actions after delegation/);
  });

  it("caps an amount the mandate would otherwise have allowed", async () => {
    const outcome = await outcomeFor(await requestFor({ amount: inr(400_000) }), {
      ...OPEN,
      limits: { perAction: inr(200_000) },
    });

    expect(outcome.verdict).toBe("BLOCK");
    expect(outcome.reason).toMatch(/ceiling narrowed limits\.perAction after delegation/);
    expect(outcome.effectiveScope.limits.perAction).toEqual(inr(200_000));
  });

  it("leaves an amount under the cap alone", async () => {
    const outcome = await outcomeFor(await requestFor({ amount: inr(100_000) }), {
      ...OPEN,
      limits: { perAction: inr(200_000) },
    });

    expect(outcome.verdict).toBe("ALLOW");
  });

  it("removes a counterparty the mandate listed", async () => {
    const outcome = await outcomeFor(await requestFor({ counterparty: SUNDARAM }), {
      ...OPEN,
      counterparties: { allow: [KALYANI, NAGPUR] },
    });

    expect(outcome.verdict).toBe("BLOCK");
    expect(outcome.reason).toMatch(/ceiling narrowed counterparties after delegation/);
  });

  it("removes a resource the mandate covered", async () => {
    const outcome = await outcomeFor(await requestFor({ resource: BANK }), {
      ...OPEN,
      audience: [ERP],
    });

    expect(outcome.verdict).toBe("BLOCK");
    expect(outcome.reason).toMatch(/ceiling narrowed audience after delegation/);
  });
});

describe("a ceiling can subtract and can never add", () => {
  it("does not grant an action the mandate never held", async () => {
    const outcome = await outcomeFor(await requestFor({ action: "payroll.run" }), {
      ...OPEN,
      actions: [...rootScope.actions, "payroll.run"],
    });

    expect(outcome.verdict).toBe("BLOCK");
    expect(checkFor(outcome.checks, "action.in_scope")?.status).toBe("fail");
    expect(outcome.effectiveScope.actions).not.toContain("payroll.run");
  });

  it("does not raise a limit the mandate set lower", async () => {
    const outcome = await outcomeFor(await requestFor({ amount: inr(2_000_000) }), {
      ...OPEN,
      limits: { perAction: inr(9_000_000) },
    });

    expect(outcome.verdict).toBe("BLOCK");
    expect(outcome.effectiveScope.limits.perAction).toEqual(rootScope.limits.perAction);
  });

  it("does not reopen a counterparty list the mandate closed", async () => {
    const outcome = await outcomeFor(await requestFor({ counterparty: "Someone Else Ltd" }), OPEN);

    expect(outcome.verdict).toBe("BLOCK");
    expect(checkFor(outcome.checks, "counterparty.allowed")?.status).toBe("fail");
  });
});

describe("a ceiling that cannot be combined at all", () => {
  it("fails the check rather than throwing, so the refusal is still evidence", async () => {
    const outcome = await outcomeFor(await requestFor(), {
      ...OPEN,
      limits: { perAction: { currency: "USD", minor: 100_000 } },
    });

    expect(outcome.verdict).toBe("BLOCK");
    expect(checkFor(outcome.checks, "house.ceiling")?.status).toBe("fail");
    expect(outcome.reason).toMatch(/cannot be combined/);
  });
});

describe("a ceiling a stranger has to reproduce", () => {
  it("records the ceiling in the decision, so the verdict recomputes offline", async () => {
    const { decision, pack } = await packWith({ ...OPEN, actions: ["invoice.read"] });

    expect(decision.verdict).toBe("BLOCK");
    expect(decision.inputs.houseScope?.actions).toEqual(["invoice.read"]);

    const report = await verifyEvidencePack(pack, { trustRoots });
    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.verdict).toBe("BLOCK");
    expect(report.authority?.reproduced).toBe(true);
  });

  it("records the ceiling-narrowed authority as the effective scope", async () => {
    const { decision } = await packWith({ ...OPEN, actions: ["payment.execute"] });

    expect(decision.verdict).toBe("ALLOW");
    expect(decision.effectiveScope.actions).toEqual(["payment.execute"]);
  });

  // The ceiling in force at the moment of the action is written into the decision, never looked up
  // afterwards. Tightening it later cannot reach back and change a verdict already reached.
  it("keeps reproducing under the ceiling that was in force, not a later one", async () => {
    const { pack } = await packWith(OPEN);

    const report = await verifyEvidencePack(pack, { trustRoots });
    expect(report.result).toBe("VERIFIED");
    expect(report.authority?.verdict).toBe("ALLOW");
    expect(report.authority?.reproduced).toBe(true);
  });

  it("refuses a pack whose recorded ceiling has been widened after the fact", async () => {
    const { pack } = await packWith({ ...OPEN, actions: ["invoice.read"] });

    const edited = {
      ...pack,
      decision: {
        ...pack.decision,
        inputs: { ...pack.decision.inputs, houseScope: OPEN },
      },
    };

    expect((await verifyEvidencePack(edited, { trustRoots })).result).toBe("INVALID");
  });
});
