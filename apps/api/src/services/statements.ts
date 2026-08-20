import { signControlStatement } from "@warrant/core";
import type { ControlStatement, EvidencePack } from "@warrant/core";
import { badRequest, notFound } from "../http/errors.js";
import type { Repositories } from "../persistence/types.js";
import type { Actor } from "./issuance.js";
import { identifier, nowIso, recorder } from "../warrant/context.js";
import { instant } from "./execution.js";

/**
 * A statement reads every decision in its period. Past this many it stops and says so, because a
 * figure that quietly omits half a month is worse than one that admits its own floor.
 */
const MAX_DECISIONS = 5_000;
const PAGE = 100;

export interface StatementInput {
  from: string;
  to: string;
}

export async function issueControlStatement(
  input: StatementInput,
  repositories: Repositories,
  actor: Actor,
): Promise<ControlStatement> {
  if (instant(input.from) > instant(input.to)) {
    throw badRequest("range_inverted", "the period starts after it ends, so nothing can be counted");
  }

  const organisation = await repositories.directory.findOrganisation(actor.organisation.id);
  if (!organisation) throw notFound(`no organisation with id ${actor.organisation.id}`);

  const packs: EvidencePack[] = [];
  let cursor: string | undefined;
  let complete = true;

  for (;;) {
    const page = await repositories.evidence.search(
      { from: input.from, to: input.to, limit: PAGE, ...(cursor ? { cursor } : {}) },
      actor.scope,
    );

    for (const summary of page.results) {
      const pack = await repositories.evidence.findById(summary.packId, actor.scope);
      if (pack) packs.push(pack);
    }

    cursor = page.nextCursor;
    if (!cursor) break;
    if (packs.length >= MAX_DECISIONS) {
      complete = false;
      break;
    }
  }

  return signControlStatement(
    {
      id: identifier("stm"),
      organisation,
      period: { from: input.from, to: input.to },
      packs,
      complete,
      preparedAt: nowIso(),
    },
    recorder,
  );
}
