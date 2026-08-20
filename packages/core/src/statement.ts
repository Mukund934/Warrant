import { z } from "zod";
import { signDetached, verifyDetached } from "./sign.js";
import type { SignerIdentity } from "./sign.js";
import { findTrustRoot } from "./chain.js";
import type { Check, EvidencePack, TrustRoot } from "./types.js";

export const STATEMENT_VERSION = "warrant/control-statement/v0.1";

const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/, "must be an ISO-8601 UTC timestamp");

export const controlFiringSchema = z.object({
  check: z.string().min(1),
  title: z.string().min(1),
  count: z.number().int().nonnegative(),
});

export const controlStatementSchema = z.object({
  version: z.literal(STATEMENT_VERSION),
  id: z.string().min(1),
  organisation: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    jurisdiction: z.string().min(1),
  }),
  period: z.object({ from: isoDateTime, to: isoDateTime }),
  counts: z.object({
    total: z.number().int().nonnegative(),
    allowed: z.number().int().nonnegative(),
    refused: z.number().int().nonnegative(),
    escalated: z.number().int().nonnegative(),
  }),
  firings: z.array(controlFiringSchema),
  basis: z.string().min(1),
  complete: z.boolean(),
  preparedAt: isoDateTime,
  proof: z.object({
    type: z.literal("JsonWebSignature2020"),
    created: isoDateTime,
    verificationMethod: z.string().min(1),
    alg: z.literal("ES256"),
    payloadDigest: z.string().optional(),
    jws: z.string().min(1),
  }),
});

export type ControlFiring = z.infer<typeof controlFiringSchema>;
export type ControlStatement = z.infer<typeof controlStatementSchema>;
export type UnsignedControlStatement = Omit<ControlStatement, "proof">;

/**
 * What this statement is and is not, carried inside the signed document so it cannot be separated
 * from the numbers. The counts are of actions **this deployment recorded and refused**; they say
 * nothing about actions taken by systems that never presented a mandate.
 */
export const STATEMENT_BASIS =
  "Counts of action decisions this deployment recorded for this organisation in the stated period, " +
  "taken from the decisions as they were signed at the time and not recomputed. It is evidence that " +
  "the controls described fired when they did; it is not a claim that every action taken anywhere in " +
  "the organisation passed through this service.";

export interface StatementInput {
  id: string;
  organisation: ControlStatement["organisation"];
  period: { from: string; to: string };
  packs: EvidencePack[];
  complete: boolean;
  preparedAt: string;
}

const firstFailure = (checks: Check[]): Check | undefined =>
  checks.find((check) => check.status === "fail");

export function tally(packs: EvidencePack[]): {
  counts: ControlStatement["counts"];
  firings: ControlFiring[];
} {
  const counts = { total: 0, allowed: 0, refused: 0, escalated: 0 };
  const firings = new Map<string, ControlFiring>();

  for (const pack of packs) {
    counts.total += 1;
    if (pack.decision.verdict === "ALLOW") counts.allowed += 1;
    else if (pack.decision.verdict === "ESCALATE") counts.escalated += 1;
    else counts.refused += 1;

    // The control that actually stopped it, read from the decision as it was signed. A refusal with
    // several failing checks is attributed to the first, which is the one the reason names.
    const fired = firstFailure(pack.decision.checks);
    if (!fired) continue;

    const seen = firings.get(fired.id);
    if (seen) seen.count += 1;
    else firings.set(fired.id, { check: fired.id, title: fired.title, count: 1 });
  }

  return {
    counts,
    firings: [...firings.values()].sort((a, b) =>
      b.count === a.count ? a.check.localeCompare(b.check) : b.count - a.count,
    ),
  };
}

export async function signControlStatement(
  input: StatementInput,
  signer: SignerIdentity,
): Promise<ControlStatement> {
  const { counts, firings } = tally(input.packs);

  const body: UnsignedControlStatement = {
    version: STATEMENT_VERSION,
    id: input.id,
    organisation: input.organisation,
    period: input.period,
    counts,
    firings,
    basis: STATEMENT_BASIS,
    complete: input.complete,
    preparedAt: input.preparedAt,
  };

  return { ...body, proof: await signDetached(body, signer, input.preparedAt) };
}

export async function verifyControlStatement(
  statement: unknown,
  trustRoots: TrustRoot[],
): Promise<Check[]> {
  const parsed = controlStatementSchema.safeParse(statement);
  if (!parsed.success) {
    return [
      {
        id: "statement.format",
        title: "This is a Warrant control statement",
        status: "fail",
        detail: `this document does not match ${STATEMENT_VERSION}`,
      },
    ];
  }

  const document = parsed.data;
  const checks: Check[] = [
    {
      id: "statement.format",
      title: "This is a Warrant control statement",
      status: "pass",
      detail: `${STATEMENT_VERSION}, covering ${document.period.from} to ${document.period.to}`,
    },
  ];

  const { proof, ...body } = document;
  const root = findTrustRoot(trustRoots, proof.verificationMethod);

  if (!root) {
    checks.push({
      id: "statement.signature",
      title: "The statement is signed by a key the reader trusts",
      status: "fail",
      detail: `no public key is known for ${proof.verificationMethod}`,
    });
  } else {
    const outcome = await verifyDetached(body, proof, root.publicKeyJwk);
    checks.push({
      id: "statement.signature",
      title: "The statement is signed by a key the reader trusts",
      status: outcome.valid ? "pass" : "fail",
      detail: outcome.valid
        ? `signed by ${proof.verificationMethod} at ${proof.created}`
        : (outcome.reason ?? "the signature is invalid"),
    });
  }

  const counted = document.counts.allowed + document.counts.refused + document.counts.escalated;
  checks.push({
    id: "statement.arithmetic",
    title: "The totals add up",
    status: counted === document.counts.total ? "pass" : "fail",
    detail:
      counted === document.counts.total
        ? `${document.counts.total} decisions, of which ${document.counts.refused} were refused`
        : "the verdict counts do not sum to the total",
    ...(counted === document.counts.total
      ? {}
      : { expected: String(document.counts.total), observed: String(counted) }),
  });

  checks.push({
    id: "statement.completeness",
    title: "The statement says whether it covers the whole period",
    status: document.complete ? "pass" : "warn",
    detail: document.complete
      ? "every decision recorded in the period is counted"
      : "more decisions were recorded in this period than the statement counted, so these figures are a floor rather than a total",
  });

  return checks;
}
