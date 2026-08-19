import type { CapabilityResolution, Money, RiskLevel } from "@warrant/core";
import { notFound, unprocessable } from "../http/errors.js";
import type {
  Capability,
  CapabilityStatus,
  CatalogueEnforcement,
  CatalogueState,
  Repositories,
  TenantScope,
} from "../persistence/types.js";
import { nowIso } from "../warrant/context.js";

// A capability names a thing an organisation does, so it is always qualified: `payment.execute`,
// never `execute`. Requiring the dot also keeps every id distinct from the `enforcement`
// sub-resource, so no capability can ever shadow that route.
const CAPABILITY_ID = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/;

const TRANSITIONS: Record<CapabilityStatus, CapabilityStatus[]> = {
  active: ["deprecated", "withdrawn"],
  deprecated: ["active", "withdrawn"],
  withdrawn: [],
};

export interface RegisterCapabilityInput {
  id: string;
  title: string;
  description: string;
  risk: RiskLevel;
  amount: Capability["amount"];
  currencies?: Money["currency"][];
  approvalAbove?: Money;
}

export async function registerCapability(
  input: RegisterCapabilityInput,
  repositories: Repositories,
  organisationId: string,
): Promise<Capability> {
  if (!CAPABILITY_ID.test(input.id)) {
    throw unprocessable(
      "capability_id_rejected",
      "a capability id is lower-case and qualified, like payment.execute, so that it reads the same in a mandate as it does in the catalogue",
    );
  }

  if (input.amount === "forbidden" && (input.currencies || input.approvalAbove)) {
    throw unprocessable(
      "capability_contradicts_itself",
      "this capability is declared to move no money, so a currency list or an approval threshold would never apply",
    );
  }

  if (
    input.approvalAbove &&
    input.currencies &&
    !input.currencies.includes(input.approvalAbove.currency)
  ) {
    throw unprocessable(
      "capability_contradicts_itself",
      `the approval threshold is set in ${input.approvalAbove.currency}, which is not a currency this capability accepts`,
    );
  }

  const at = nowIso();
  const capability: Capability = {
    id: input.id,
    organisationId,
    title: input.title,
    description: input.description,
    risk: input.risk,
    amount: input.amount,
    ...(input.currencies ? { currencies: input.currencies } : {}),
    ...(input.approvalAbove ? { approvalAbove: input.approvalAbove } : {}),
    status: "active",
    registeredAt: at,
    statusChangedAt: at,
  };

  const registered = await repositories.capabilities.register(capability);
  if (!registered) {
    throw unprocessable(
      "capability_exists",
      `${input.id} is already registered in this organisation's catalogue`,
    );
  }

  return capability;
}

export async function changeCapabilityStatus(
  id: string,
  to: CapabilityStatus,
  repositories: Repositories,
  organisationId: string,
): Promise<Capability> {
  const capability = await repositories.capabilities.find(id, organisationId);
  if (!capability) throw notFound(`no capability ${id} in this organisation's catalogue`);

  if (capability.status === to) {
    throw unprocessable("already_in_state", `${id} is already ${to}`);
  }
  if (!TRANSITIONS[capability.status].includes(to)) {
    const allowed = TRANSITIONS[capability.status];
    throw unprocessable(
      "transition_refused",
      allowed.length === 0
        ? `${id} is ${capability.status}, which is final`
        : `a capability that is ${capability.status} may only become ${allowed.join(" or ")}, not ${to}`,
    );
  }

  const at = nowIso();
  const applied = await repositories.capabilities.setStatus(id, to, at, organisationId);
  if (!applied) throw notFound(`no capability ${id} in this organisation's catalogue`);

  return { ...capability, status: to, statusChangedAt: at };
}

export async function setCatalogueEnforcement(
  enforcement: CatalogueEnforcement,
  repositories: Repositories,
  organisationId: string,
): Promise<CatalogueState> {
  await repositories.capabilities.setEnforcement(organisationId, enforcement, nowIso());
  return repositories.capabilities.catalogue(organisationId);
}

/**
 * What the gate is told about the requested action, and nothing more. The result is signed into the
 * Decision, so a stranger reproduces the same verdict without ever holding the catalogue — which is
 * why the catalogue can live outside the mandate without breaking offline verification.
 */
export async function resolveCapability(
  repositories: Repositories,
  organisationId: TenantScope,
  action: string,
): Promise<CapabilityResolution | undefined> {
  if (!organisationId) return undefined;

  const { enforcement, size } = await repositories.capabilities.catalogue(organisationId);

  // An organisation that has registered nothing has not opted in. Resolving anyway would stamp
  // "unregistered" onto the evidence of every action every existing deployment has ever taken.
  if (size === 0) return undefined;

  const capability = await repositories.capabilities.find(action, organisationId);
  if (!capability || capability.status === "withdrawn") {
    return { id: action, status: capability ? "withdrawn" : "unregistered", enforcement };
  }

  return {
    id: action,
    status: capability.status === "deprecated" ? "deprecated" : "registered",
    enforcement,
    risk: capability.risk,
    contract: {
      amount: capability.amount,
      ...(capability.currencies ? { currencies: capability.currencies } : {}),
    },
    ...(capability.approvalAbove ? { approvalAbove: capability.approvalAbove } : {}),
  };
}
