import { signActionRequest } from "../action.js";
import { buildEvidencePack } from "../evidence.js";
import { evaluate } from "../gate.js";
import type { GateIdentity } from "../gate.js";
import { Ledger } from "../ledger.js";
import { delegateMandate, issueRootMandate } from "../mandate.js";
import { signDetached, signerFromJwk } from "../sign.js";
import type { SignerIdentity } from "../sign.js";
import type {
  ActionRequest,
  Decision,
  EvaluationInputs,
  EvidencePack,
  Mandate,
  RevocationSnapshot,
  TrustRoot,
  UnsignedActionRequest,
  Verdict,
} from "../types.js";
import {
  apAgentKey,
  demoKeys,
  gateKey,
  ledgerKey,
  payAgentKey,
  principalKey,
  rogueAgentKey,
  settleAgentKey,
} from "./keys.js";
import { settlementAgent } from "./parties.js";
import {
  BANK,
  ERP,
  ESCALATION_THRESHOLD,
  KALYANI,
  NAGPUR,
  PRIOR_PERIOD_SPEND,
  REQUEST_FRESHNESS,
  SUNDARAM,
  TIMELINE,
  UNLISTED,
  apAgent,
  inr,
  organisation,
  paymentAgent,
  priyaSharma,
  rogueAgent,
  rootScope,
} from "./parties.js";

export const trustRoots: TrustRoot[] = demoKeys.map((key) => ({
  keyId: key.keyId,
  subject: key.subject,
  role: key.role,
  publicKeyJwk: key.publicKeyJwk,
}));

const signerOf = (key: (typeof demoKeys)[number]): SignerIdentity =>
  signerFromJwk(key.keyId, key.privateKeyJwk);

const gate: GateIdentity = { id: "gate:meridian-ap-01", signer: signerOf(gateKey) };
const recorder = signerOf(ledgerKey);

export interface ScenarioSpec {
  id: string;
  title: string;
  question: string;
  expected: Verdict;
  failsAt: string | null;
  takeaway: string;
}

export interface ScenarioRun extends ScenarioSpec {
  request: ActionRequest;
  chain: Mandate[];
  decision: Decision;
  pack: EvidencePack;
  revocation: RevocationSnapshot;
}

async function emptyRevocation(): Promise<RevocationSnapshot> {
  const body = { asOf: TIMELINE.revocationAsOf, revoked: [] };
  return { ...body, proof: await signDetached(body, recorder, TIMELINE.revocationAsOf) };
}

async function revocationListing(mandateId: string, reason: string): Promise<RevocationSnapshot> {
  const body = {
    asOf: TIMELINE.revocationAsOf,
    revoked: [{ mandateId, revokedAt: TIMELINE.revokedAt, reason }],
  };
  return { ...body, proof: await signDetached(body, recorder, TIMELINE.revocationAsOf) };
}

async function buildRoot(options: {
  id: string;
  notBefore: string;
  expiresAt: string;
  issuedAt: string;
}): Promise<Mandate> {
  return issueRootMandate(
    {
      id: options.id,
      organisation,
      liablePrincipal: priyaSharma,
      subject: apAgent,
      scope: rootScope,
      maxDelegationDepth: 2,
      notBefore: options.notBefore,
      expiresAt: options.expiresAt,
      issuedAt: options.issuedAt,
    },
    signerOf(principalKey),
  );
}

async function buildDelegation(options: {
  id: string;
  parent: Mandate;
  perAction: number;
  issuedAt: string;
}): Promise<Mandate> {
  return delegateMandate(
    {
      id: options.id,
      parent: options.parent,
      subject: paymentAgent,
      scopeDelta: {
        actions: ["payment.execute"],
        counterparties: { allow: [KALYANI, SUNDARAM] },
        limits: {
          perAction: inr(options.perAction),
          perPeriod: { amount: inr(1_500_000), days: 30 },
        },
      },
      notBefore: options.parent.notBefore,
      expiresAt: options.parent.expiresAt,
      issuedAt: options.issuedAt,
    },
    signerOf(apAgentKey),
  );
}

async function buildSubDelegation(options: {
  id: string;
  parent: Mandate;
  perAction: number;
  issuedAt: string;
}): Promise<Mandate> {
  return delegateMandate(
    {
      id: options.id,
      parent: options.parent,
      subject: settlementAgent,
      scopeDelta: { limits: { perAction: inr(options.perAction) } },
      notBefore: options.parent.notBefore,
      expiresAt: options.parent.expiresAt,
      issuedAt: options.issuedAt,
    },
    signerOf(payAgentKey),
    { enforceNarrowing: false },
  );
}

