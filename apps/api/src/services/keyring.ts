import { createKeyPair, signerFromJwk } from "@warrant/core";
import type { GateIdentity, SignerIdentity, TrustRoot } from "@warrant/core";
import type {
  Organisation,
  OrganisationKey,
  OrganisationKeyRole,
  Repositories,
} from "../persistence/types.js";
import { gate, nowIso, principalSigner, recorder, trustRoots } from "../warrant/context.js";

/**
 * The keys one organisation signs its own authority with.
 *
 * Phase 9. Before this, every organisation on a deployment shared the demonstration principal, gate
 * and ledger keys, so evidence issued by one verified under the trust roots of another — not because
 * the second organisation had checked anything, but because they were never separate keys. That made
 * tenancy a data boundary and not a cryptographic one, and it is the one thing standing between the
 * product and the claim it exists to make.
 *
 * **No signed format changes.** A `Decision` already names the key that signed it and a pack already
 * carries the trust roots it expects; all that moves is which key does the signing. The 13
 * conformance vectors are untouched, and so is the demonstration path — an organisation with no
 * keyring falls back to the shared demonstration keys, which is what every scenario and every
 * unauthenticated call already relies on.
 */
export interface Keyring {
  /** Signs the root mandates this organisation issues, on behalf of its liable principal. */
  principal: SignerIdentity;
  /** Signs the decisions its gate reaches. */
  gate: GateIdentity;
  /** Signs its evidence packs, ledger heads, revocation snapshots and statements. */
  recorder: SignerIdentity;
  /**
   * What a relying party needs to check this organisation's evidence, and nothing more.
   *
   * Its own three keys, plus the agent keys its mandates name as subjects. A counterparty fetching
   * these from `/v1/trust-roots` gets the set that verifies this organisation's packs — and, after
   * Phase 9, not another organisation's.
   */
  roots: TrustRoot[];
}

const ROLES: OrganisationKeyRole[] = ["principal", "gate", "ledger"];

/**
 * The demonstration agents are shared fixtures, and a mandate that names one as its subject is
 * signed by that agent's key when it delegates. Those keys therefore have to be publishable by every
 * organisation, or an organisation's own evidence would not verify against its own roots.
 *
 * They are agent keys, never authority keys. What separates two organisations is the principal, the
 * gate and the recorder, and none of those is shared.
 */
const DEMONSTRATION_AGENT_ROOTS = trustRoots.filter((root) => root.role === "agent");

/** What an organisation signs with when it has no keys of its own. */
export const DEMONSTRATION_KEYRING: Keyring = {
  principal: principalSigner,
  gate,
  recorder,
  roots: trustRoots,
};

/** Stable and derived, so a reader can tell which organisation's gate reached a decision. */
export const gateIdFor = (organisationId: string): string => `gate:${organisationId}`;

const rootOf = (key: OrganisationKey, subject: string): TrustRoot => ({
  keyId: key.keyId,
  subject,
  role: key.role,
  publicKeyJwk: key.publicKeyJwk,
  signingFrom: key.createdAt,
});

function assemble(organisation: Organisation, keys: OrganisationKey[]): Keyring | undefined {
  const byRole = new Map(keys.map((key) => [key.role, key]));
  const principal = byRole.get("principal");
  const gateKey = byRole.get("gate");
  const ledger = byRole.get("ledger");

  // A partial keyring is treated as no keyring rather than patched up from the demonstration keys.
  // Mixing the two would produce evidence signed by one organisation and verifiable by every other,
  // which is the exact failure this exists to remove.
  if (!principal || !gateKey || !ledger) return undefined;

  return {
    principal: signerFromJwk(principal.keyId, principal.privateKeyJwk),
    gate: {
      id: gateIdFor(organisation.id),
      signer: signerFromJwk(gateKey.keyId, gateKey.privateKeyJwk),
    },
    recorder: signerFromJwk(ledger.keyId, ledger.privateKeyJwk),
    roots: [
      rootOf(principal, organisation.name),
      rootOf(gateKey, `${organisation.name} authority gate`),
      rootOf(ledger, `${organisation.name} evidence recorder`),
      ...DEMONSTRATION_AGENT_ROOTS,
    ],
  };
}

/**
 * Generates and stores an organisation's keyring, once.
 *
 * Called when an organisation is created. If two requests race, one writes and the other reads what
 * the winner wrote — never a second keyring, because an organisation whose keys changed underneath
 * it would leave its earlier evidence unverifiable against its own published roots.
 */
export async function installKeyring(
  repositories: Repositories,
  organisation: Organisation,
): Promise<Keyring | undefined> {
  const at = nowIso();
  const created = await Promise.all(
    ROLES.map(async (role): Promise<OrganisationKey> => {
      const pair = await createKeyPair(organisation.name, role);
      return {
        organisationId: organisation.id,
        role,
        keyId: pair.keyId,
        publicKeyJwk: pair.publicKeyJwk,
        privateKeyJwk: pair.privateKeyJwk,
        createdAt: at,
      };
    }),
  );

  const installed = await repositories.organisationKeys.install(created);
  if (installed) return assemble(organisation, created);

  return keyringFor(repositories, organisation);
}

/**
 * The organisation's own keyring, or `undefined` if it has none.
 *
 * `undefined` is a supported answer and not a fault: an organisation recorded before Phase 9 has no
 * keys stored and keeps signing with the demonstration keyring exactly as it always did. That is the
 * compatibility seam, and it is why this change needs no backfill and rewrites no existing row.
 */
export async function keyringFor(
  repositories: Repositories,
  organisation: Organisation,
): Promise<Keyring | undefined> {
  const keys = await repositories.organisationKeys.keyring(organisation.id);
  if (keys.length === 0) return undefined;
  return assemble(organisation, keys);
}
