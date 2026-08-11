import Link from "next/link";
import { notFound } from "next/navigation";
import { describeCounterparties, formatMoney } from "@warrant/core";
import type { Check } from "@warrant/core";
import { demoScenarios } from "@warrant/core/fixtures";

export async function generateStaticParams() {
  return (await demoScenarios()).map((scenario) => ({ id: scenario.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scenario = (await demoScenarios()).find((item) => item.id === id);
  return { title: scenario ? `Evidence pack — ${scenario.title}` : "Evidence pack" };
}

const MARK: Record<Check["status"], string> = {
  pass: "Pass",
  fail: "Fail",
  warn: "Review",
  skip: "n/a",
};

function stamp(iso: string) {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  });
}

function Heading({ index, children }: { index: string; children: React.ReactNode }) {
  return (
    <h2 className="mb-3 flex items-baseline gap-3 border-b border-paper-line pb-1.5 text-[13px] font-semibold uppercase tracking-[0.11em] text-paper-text">
      <span className="text-paper-muted">{index}</span>
      {children}
    </h2>
  );
}

function Field({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-4 border-b border-paper-line/70 py-1.5 last:border-b-0">
      <dt className="w-44 shrink-0 text-[12.5px] text-paper-muted">{term}</dt>
      <dd className="min-w-0 flex-1 text-[13.5px] text-paper-text">{children}</dd>
    </div>
  );
}

export default async function EvidencePackPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scenario = (await demoScenarios()).find((item) => item.id === id);
  if (!scenario) notFound();

  const { pack } = scenario;
  const leaf = pack.authority.chain[pack.authority.chain.length - 1]!;

  return (
    <div className="mx-auto max-w-4xl px-5 py-10">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link href={`/demo/${scenario.id}`} className="text-[13.5px] text-text-muted hover:text-text">
          ← Back to the demonstrator
        </Link>
        <div className="flex flex-wrap gap-3">
          <Link
            href={`/verify?scenario=${scenario.id}`}
            className="rounded-md border border-seal/50 bg-seal/10 px-4 py-2 text-[13px] font-medium text-seal transition-colors hover:bg-seal/15"
          >
            Verify this pack
          </Link>
          <a
            href={`/api/evidence/${scenario.id}`}
            download={`${scenario.id}.json`}
            className="rounded-md border border-line bg-surface px-4 py-2 text-[13px] font-medium text-text-muted transition-colors hover:text-text"
          >
            Download JSON
          </a>
        </div>
      </div>

      <article className="rounded-lg bg-paper px-6 py-8 text-paper-text shadow-[0_1px_0_rgba(255,255,255,0.04)] sm:px-10 sm:py-11 print:rounded-none print:px-0">
        <header className="mb-8 border-b-2 border-paper-text/80 pb-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-paper-muted">
                Authority evidence pack
              </p>
              <h1 className="mt-1.5 text-[24px] font-semibold leading-tight">
                {pack.organisation.name}
              </h1>
              <p className="text-[13px] text-paper-muted">
                Registered in {pack.organisation.jurisdiction} · generated{" "}
                {stamp(pack.generatedAt)}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono text-[12px] text-paper-muted">{pack.packId}</p>
              <p className="mt-1 text-[11px] uppercase tracking-[0.14em] text-paper-muted">
                Format {pack.version}
              </p>
            </div>
          </div>
        </header>

        <section className="mb-8">
          <Heading index="1">What happened</Heading>
          <p className="mb-4 text-[15.5px] leading-relaxed">{pack.summary.headline}</p>
          <dl>
            <Field term="Authorised by">{pack.summary.authorisedBy}</Field>
            <Field term="Carried out by">{pack.summary.performedBy}</Field>
            <Field term="Decision">
              <span className="font-semibold">{pack.summary.verdict}</span> at{" "}
              {stamp(pack.summary.occurredAt)}
            </Field>
            <Field term="Reason recorded">{pack.decision.reason}</Field>
          </dl>
        </section>

        <section className="mb-8">
          <Heading index="2">Who is answerable</Heading>
          <dl>
            <Field term="Legal person">{pack.authority.liablePrincipal.name}</Field>
            <Field term="Role">{pack.authority.liablePrincipal.role}</Field>
            <Field term="Legal entity">{pack.authority.liablePrincipal.legalEntity}</Field>
            <Field term="Identifier">{pack.authority.liablePrincipal.identifier}</Field>
          </dl>
          <p className="mt-3 text-[12.5px] leading-relaxed text-paper-muted">
            Accountability is fixed at the root of the chain and is not reassigned by any delegation
            below it. The identifier above names a person, not an account.
          </p>
        </section>

        <section className="mb-8">
          <Heading index="3">The authority chain</Heading>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-paper-line text-left text-[11.5px] uppercase tracking-[0.09em] text-paper-muted">
                  <th className="py-2 pr-3 font-medium">Hop</th>
                  <th className="py-2 pr-3 font-medium">Granted by</th>
                  <th className="py-2 pr-3 font-medium">Granted to</th>
                  <th className="py-2 pr-3 font-medium">Per invoice</th>
                  <th className="py-2 font-medium">Valid until</th>
                </tr>
              </thead>
              <tbody>
                {pack.authority.chain.map((mandate, index) => (
                  <tr key={mandate.id} className="border-b border-paper-line/70 align-top">
                    <td className="py-2.5 pr-3 font-mono text-[12px] text-paper-muted">{index}</td>
                    <td className="py-2.5 pr-3">{mandate.issuer.name}</td>
                    <td className="py-2.5 pr-3">{mandate.subject.name}</td>
                    <td className="py-2.5 pr-3">
                      {mandate.scope.limits.perAction
                        ? formatMoney(mandate.scope.limits.perAction)
                        : "no limit"}
                    </td>
                    <td className="py-2.5">{mandate.expiresAt.slice(0, 10)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <dl className="mt-4">
            <Field term="Effective scope">
              {pack.authority.effectiveScope.actions.join(", ") || "nothing"} — the intersection of
              every hop above, not the leaf mandate alone
            </Field>
            <Field term="Permitted counterparties">
              {describeCounterparties(pack.authority.effectiveScope)}
            </Field>
            <Field term="Effective limit">
              {pack.authority.effectiveScope.limits.perAction
                ? formatMoney(pack.authority.effectiveScope.limits.perAction)
                : "no limit"}
            </Field>
          </dl>
        </section>

        <section className="mb-8">
          <Heading index="4">What was requested</Heading>
          <dl>
            <Field term="Description">{pack.request.description}</Field>
            <Field term="Amount">
              {pack.request.amount ? formatMoney(pack.request.amount) : "not applicable"}
            </Field>
            <Field term="Counterparty">{pack.request.counterparty}</Field>
            <Field term="Action">
              <span className="font-mono text-[12.5px]">{pack.request.action}</span>
            </Field>
            <Field term="Target system">
              <span className="font-mono text-[12.5px]">{pack.request.resource}</span>
            </Field>
            <Field term="Requesting agent">
              <span className="font-mono text-[12.5px]">{pack.request.actor}</span>
            </Field>
            <Field term="Request identifier">
              <span className="font-mono text-[12.5px]">{pack.request.id}</span>
            </Field>
          </dl>
        </section>

        <section className="mb-8">
          <Heading index="5">How the decision was reached</Heading>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-paper-line text-left text-[11.5px] uppercase tracking-[0.09em] text-paper-muted">
                  <th className="w-20 py-2 pr-3 font-medium">Result</th>
                  <th className="py-2 pr-3 font-medium">Check</th>
                  <th className="py-2 font-medium">Finding</th>
                </tr>
              </thead>
              <tbody>
                {pack.decision.checks.map((check, index) => (
                  <tr key={`${check.id}-${index}`} className="border-b border-paper-line/70 align-top">
                    <td
                      className={`py-2.5 pr-3 text-[12.5px] font-semibold ${
                        check.status === "fail"
                          ? "text-[#a2352f]"
                          : check.status === "warn"
                            ? "text-[#8a6112]"
                            : "text-paper-muted"
                      }`}
                    >
                      {MARK[check.status]}
                    </td>
                    <td className="py-2.5 pr-3">{check.title}</td>
                    <td className="py-2.5 text-paper-muted">
                      {check.detail}
                      {check.expected !== undefined && check.observed !== undefined && (
                        <span className="mt-1 block font-mono text-[11.5px]">
                          permitted {check.expected} · requested {check.observed}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mb-8">
          <Heading index="6">Integrity</Heading>
          <dl>
            <Field term="Pack fingerprint">
              <span className="font-mono text-[12px] break-all">{pack.integrity.packDigest}</span>
            </Field>
            <Field term="Pack signed by">
              <span className="font-mono text-[12px] break-all">
                {pack.integrity.proof.verificationMethod}
              </span>
            </Field>
            <Field term="Decision signed by">
              <span className="font-mono text-[12px] break-all">
                {pack.decision.proof.verificationMethod}
              </span>
            </Field>
            <Field term="Signature suite">
              ES256 over RFC 8785 canonical JSON, detached compact JWS
            </Field>
            <Field term="Ledger">
              {pack.ledger.head.entryCount} hash-chained entries, head at sequence{" "}
              {pack.ledger.head.seq}, signed {stamp(pack.ledger.head.signedAt)}
            </Field>
            <Field term="Revocation state">
              published {stamp(pack.revocation.asOf)};{" "}
              {pack.revocation.revoked.length === 0
                ? "no mandate in this chain was withdrawn"
                : `${pack.revocation.revoked.length} mandate withdrawn`}
            </Field>
          </dl>
        </section>

        <section className="mb-8">
          <Heading index="7">How to check this without trusting us</Heading>
          <p className="mb-3 text-[13.5px] leading-relaxed">
            This pack carries everything a verifier needs: the mandates, the signed decision, the
            ledger segment and the public keys. Verification recomputes the gate&rsquo;s verdict from
            the evidence rather than reading the verdict off the page.
          </p>
          <pre className="overflow-x-auto rounded border border-paper-line bg-white/60 px-4 py-3 font-mono text-[12px] leading-relaxed text-paper-text">
{`npm install
npm run build:core && npm run build:verifier
npm run export:packs

node packages/verifier/dist/cli.js \\
  evidence/${scenario.id}.json \\
  --trust-roots evidence/trust-roots.json`}
          </pre>
          <p className="mt-3 text-[12.5px] leading-relaxed text-paper-muted">
            Pass <span className="font-mono">--trust-roots</span> a key file you obtained from the
            organisation itself. Without it the verifier falls back to the keys inside the pack, which
            proves the pack is internally consistent but not that it came from anyone in particular.
          </p>
        </section>

        <section>
          <Heading index="8">Limits of this record</Heading>
          <ul className="space-y-2 text-[13px] leading-relaxed text-paper-muted">
            <li>
              Revocation is verified against the snapshot published at {stamp(pack.revocation.asOf)}.
              An offline verifier cannot know what happened after that moment.
            </li>
            <li>
              The ledger is hash-chained and its head is signed, which detects alteration by a third
              party. It is not anchored to an external transparency log, so it does not by itself
              prevent the issuing organisation from rewriting its own history from the first entry.
            </li>
            <li>
              This is a demonstration. {leaf.organisation.name}, its people, its agents and every
              payment shown are invented, and the signing keys are published in the project
              repository.
            </li>
          </ul>
        </section>

        <details className="mt-8 border-t border-paper-line pt-5 print:hidden">
          <summary className="cursor-pointer text-[13px] font-medium text-paper-text">
            Machine-readable pack
          </summary>
          <pre className="mt-3 max-h-[28rem] overflow-auto rounded border border-paper-line bg-white/60 px-4 py-3 font-mono text-[11px] leading-relaxed">
            {JSON.stringify(pack, null, 2)}
          </pre>
        </details>
      </article>
    </div>
  );
}
