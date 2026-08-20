import { publicPartOf, thumbprintOf } from "@warrant/core";
import type { AgentStatus, PublicKeyJwk, TrustRoot } from "@warrant/core";
import { digestOf } from "@warrant/core";
import { notFound, unprocessable } from "../http/errors.js";
import { keyringFor } from "./keyring.js";
import type { AgentKey, RegisteredAgent, Repositories, TenantScope } from "../persistence/types.js";
import { identifier, nowIso, trustRoots } from "../warrant/context.js";

const TRANSITIONS: Record<AgentStatus, AgentStatus[]> = {
  registered: ["active", "revoked", "archived"],
  active: ["suspended", "revoked"],
  suspended: ["active", "revoked"],
  revoked: ["archived"],
  archived: [],
};

export function permittedTransitions(from: AgentStatus): AgentStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: AgentStatus, to: AgentStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertPublicOnly(jwk: unknown): PublicKeyJwk {
  const candidate = jwk as Partial<PublicKeyJwk> & { d?: string };

  if (candidate && typeof candidate === "object" && "d" in candidate && candidate.d) {
    throw unprocessable(
      "private_key_supplied",
      "this key includes a private component; send only the public half, and treat the key you just transmitted as compromised",
    );
  }
  if (candidate?.kty !== "EC" || candidate?.crv !== "P-256" || !candidate.x || !candidate.y) {
    throw unprocessable(
      "unsupported_key",
      "an agent key must be an EC P-256 public JWK, the curve every Warrant signature uses",
    );
  }

  return publicPartOf(candidate as PublicKeyJwk);
}

export async function agentKeyIdFor(jwk: PublicKeyJwk): Promise<string> {
  return `key:agent:${(await thumbprintOf(jwk)).slice(0, 16)}`;
}

export interface RegisterAgentInput {
  name: string;
  runtime: string;
  publicKeyJwk: unknown;
}

async function recordLifecycle(
  repositories: Repositories,
  type: "agent.registered" | "agent.status_changed" | "agent.key_rotated",
  agentId: string,
  payload: unknown,
  at: string,
): Promise<void> {
  await repositories.ledger.append({
    type,
    recordedAt: at,
    ref: agentId,
    payloadDigest: await digestOf(payload),
  });
}

export async function registerAgent(
  input: RegisterAgentInput,
  repositories: Repositories,
  organisationId: string,
): Promise<RegisteredAgent> {
  const publicKeyJwk = assertPublicOnly(input.publicKeyJwk);
  const keyId = await agentKeyIdFor(publicKeyJwk);

  const holder = await repositories.agents.findByKeyId(keyId);
  if (holder) {
    throw unprocessable(
      "key_already_registered",
      "this key already identifies a registered agent; an agent identity is its key",
    );
  }

  const at = nowIso();
  const agent: RegisteredAgent = {
    id: identifier("agt"),
    organisationId,
    name: input.name,
    runtime: input.runtime,
    status: "registered",
    registeredAt: at,
    statusChangedAt: at,
  };

  const registered = await repositories.agents.register(agent, {
    keyId,
    agentId: agent.id,
    publicKeyJwk,
    signingFrom: at,
  });

  if (!registered) {
    throw unprocessable(
      "agent_exists",
      `an agent named ${input.name} is already registered in this organisation`,
    );
  }

  await recordLifecycle(repositories, "agent.registered", agent.id, { agent, keyId }, at);
  return agent;
}

export async function changeAgentStatus(
  agentId: string,
  to: AgentStatus,
  reason: string | undefined,
  repositories: Repositories,
  scope: TenantScope,
): Promise<RegisteredAgent> {
  const agent = await repositories.agents.findById(agentId, scope);
  if (!agent) throw notFound(`no agent with id ${agentId}`);

  if (agent.status === to) {
    throw unprocessable("already_in_state", `agent ${agentId} is already ${to}`);
  }
  if (!canTransition(agent.status, to)) {
    const allowed = permittedTransitions(agent.status);
    throw unprocessable(
      "transition_refused",
      allowed.length === 0
        ? `agent ${agentId} is ${agent.status}, which is final`
        : `an agent that is ${agent.status} may only become ${allowed.join(" or ")}, not ${to}`,
    );
  }

  const at = nowIso();
  const applied = await repositories.agents.setStatus(agentId, to, at, reason, scope);
  if (!applied) throw notFound(`no agent with id ${agentId}`);

  await recordLifecycle(
    repositories,
    "agent.status_changed",
    agentId,
    { agentId, from: agent.status, to, reason: reason ?? null, at },
    at,
  );

  return {
    ...agent,
    status: to,
    statusChangedAt: at,
    ...(reason ? { statusReason: reason } : {}),
  };
}

