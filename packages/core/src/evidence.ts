import { digestOf } from "./canonical.js";
import { formatMoney } from "./scope.js";
import { signDetached } from "./sign.js";
import type { SignerIdentity } from "./sign.js";
import { PACK_VERSION } from "./types.js";
import type {
  ActionRequest,
  Decision,
  EvidencePack,
  LedgerEntry,
  Mandate,
  RevocationSnapshot,
  SignedHead,
  TrustRoot,
} from "./types.js";

export interface EvidencePackInput {
  packId: string;
  generatedAt: string;
  generatedBy: string;
  request: ActionRequest;
  chain: Mandate[];
  decision: Decision;
  ledger: { entries: LedgerEntry[]; head: SignedHead };
  revocation: RevocationSnapshot;
  trustRoots: TrustRoot[];
}

function headlineFor(request: ActionRequest, decision: Decision, leaf: Mandate): string {
  const amount = request.amount ? ` of ${formatMoney(request.amount)}` : "";
  const verb =
    decision.verdict === "ALLOW" ? "was allowed" : decision.verdict === "BLOCK" ? "was blocked" : "was held for human approval";
  return `${leaf.subject.name} requested ${request.description}${amount} and it ${verb}.`;
}

export async function buildEvidencePack(
  input: EvidencePackInput,
  signer: SignerIdentity,
): Promise<EvidencePack> {
  const leaf = input.chain[input.chain.length - 1];
  if (!leaf) {
    throw new Error("an evidence pack requires at least one mandate");
  }

  const body: Omit<EvidencePack, "integrity"> = {
    version: PACK_VERSION,
    packId: input.packId,
    generatedAt: input.generatedAt,
    generatedBy: input.generatedBy,
    organisation: leaf.organisation,
    summary: {
      headline: headlineFor(input.request, input.decision, leaf),
      authorisedBy: `${leaf.liablePrincipal.name}, ${leaf.liablePrincipal.role}, ${leaf.liablePrincipal.legalEntity}`,
      performedBy: `${leaf.subject.name} (${leaf.subject.runtime})`,
      action: input.request.description,
      verdict: input.decision.verdict,
      occurredAt: input.decision.evaluatedAt,
    },
    request: input.request,
    authority: {
      chain: input.chain,
      effectiveScope: input.decision.effectiveScope,
      liablePrincipal: leaf.liablePrincipal,
    },
    decision: input.decision,
    ledger: input.ledger,
    revocation: input.revocation,
    trustRoots: input.trustRoots,
  };

  const packDigest = await digestOf(body);
  const proof = await signDetached(body, signer, input.generatedAt);

  return { ...body, integrity: { packDigest, proof } };
}

export function packBodyOf(pack: EvidencePack): Omit<EvidencePack, "integrity"> {
  const { integrity: _integrity, ...body } = pack;
  return body;
}
