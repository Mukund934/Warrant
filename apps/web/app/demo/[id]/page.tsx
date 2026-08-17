import Link from "next/link";
import { notFound } from "next/navigation";
import { formatMoney } from "@warrant/core";
import { demoScenarios } from "@warrant/core/fixtures";
import { ChainView, PrincipalCard } from "@/components/chain-view";
import { Eyebrow, Label, Mono, Note, Section } from "@/components/primitives";
import { ScenarioRail } from "@/components/scenario-rail";
import { CheckList, VerdictPanel } from "@/components/verdict";

export async function generateStaticParams() {
  return (await demoScenarios()).map((scenario) => ({ id: scenario.id }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scenario = (await demoScenarios()).find((item) => item.id === id);
  return { title: scenario ? scenario.title : "Demonstrator" };
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,13rem)_1fr] lg:gap-10">
      <div className="lg:sticky lg:top-24 lg:self-start">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[12px] text-seal">{String(number).padStart(2, "0")}</span>
          <h2 className="text-[15px] font-semibold text-text">{title}</h2>
        </div>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

export default async function ScenarioPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const scenarios = await demoScenarios();
  const scenario = scenarios.find((item) => item.id === id);
  if (!scenario) notFound();

  const { request, chain, decision, pack } = scenario;
  const root = chain[0]!;
  const leaf = chain[chain.length - 1]!;

  return (
    <Section className="py-10 sm:py-14">
      <header className="mb-8">
        <Eyebrow>Live demonstrator</Eyebrow>
        <h1 className="max-w-3xl text-[26px] font-semibold leading-tight tracking-tight sm:text-[32px]">
          {scenario.question}
        </h1>
        <p className="mt-3 max-w-2xl text-[14.5px] leading-relaxed text-text-muted">
          Everything below is computed now, in this request, from signed objects. Pick another
          scenario at any point — each one runs the same engine against different authority.
        </p>
      </header>

      <div className="mb-12">
        <ScenarioRail scenarios={scenarios} activeId={scenario.id} />
      </div>

      <div className="space-y-14">
        <Step number={1} title="Who granted the authority">
          <div className="space-y-4">
            <PrincipalCard mandate={root} />
            <ChainView chain={chain} />
          </div>
        </Step>

        <Step number={2} title="What the agent asked to do">
          <div className="rounded-lg border border-line bg-surface px-5 py-4">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <p className="text-[17px] font-semibold text-text">
                {request.amount ? formatMoney(request.amount) : "No amount"}
              </p>
              <Mono>{request.id}</Mono>
            </div>
            <p className="mt-1 text-[14px] text-text-muted">{request.description}</p>
            <dl className="mt-4 grid gap-x-6 gap-y-3 text-[13px] sm:grid-cols-2">
              <div>
                <dt className="text-text-faint">Requesting agent</dt>
                <dd className="mt-0.5 font-mono text-[12.5px] text-text">{request.actor}</dd>
              </div>
              <div>
                <dt className="text-text-faint">Action</dt>
                <dd className="mt-0.5 font-mono text-[12.5px] text-text">{request.action}</dd>
              </div>
              <div>
                <dt className="text-text-faint">Target system</dt>
                <dd className="mt-0.5 font-mono text-[12.5px] text-text">{request.resource}</dd>
              </div>
              <div>
                <dt className="text-text-faint">Counterparty</dt>
                <dd className="mt-0.5 text-text">{request.counterparty}</dd>
              </div>
            </dl>
            {request.actor !== leaf.subject.id && (
              <p className="mt-4 border-t border-line pt-3 text-[13px] text-warn">
                The agent presenting this mandate is not the agent it was issued to. The chain above
                is genuine; the holder is not.
              </p>
            )}
          </div>
        </Step>

        <Step number={3} title="What the gate decided">
          <div className="space-y-4">
            <VerdictPanel verdict={decision.verdict} reason={decision.reason} />
            <CheckList
              checks={decision.checks}
              caption="Every check the gate ran, in order, before the action could execute"
            />
            <Note>
              The gate signed this decision with its own key at{" "}
              <Mono>{decision.evaluatedAt}</Mono>. That signature is what lets someone outside this
              organisation rely on the verdict later, rather than taking our word for it.
            </Note>
          </div>
        </Step>

        <Step number={4} title="The evidence it produced">
          <div className="space-y-4">
            <div className="rounded-lg border border-line bg-surface px-5 py-4">
              <Label>Evidence pack</Label>
              <p className="mt-2 text-[15px] leading-relaxed text-text">{pack.summary.headline}</p>
              <dl className="mt-4 space-y-2 text-[13px]">
                <div className="flex flex-wrap gap-x-3">
                  <dt className="w-28 shrink-0 text-text-faint">Fingerprint</dt>
                  <dd>
                    <Mono>{pack.integrity.packDigest}</Mono>
                  </dd>
                </div>
                <div className="flex flex-wrap gap-x-3">
                  <dt className="w-28 shrink-0 text-text-faint">Ledger head</dt>
                  <dd>
                    <Mono>
                      sequence {pack.ledger.head.seq}, {pack.ledger.head.entryCount} entries
                    </Mono>
                  </dd>
                </div>
              </dl>
            </div>

            <div className="flex flex-wrap gap-3">
              <Link
                href={`/demo/${scenario.id}/evidence`}
                className="rounded-md border border-seal/50 bg-seal/10 px-4 py-2.5 text-[13.5px] font-medium text-seal transition-colors hover:bg-seal/15"
              >
                Read the evidence pack
              </Link>
              <Link
                href={`/verify?scenario=${scenario.id}`}
                className="rounded-md border border-line bg-surface px-4 py-2.5 text-[13.5px] font-medium text-text transition-colors hover:border-line-strong hover:bg-surface-raised"
              >
                Verify it independently
              </Link>
              <a
                href={`/api/evidence/${scenario.id}`}
                download={`${scenario.id}.json`}
                className="rounded-md border border-line bg-surface px-4 py-2.5 text-[13.5px] font-medium text-text-muted transition-colors hover:border-line-strong hover:text-text"
              >
                Download JSON
              </a>
            </div>
          </div>
        </Step>
      </div>

      <aside className="mt-14 rounded-lg border border-line bg-ink-raised px-5 py-4">
        <Label>What this scenario shows</Label>
        <p className="mt-2 max-w-3xl text-[14.5px] leading-relaxed text-text">{scenario.takeaway}</p>
        <p className="mt-3 max-w-3xl text-[13px] leading-relaxed text-text-faint">
          The signatures, the authority checks and the verification are real and reproducible. The
          organisation, its people, its agents and every payment shown are invented for this
          demonstration, and the signing keys are published in the repository.
        </p>
      </aside>
    </Section>
  );
}