export async function rotateAgentKey(
  agentId: string,
  jwk: unknown,
  repositories: Repositories,
  scope: TenantScope,
): Promise<AgentKey> {
  const agent = await repositories.agents.findById(agentId, scope);
  if (!agent) throw notFound(`no agent with id ${agentId}`);
  if (agent.status === "revoked" || agent.status === "archived") {
    throw unprocessable(
      "transition_refused",
      `agent ${agentId} is ${agent.status}; a key rotation would imply it can still act`,
    );
  }

  const publicKeyJwk = assertPublicOnly(jwk);
  const keyId = await agentKeyIdFor(publicKeyJwk);

  const holder = await repositories.agents.findByKeyId(keyId);
  if (holder) {
    throw unprocessable(
      "key_already_registered",
      "this key already identifies a registered agent",
    );
  }

  const at = nowIso();
  const replacement: AgentKey = { keyId, agentId, publicKeyJwk, signingFrom: at };
  const rotated = await repositories.agents.rotate(agentId, replacement, at);
  if (!rotated) {
    throw unprocessable("rotation_failed", `agent ${agentId} has no current key to retire`);
  }

  await recordLifecycle(repositories, "agent.key_rotated", agentId, { agentId, keyId, at }, at);
  return replacement;
}

export async function trustRootsFor(
  repositories: Repositories,
  organisationId: TenantScope,
): Promise<TrustRoot[]> {
  if (!organisationId) return trustRoots;

  // An organisation publishes its own three authority keys, so a counterparty fetching these gets
  // the set that verifies this organisation's evidence and not another's. One recorded before
  // Phase 9 has no keyring and falls back to the shared demonstration roots, unchanged.
  const organisation = await repositories.directory.findOrganisation(organisationId);
  const keyring = organisation ? await keyringFor(repositories, organisation) : undefined;
  const base = keyring ? keyring.roots : trustRoots;

  const [keys, registered] = await Promise.all([
    repositories.agents.keysFor(organisationId),
    repositories.agents.list(organisationId),
  ]);
  if (keys.length === 0) return base;

  const names = new Map(registered.map((agent) => [agent.id, agent.name]));

  return [
    ...base,
    ...keys.map((key) => ({
      keyId: key.keyId,
      subject: names.get(key.agentId) ?? key.agentId,
      role: "agent" as const,
      publicKeyJwk: key.publicKeyJwk,
      signingFrom: key.signingFrom,
      ...(key.signingUntil ? { signingUntil: key.signingUntil } : {}),
    })),
  ];
}

export async function subjectAgentFor(
  repositories: Repositories,
  agentId: string,
  scope: TenantScope,
): Promise<{ kind: "agent"; id: string; name: string; runtime: string; keyId: string }> {
  const agent = await repositories.agents.findById(agentId, scope);
  if (!agent) throw notFound(`no agent with id ${agentId}`);

  if (agent.status !== "active") {
    throw unprocessable(
      "agent_not_active",
      `agent ${agent.name} is ${agent.status}; authority is only granted to an active agent`,
    );
  }

  const key = await repositories.agents.currentKey(agent.id);
  if (!key) {
    throw unprocessable("agent_has_no_key", `agent ${agent.name} has no current signing key`);
  }

  return {
    kind: "agent",
    id: agent.id,
    name: agent.name,
    runtime: agent.runtime,
    keyId: key.keyId,
  };
}

export async function agentStatusFor(
  repositories: Repositories,
  subjectKeyId: string,
): Promise<AgentStatus | undefined> {
  const agent = await repositories.agents.findByKeyId(subjectKeyId);
  return agent?.status;
}