const actorKeys: Record<string, (typeof demoKeys)[number]> = {
  [paymentAgent.id]: payAgentKey,
  [settlementAgent.id]: settleAgentKey,
  [rogueAgent.id]: rogueAgentKey,
};

async function request(
  overrides: Partial<UnsignedActionRequest> & { id: string; nonce: string },
): Promise<ActionRequest> {
  const unsigned: UnsignedActionRequest = {
    actor: paymentAgent.id,
    action: "payment.execute",
    resource: BANK,
    counterparty: KALYANI,
    amount: inr(420_000),
    description: "supplier invoice MTPL/2026/08/4471",
    requestedAt: TIMELINE.evaluatedAt,
    ...overrides,
  };
  const key = actorKeys[unsigned.actor];
  if (!key) {
    throw new Error(`no demonstration key for actor ${unsigned.actor}`);
  }
  return signActionRequest(unsigned, signerOf(key));
}

async function runScenario(
  spec: ScenarioSpec,
  chain: Mandate[],
  actionRequest: ActionRequest,
  revocation: RevocationSnapshot,
  inputs: EvaluationInputs,
): Promise<ScenarioRun> {
  const decision = await evaluate(actionRequest, chain, { trustRoots, revocation, inputs }, gate);

  const ledger = new Ledger();
  for (const mandate of chain) {
    await ledger.append("mandate.issued", mandate.id, mandate, mandate.issuedAt);
  }
  await ledger.append("action.requested", actionRequest.id, actionRequest, actionRequest.requestedAt);
  await ledger.append("decision.recorded", decision.id, decision, decision.evaluatedAt);
  const head = await ledger.signHead(recorder, TIMELINE.recordedAt);

  const pack = await buildEvidencePack(
    {
      packId: `pack_${spec.id}`,
      generatedAt: TIMELINE.packGeneratedAt,
      generatedBy: "Warrant demonstrator, recording service for Meridian Technologies Pvt Ltd",
      request: actionRequest,
      chain,
      decision,
      ledger: { entries: ledger.all, head },
      revocation,
      trustRoots,
    },
    recorder,
  );

  return { ...spec, request: actionRequest, chain, decision, pack, revocation };
}

let cached: Promise<ScenarioRun[]> | null = null;

