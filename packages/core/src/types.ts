import { z } from "zod";

export const MANDATE_VERSION = "warrant/mandate/v0.1";
export const DECISION_VERSION = "warrant/decision/v0.1";
export const PACK_VERSION = "warrant/evidence-pack/v0.1";
export const VERIFIER_VERSION = "warrant-verifier/0.1.0";

const isoDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/,
    "must be an ISO-8601 UTC timestamp ending in Z",
  );

const digestString = z
  .string()
  .regex(/^sha256:[A-Za-z0-9_-]{43}$/, "must be a sha256 base64url digest");

export const moneySchema = z.object({
  currency: z.enum(["INR", "USD", "EUR"]),
  minor: z.number().int().nonnegative(),
});

export const proofSchema = z.object({
  type: z.literal("JsonWebSignature2020"),
  created: isoDateTime,
  verificationMethod: z.string().min(1),
  alg: z.literal("ES256"),
  payloadDigest: z.string().regex(/^sha256:[A-Za-z0-9_-]{43}$/).optional(),
  jws: z.string().regex(/^[A-Za-z0-9_-]+\.\.[A-Za-z0-9_-]+$/, "must be a detached compact JWS"),
});

export const identityAssuranceSchema = z.object({
  identity: z.enum(["self-asserted", "authenticated", "registry-verified"]),
  keyCustody: z.enum(["service", "principal"]),
  method: z.string().min(1),
  assertedBy: z.string().min(1),
  assertedAt: isoDateTime,
  reference: z
    .object({
      scheme: z.string().min(1),
      value: z.string().min(1),
    })
    .optional(),
});

export const legalPersonSchema = z.object({
  kind: z.literal("legal_person"),
  id: z.string().min(1),
  name: z.string().min(1),
  role: z.string().min(1),
  legalEntity: z.string().min(1),
  identifier: z.string().min(1),
  keyId: z.string().min(1),
  assurance: identityAssuranceSchema.optional(),
});

export const agentSchema = z.object({
  kind: z.literal("agent"),
  id: z.string().min(1),
  name: z.string().min(1),
  runtime: z.string().min(1),
  keyId: z.string().min(1),
});

export const partySchema = z.discriminatedUnion("kind", [legalPersonSchema, agentSchema]);

export const counterpartiesSchema = z.union([
  z.object({ any: z.literal(true) }),
  z.object({ allow: z.array(z.string().min(1)) }),
]);

export const approvalRequirementSchema = z.object({
  above: moneySchema,
});

export const scopeSchema = z.object({
  actions: z.array(z.string().min(1)),
  audience: z.array(z.string().min(1)),
  counterparties: counterpartiesSchema,
  limits: z.object({
    perAction: moneySchema.optional(),
    perPeriod: z.object({ amount: moneySchema, days: z.number().int().positive() }).optional(),
  }),
  approval: approvalRequirementSchema.optional(),
  purpose: z.string().optional(),
});

export const scopeDeltaSchema = scopeSchema.partial();

export const mandateSchema = z.object({
  version: z.literal(MANDATE_VERSION),
  id: z.string().min(1),
  organisation: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    jurisdiction: z.string().min(1),
  }),
  liablePrincipal: legalPersonSchema,
  issuer: partySchema,
  subject: agentSchema,
  parent: z.object({ id: z.string().min(1), digest: digestString }).nullable(),
  depth: z.number().int().nonnegative(),
  maxDelegationDepth: z.number().int().nonnegative(),
  scope: scopeSchema,
  notBefore: isoDateTime,
  expiresAt: isoDateTime,
  issuedAt: isoDateTime,
  proof: proofSchema,
});

export const actionRequestSchema = z.object({
  id: z.string().min(1),
  nonce: z.string().min(8),
  actor: z.string().min(1),
  action: z.string().min(1),
  resource: z.string().min(1),
  counterparty: z.string().min(1),
  amount: moneySchema.optional(),
  description: z.string().min(1),
  requestedAt: isoDateTime,
  proof: proofSchema,
});

export const checkSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  status: z.enum(["pass", "fail", "warn", "skip"]),
  detail: z.string().min(1),
  expected: z.string().optional(),
  observed: z.string().optional(),
});

export const freshnessPolicySchema = z.object({
  maxAgeSeconds: z.number().int().positive(),
  clockSkewSeconds: z.number().int().nonnegative(),
});

export const agentStatusSchema = z.enum([
  "registered",
  "active",
  "suspended",
  "revoked",
  "archived",
]);

export const evaluationInputsSchema = z.object({
  evaluatedAt: isoDateTime,
  replayStatus: z.enum(["fresh", "replayed", "unchecked"]),
  agentStatus: agentStatusSchema.optional(),
  freshness: freshnessPolicySchema.optional(),
  priorSpend: moneySchema.optional(),
  escalationThreshold: moneySchema.optional(),
});

