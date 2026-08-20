import { formatMoney } from "@warrant/core";
import type { EvidencePack, LedgerEntry, Mandate, Verdict } from "@warrant/core";
import { notFound } from "../http/errors.js";
import type { Repositories } from "../persistence/types.js";
import type { Actor } from "./issuance.js";

export interface TimelineEntry {
  seq: number;
  type: LedgerEntry["type"];
  recordedAt: string;
  ref: string;
  payloadDigest: string;
  summary: string;
  packId?: string;
  verdict?: Verdict;
}

export interface Timeline {
  mandateId: string;
  mandates: string[];
  entries: TimelineEntry[];
  coverage: string;
}

const COVERAGE =
  "This mandate and everything delegated beneath it. The ledger is one chain for the whole " +
  "deployment, so this is a filtered view of it: every entry's digest was re-derived when it was " +
  "read, but continuity across the full chain is not claimed here. Verdicts are copied from the " +
  "stored decision and are not recomputed.";

const describeAmount = (pack: EvidencePack): string =>
  pack.request.amount ? ` for ${formatMoney(pack.request.amount)}` : "";

export async function timelineFor(
  mandateId: string,
  repositories: Repositories,
  actor: Actor,
): Promise<Timeline> {
  // Every ref this function will look up in the ledger comes from a read that was already
  // tenant-scoped. That is the whole tenancy argument: the ledger itself has no tenant to filter on.
  const tree = await repositories.mandates.descendants(mandateId, actor.scope);
  if (tree.length === 0) throw notFound(`no mandate with id ${mandateId}`);

  const mandateIds = tree.map((mandate) => mandate.id);
  const inTree = new Set(mandateIds);

  const chain = await repositories.mandates.findChain(mandateId, actor.scope);
  const rootMandateId = chain?.[0]?.id ?? mandateId;

  const page = await repositories.evidence.search(
    { rootMandateId, limit: 200 },
    actor.scope,
  );

  const packs: EvidencePack[] = [];
  for (const summary of page.results) {
    const pack = await repositories.evidence.findById(summary.packId, actor.scope);
    // Evidence is filed under the root of the chain, so a query for a mandate part-way down would
    // otherwise sweep in branches beside it.
    if (pack && inTree.has(pack.authority.chain[pack.authority.chain.length - 1]!.id)) {
      packs.push(pack);
    }
  }

  const agents = new Map<string, string>();
  for (const mandate of tree) {
    const registered = await repositories.agents.findById(mandate.subject.id, actor.scope);
    if (registered) agents.set(registered.id, registered.name);
  }

  const revocations = new Map(
    (await repositories.mandates.revocations(actor.scope)).map((record) => [
      record.mandateId,
      record.reason,
    ]),
  );

  const mandatesById = new Map(tree.map((mandate) => [mandate.id, mandate]));
  const byRequest = new Map(packs.map((pack) => [pack.request.id, pack]));
  const byDecision = new Map(packs.map((pack) => [pack.decision.id, pack]));

  const refs = [
    ...mandateIds,
    ...agents.keys(),
    ...packs.map((pack) => pack.request.id),
    ...packs.map((pack) => pack.decision.id),
  ];

  const entries = (await repositories.ledger.entriesFor(refs)).map((entry) =>
    describe(entry, { mandatesById, agents, revocations, byRequest, byDecision }),
  );

  return { mandateId, mandates: mandateIds, entries, coverage: COVERAGE };
}

interface Lookups {
  mandatesById: Map<string, Mandate>;
  agents: Map<string, string>;
  revocations: Map<string, string>;
  byRequest: Map<string, EvidencePack>;
  byDecision: Map<string, EvidencePack>;
}

function describe(entry: LedgerEntry, lookups: Lookups): TimelineEntry {
  const base = {
    seq: entry.seq,
    type: entry.type,
    recordedAt: entry.recordedAt,
    ref: entry.ref,
    payloadDigest: entry.payloadDigest,
  };

  switch (entry.type) {
    case "mandate.issued": {
      const mandate = lookups.mandatesById.get(entry.ref);
      return {
        ...base,
        summary: mandate
          ? `${mandate.issuer.name} delegated authority to ${mandate.subject.name} at depth ${mandate.depth}`
          : "authority was issued",
      };
    }
    case "mandate.revoked": {
      const mandate = lookups.mandatesById.get(entry.ref);
      const reason = lookups.revocations.get(entry.ref);
      const who = mandate ? `${mandate.subject.name}'s authority` : "authority";
      return { ...base, summary: reason ? `${who} was withdrawn: ${reason}` : `${who} was withdrawn` };
    }
    case "action.requested": {
      const pack = lookups.byRequest.get(entry.ref);
      return {
        ...base,
        summary: pack
          ? `${pack.request.actor} asked to ${pack.request.action}${describeAmount(pack)} with ${pack.request.counterparty}`
          : "an action was requested",
        ...(pack ? { packId: pack.packId } : {}),
      };
    }
    case "decision.recorded": {
      const pack = lookups.byDecision.get(entry.ref);
      return {
        ...base,
        summary: pack ? `${pack.decision.verdict}: ${pack.decision.reason}` : "a decision was recorded",
        ...(pack ? { packId: pack.packId, verdict: pack.decision.verdict } : {}),
      };
    }
    case "agent.registered":
      return { ...base, summary: `${lookups.agents.get(entry.ref) ?? entry.ref} was registered` };
    case "agent.status_changed":
      return {
        ...base,
        summary: `${lookups.agents.get(entry.ref) ?? entry.ref} changed standing`,
      };
    case "agent.key_rotated":
      return {
        ...base,
        summary: `${lookups.agents.get(entry.ref) ?? entry.ref} rotated its signing key`,
      };
  }
}
