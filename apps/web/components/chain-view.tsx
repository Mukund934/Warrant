import { describeCounterparties, formatMoney, narrows } from "@warrant/core";
import type { Mandate } from "@warrant/core";
import { Label, Mono } from "./primitives";

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function limitOf(mandate: Mandate): number | null {
  return mandate.scope.limits.perAction?.minor ?? null;
}

export function PrincipalCard({ mandate }: { mandate: Mandate }) {
  const person = mandate.liablePrincipal;
  return (
    <div className="rounded-lg border border-seal-dim bg-seal/[0.05] px-5 py-4">
      <Label>Accountable legal person</Label>
      <p className="mt-2 text-[17px] font-semibold text-text">{person.name}</p>
      <p className="text-[13.5px] text-text-muted">
        {person.role}, {person.legalEntity}
      </p>
      <p className="mt-2 text-[12.5px] text-text-faint">
        Identified as {person.identifier} in {mandate.organisation.jurisdiction}. Every mandate below
        remains answerable to this person.
      </p>
    </div>
  );
}

function AuthorityBar({
  mandate,
  parent,
  rootLimit,
}: {
  mandate: Mandate;
  parent: Mandate | undefined;
  rootLimit: number | null;
}) {
  const limit = limitOf(mandate);
  const parentLimit = parent ? limitOf(parent) : null;

  if (limit === null || rootLimit === null) {
    return (
      <div className="mt-3">
        <div className="h-2 rounded-full bg-line-strong" />
        <p className="mt-1.5 text-[12px] text-text-faint">No per-invoice limit set</p>
      </div>
    );
  }

  const widened = parentLimit !== null && limit > parentLimit;
  const scale = Math.max(rootLimit, limit);
  const width = Math.max((limit / scale) * 100, 4);
  const permittedWidth = widened && parentLimit !== null ? (parentLimit / scale) * 100 : width;

  return (
    <div className="mt-3">
      <div className="relative h-2 overflow-hidden rounded-full bg-line">
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${widened ? "bg-fail/70" : "bg-seal/80"}`}
          style={{ width: `${width}%` }}
        />
        {widened && (
          <div
            className="absolute inset-y-0 left-0 rounded-full bg-seal/80"
            style={{ width: `${permittedWidth}%` }}
          />
        )}
      </div>
      <p className={`mt-1.5 text-[12px] ${widened ? "text-fail" : "text-text-faint"}`}>
        {formatMoney(mandate.scope.limits.perAction!)} per invoice
        {widened && parentLimit !== null
          ? ` — beyond the ${formatMoney(parent!.scope.limits.perAction!)} the issuing mandate holds`
          : ""}
      </p>
    </div>
  );
}

export function ChainView({ chain }: { chain: Mandate[] }) {
  const rootLimit = chain[0] ? limitOf(chain[0]) : null;

  return (
    <ol className="space-y-0">
      {chain.map((mandate, index) => {
        const parent = index > 0 ? chain[index - 1] : undefined;
        const violations = parent ? narrows(mandate.scope, parent.scope) : [];
        const widened = violations.length > 0;

        return (
          <li key={mandate.id} className="relative">
            {index > 0 && (
              <div className="ml-6 flex items-center gap-3 py-2">
                <span
                  aria-hidden
                  className={`h-6 w-px ${widened ? "bg-fail/60" : "bg-line-strong"}`}
                />
                <span className={`text-[12px] ${widened ? "text-fail" : "text-text-faint"}`}>
                  {widened ? "sub-delegated, and it widens" : "sub-delegated to"}
                </span>
              </div>
            )}

            <div
              className={`rounded-lg border px-5 py-4 ${
                widened ? "border-fail/50 bg-fail/[0.05]" : "border-line bg-surface"
              }`}
            >
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div>
                  <Label>{index === 0 ? "Mandate" : `Mandate, hop ${index + 1}`}</Label>
                  <p className="mt-1.5 text-[15px] font-semibold text-text">
                    {mandate.issuer.name}
                    <span className="mx-2 text-text-faint">→</span>
                    {mandate.subject.name}
                  </p>
                  <p className="text-[13px] text-text-muted">{mandate.subject.runtime}</p>
                </div>
                <div className="text-right">
                  <Mono>{mandate.id}</Mono>
                  <p className="mt-0.5 text-[12px] text-text-faint">
                    {shortDate(mandate.notBefore)} – {shortDate(mandate.expiresAt)}
                  </p>
                </div>
              </div>

              <AuthorityBar mandate={mandate} parent={parent} rootLimit={rootLimit} />

              <dl className="mt-4 grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2">
                <div>
                  <dt className="text-text-faint">May do</dt>
                  <dd className="mt-0.5 font-mono text-[12.5px] text-text">
                    {mandate.scope.actions.join(", ")}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-faint">May pay</dt>
                  <dd className="mt-0.5 text-text">{describeCounterparties(mandate.scope)}</dd>
                </div>
                <div>
                  <dt className="text-text-faint">Against</dt>
                  <dd className="mt-0.5 font-mono text-[12.5px] text-text">
                    {mandate.scope.audience.join(", ")}
                  </dd>
                </div>
                <div>
                  <dt className="text-text-faint">Periodic budget</dt>
                  <dd className="mt-0.5 text-text">
                    {mandate.scope.limits.perPeriod
                      ? `${formatMoney(mandate.scope.limits.perPeriod.amount)} per ${
                          mandate.scope.limits.perPeriod.days
                        } days`
                      : "none set"}
                  </dd>
                </div>
              </dl>

              {widened && (
                <ul className="mt-4 space-y-1.5 border-t border-fail/30 pt-3">
                  {violations.map((violation) => (
                    <li key={violation.code} className="text-[13px] text-fail">
                      {violation.message}
                      {violation.parentValue && violation.childValue && (
                        <span className="text-text-muted">
                          {" "}
                          — issuing mandate holds {violation.parentValue}, this one claims{" "}
                          {violation.childValue}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