export const decisionSchema = z.object({
  version: z.literal(DECISION_VERSION),
  id: z.string().min(1),
  gate: z.object({ id: z.string().min(1), keyId: z.string().min(1) }),
  requestDigest: digestString,
  chainDigest: digestString,
  inputs: evaluationInputsSchema,
  verdict: z.enum(["ALLOW", "BLOCK", "ESCALATE"]),
  reason: z.string().min(1),
  checks: z.array(checkSchema).min(1),
  effectiveScope: scopeSchema,
  liablePrincipal: legalPersonSchema,
  evaluatedAt: isoDateTime,
  proof: proofSchema,
});

export const ledgerEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  prevDigest: z.string().min(1),
  type: z.enum([
    "mandate.issued",
    "mandate.revoked",
    "action.requested",
    "decision.recorded",
    "agent.registered",
    "agent.status_changed",
    "agent.key_rotated",
  ]),
  recordedAt: isoDateTime,
  ref: z.string().min(1),
  payloadDigest: digestString,
  digest: digestString,
});

export const signedHeadSchema = z.object({
  seq: z.number().int().nonnegative(),
  digest: digestString,
  entryCount: z.number().int().nonnegative(),
  signedAt: isoDateTime,
  proof: proofSchema,
});

export const trustRootSchema = z.object({
  keyId: z.string().min(1),
  subject: z.string().min(1),
  role: z.enum(["principal", "agent", "gate", "ledger"]),
  publicKeyJwk: z.object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().min(1),
    y: z.string().min(1),
  }),
  status: z.enum(["next", "active", "retired"]).optional(),
  signingFrom: isoDateTime.optional(),
  signingUntil: isoDateTime.optional(),
  acceptUntil: isoDateTime.optional(),
});

export const approvalSchema = z.object({
  id: z.string().min(1),
  requestDigest: digestString,
  approver: legalPersonSchema,
  approvedAt: isoDateTime,
  note: z.string().min(1).max(240).optional(),
  proof: proofSchema,
});

export const revocationSnapshotSchema = z.object({
  asOf: isoDateTime,
  revoked: z.array(z.object({ mandateId: z.string().min(1), revokedAt: isoDateTime, reason: z.string().min(1) })),
  proof: proofSchema,
});

export const evidencePackSchema = z.object({
  version: z.literal(PACK_VERSION),
  packId: z.string().min(1),
  generatedAt: isoDateTime,
  generatedBy: z.string().min(1),
  organisation: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    jurisdiction: z.string().min(1),
  }),
  summary: z.object({
    headline: z.string().min(1),
    authorisedBy: z.string().min(1),
    performedBy: z.string().min(1),
    action: z.string().min(1),
    verdict: z.enum(["ALLOW", "BLOCK", "ESCALATE"]),
    occurredAt: isoDateTime,
  }),
  request: actionRequestSchema,
  authority: z.object({
    chain: z.array(mandateSchema).min(1),
    effectiveScope: scopeSchema,
    liablePrincipal: legalPersonSchema,
  }),
  decision: decisionSchema,
  ledger: z.object({
    entries: z.array(ledgerEntrySchema).min(1),
    head: signedHeadSchema,
  }),
  revocation: revocationSnapshotSchema,
  approval: approvalSchema.optional(),
  trustRoots: z.array(trustRootSchema).min(1),
  integrity: z.object({
    packDigest: digestString,
    proof: proofSchema,
  }),
});

export type Money = z.infer<typeof moneySchema>;
export type Proof = z.infer<typeof proofSchema>;
export type LegalPerson = z.infer<typeof legalPersonSchema>;
export type IdentityAssurance = z.infer<typeof identityAssuranceSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type Party = z.infer<typeof partySchema>;
export type Counterparties = z.infer<typeof counterpartiesSchema>;
export type Scope = z.infer<typeof scopeSchema>;
export type ApprovalRequirement = z.infer<typeof approvalRequirementSchema>;
export type ScopeDelta = z.infer<typeof scopeDeltaSchema>;
export type Mandate = z.infer<typeof mandateSchema>;
export type UnsignedMandate = Omit<Mandate, "proof">;
export type ActionRequest = z.infer<typeof actionRequestSchema>;
export type UnsignedActionRequest = Omit<ActionRequest, "proof">;
export type Check = z.infer<typeof checkSchema>;
export type CheckStatus = Check["status"];
export type FreshnessPolicy = z.infer<typeof freshnessPolicySchema>;
export type EvaluationInputs = z.infer<typeof evaluationInputsSchema>;
export type AgentStatus = z.infer<typeof agentStatusSchema>;
export type Decision = z.infer<typeof decisionSchema>;
export type Verdict = Decision["verdict"];
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export type SignedHead = z.infer<typeof signedHeadSchema>;
export type TrustRoot = z.infer<typeof trustRootSchema>;
export type RevocationSnapshot = z.infer<typeof revocationSnapshotSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type UnsignedApproval = Omit<Approval, "proof">;
export type EvidencePack = z.infer<typeof evidencePackSchema>;

export class WarrantError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WarrantError";
    this.code = code;
  }
}
