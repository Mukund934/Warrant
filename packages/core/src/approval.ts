import { digestOf } from "./canonical.js";
import { findTrustRoot, verifyAgainstTrustRoot } from "./chain.js";
import { signDetached } from "./sign.js";
import type { SignerIdentity } from "./sign.js";
import type { ActionRequest, Approval, Check, LegalPerson, TrustRoot, UnsignedApproval } from "./types.js";

export interface ApprovalInput {
  id: string;
  request: ActionRequest;
  approver: LegalPerson;
  approvedAt: string;
  note?: string;
}

export async function signApproval(
  input: ApprovalInput,
  signer: SignerIdentity,
): Promise<Approval> {
  const unsigned: UnsignedApproval = {
    id: input.id,
    requestDigest: await digestOf(input.request),
    approver: input.approver,
    approvedAt: input.approvedAt,
    ...(input.note ? { note: input.note } : {}),
  };

  return { ...unsigned, proof: await signDetached(unsigned, signer, input.approvedAt) };
}

export function unsignedApprovalOf(approval: Approval): UnsignedApproval {
  const { proof, ...unsigned } = approval;
  return unsigned;
}

export interface ApprovalContext {
  request: ActionRequest;
  liablePrincipalId: string;
  trustRoots: TrustRoot[];
}

export async function verifyApproval(
  approval: Approval,
  context: ApprovalContext,
): Promise<Check[]> {
  const checks: Check[] = [];

  const expected = await digestOf(context.request);
  checks.push(
    approval.requestDigest === expected
      ? {
          id: "approval.binding",
          title: "The approval names this exact action",
          status: "pass",
          detail: `${approval.approver.name} approved the request whose digest is ${expected}`,
        }
      : {
          id: "approval.binding",
          title: "The approval names this exact action",
          status: "fail",
          detail:
            "this approval was given for a different request; an approval is not transferable between actions",
          expected,
          observed: approval.requestDigest,
        },
  );

  const trustRoot = findTrustRoot(context.trustRoots, approval.proof.verificationMethod);
  if (!trustRoot) {
    checks.push({
      id: "approval.signature",
      title: "The approval is signed by the human it names",
      status: "fail",
      detail: `no public key is known for ${approval.proof.verificationMethod}`,
    });
  } else if (approval.proof.verificationMethod !== approval.approver.keyId) {
    checks.push({
      id: "approval.signature",
      title: "The approval is signed by the human it names",
      status: "fail",
      detail: "the approval was signed by a key other than the approver's",
      expected: approval.approver.keyId,
      observed: approval.proof.verificationMethod,
    });
  } else {
    const outcome = await verifyAgainstTrustRoot(
      unsignedApprovalOf(approval),
      approval.proof,
      trustRoot,
    );
    checks.push(
      outcome.valid
        ? {
            id: "approval.signature",
            title: "The approval is signed by the human it names",
            status: "pass",
            detail: `signed by ${approval.approver.name} (${approval.approver.keyId}) at ${approval.approvedAt}`,
          }
        : {
            id: "approval.signature",
            title: "The approval is signed by the human it names",
            status: "fail",
            detail: outcome.reason ?? "the approval signature is invalid",
          },
    );
  }

  checks.push(
    approval.approver.id === context.liablePrincipalId
      ? {
          id: "approval.second_human",
          title: "The approval comes from someone other than the person already accountable",
          status: "fail",
          detail:
            "the approver is the same person the mandate already holds accountable, so nothing was independently checked",
          expected: `anyone but ${context.liablePrincipalId}`,
          observed: approval.approver.id,
        }
      : {
          id: "approval.second_human",
          title: "The approval comes from someone other than the person already accountable",
          status: "pass",
          detail: `${approval.approver.name} is a second named human, distinct from the accountable principal`,
        },
  );

  return checks;
}