async function build(): Promise<ScenarioRun[]> {
  const clean = await emptyRevocation();

  const root = await buildRoot({
    id: "mnd_root_2026_08_001",
    notBefore: TIMELINE.rootNotBefore,
    expiresAt: TIMELINE.rootExpiresAt,
    issuedAt: TIMELINE.rootIssuedAt,
  });
  const delegated = await buildDelegation({
    id: "mnd_dlg_2026_08_014",
    parent: root,
    perAction: 500_000,
    issuedAt: TIMELINE.delegatedIssuedAt,
  });
  const chain = [root, delegated];

  const lapsedRoot = await buildRoot({
    id: "mnd_root_2026_05_004",
    notBefore: TIMELINE.lapsedNotBefore,
    expiresAt: TIMELINE.lapsedExpiresAt,
    issuedAt: TIMELINE.lapsedIssuedAt,
  });
  const lapsedDelegated = await buildDelegation({
    id: "mnd_dlg_2026_05_022",
    parent: lapsedRoot,
    perAction: 500_000,
    issuedAt: TIMELINE.lapsedIssuedAt,
  });

  const escalating = await buildSubDelegation({
    id: "mnd_sub_2026_08_031",
    parent: delegated,
    perAction: 800_000,
    issuedAt: TIMELINE.delegatedIssuedAt,
  });

  const standardInputs: EvaluationInputs = {
    evaluatedAt: TIMELINE.evaluatedAt,
    replayStatus: "fresh",
    freshness: REQUEST_FRESHNESS,
    priorSpend: PRIOR_PERIOD_SPEND,
    escalationThreshold: ESCALATION_THRESHOLD,
  };

  return Promise.all([
    runScenario(
      {
        id: "authorised-payment",
        title: "An authorised payment",
        question: "Who authorised this payment, and was it inside what they granted?",
        expected: "ALLOW",
        failsAt: null,
        takeaway:
          "Every hop from Priya Sharma down to the agent that moved the money is signed, and the gate signed its own verdict.",
      },
      chain,
      await request({ id: "req_20260820_4471", nonce: "n-4471-a91c8e2f" }),
      clean,
      standardInputs,
    ),
    runScenario(
      {
        id: "over-limit",
        title: "A payment above the delegated limit",
        question: "The agent is genuine and the mandate is real. Does that make the payment authorised?",
        expected: "BLOCK",
        failsAt: "limit.per_action",
        takeaway:
          "Identity was never the question. The mandate records what Priya actually granted, and this is outside it.",
      },
      chain,
      await request({
        id: "req_20260820_4472",
        nonce: "n-4472-16bd30aa",
        amount: inr(800_000),
        description: "supplier invoice MTPL/2026/08/4472",
      }),
      clean,
      standardInputs,
    ),
    runScenario(
      {
        id: "delegation-escalation",
        title: "An agent handing on more than it holds",
        question:
          "PAY-Agent-07 holds ₹5,00,000 per invoice and sub-delegated ₹8,00,000 to a settlement agent. Now what?",
        expected: "BLOCK",
        failsAt: "chain.narrowing",
        takeaway:
          "The escalation is caught by comparing the two mandates, not by a rule someone remembered to write. Authority can only narrow, and it narrows across every hop at once.",
      },
      [root, delegated, escalating],
      await request({
        id: "req_20260820_4473",
        nonce: "n-4473-77e0c145",
        actor: settlementAgent.id,
        amount: inr(650_000),
        description: "supplier invoice MTPL/2026/08/4473",
      }),
      clean,
      standardInputs,
    ),
    runScenario(
      {
        id: "expired-mandate",
        title: "Authority that has lapsed",
        question: "This authority was valid in June. Is it valid now?",
        expected: "BLOCK",
        failsAt: "temporal.validity",
        takeaway:
          "The evidence still proves the authority once existed and exactly when it stopped. That is the difference between a record and a log.",
      },
      [lapsedRoot, lapsedDelegated],
      await request({ id: "req_20260820_4474", nonce: "n-4474-c2a91ffe" }),
      clean,
      standardInputs,
    ),
    runScenario(
      {
        id: "wrong-agent",
        title: "A different agent presenting a valid mandate",
        question: "Every signature checks out. But is this the agent the authority was given to?",
        expected: "BLOCK",
        failsAt: "actor.binding",
        takeaway:
          "A valid signature proves the mandate is genuine. It does not prove the agent holding it is the one it was issued to.",
      },
      chain,
      await request({ id: "req_20260820_4475", nonce: "n-4475-3b6e4d10", actor: rogueAgent.id }),
      clean,
      standardInputs,
    ),
    runScenario(
      {
        id: "revoked-mandate",
        title: "Authority withdrawn yesterday",
        question: "Priya withdrew this agent's authority on 19 August. Does the signed mandate still work?",
        expected: "BLOCK",
        failsAt: "revocation.status",
        takeaway:
          "A signature cannot be un-signed, so revocation is published separately and checked at the moment of the action.",
      },
      chain,
      await request({ id: "req_20260820_4476", nonce: "n-4476-8fa2b703" }),
      await revocationListing(
        "mnd_dlg_2026_08_014",
        "Withdrawn by Priya Sharma pending review of the August payment run",
      ),
      standardInputs,
    ),
    runScenario(
      {
        id: "unlisted-counterparty",
        title: "A supplier nobody approved",
        question: "The amount is small and the agent is genuine. Who is being paid?",
        expected: "BLOCK",
        failsAt: "counterparty.allowed",
        takeaway:
          "Limits are not only about money. The mandate names who may be paid, and that constraint survives every hop.",
      },
      chain,
      await request({
        id: "req_20260820_4477",
        nonce: "n-4477-d40c9a18",
        amount: inr(95_000),
        counterparty: UNLISTED,
        description: "supplier invoice MTPL/2026/08/4477",
      }),
      clean,
      standardInputs,
    ),
    runScenario(
      {
        id: "human-approval",
        title: "Inside the limit, above the threshold",
        question: "The authority covers this. Should the agent still act alone?",
        expected: "ESCALATE",
        failsAt: null,
        takeaway:
          "Authority and autonomy are separate settings. Priya delegated the power and kept the last word above a threshold she chose.",
      },
      chain,
      await request({
        id: "req_20260820_4478",
        nonce: "n-4478-51cc7e9b",
        amount: inr(480_000),
        description: "supplier invoice MTPL/2026/08/4478",
      }),
      clean,
      standardInputs,
    ),
  ]);
}

export function demoScenarios(): Promise<ScenarioRun[]> {
  cached ??= build();
  return cached;
}

export async function demoScenario(id: string): Promise<ScenarioRun | undefined> {
  return (await demoScenarios()).find((scenario) => scenario.id === id);
}

export const demoContext = {
  organisation,
  principal: priyaSharma,
  agents: [apAgent, paymentAgent, settlementAgent, rogueAgent],
  gateId: gate.id,
  timeline: TIMELINE,
  escalationThreshold: ESCALATION_THRESHOLD,
  priorSpend: PRIOR_PERIOD_SPEND,
  resources: { erp: ERP, bank: BANK },
  suppliers: { approved: [KALYANI, SUNDARAM, NAGPUR], unlisted: UNLISTED },
};
