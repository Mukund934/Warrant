import Link from "next/link";
import { describeCounterparties, formatMoney } from "@warrant/core";
import { demoScenario } from "@warrant/core/fixtures";
import { DefinitionRow, Eyebrow, Label, Mono, Note, Section } from "@/components/primitives";

export const metadata = { title: "How it works" };

const NOT_DOING = [
  {
    title: "No invented cryptography",
    detail:
      "ECDSA on P-256, SHA-256, JSON Web Signatures and RFC 8785 canonical JSON. All published, all widely implemented. The claim is about what gets recorded and who can check it, not about the mathematics.",
  },
  {
    title: "No model decides anything",
    detail:
      "No language model takes part in issuing a mandate, evaluating the gate or verifying evidence. Those are deterministic and reproducible, which is the only reason the evidence is worth anything.",
  },
  {
    title: "No blockchain",
    detail:
      "The ledger is a hash chain with a signed head. Detecting alteration does not require consensus, and pretending otherwise would add cost without adding proof.",
  },
  {
    title: "No claim about why the agent acted",
    detail:
      "Warrant records authority and actions, both of which are provable. It does not record or attest to the agent's reasoning, because nobody can currently verify that a stated reason is the real one.",
  },
];

export default async function HowItWorksPage() {
  const scenario = (await demoScenario("authorised-payment"))!;
  const root = scenario.chain[0]!;
  const leaf = scenario.chain[scenario.chain.length - 1]!;

  return (
    <Section className="py-10 sm:py-14" width="wide">
      <header className="mb-12 max-w-3xl">
        <Eyebrow>How it works</Eyebrow>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">
          Three objects, one rule, and a check that anybody can run
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-text-muted">
          Everything on this page is taken from a real mandate the demonstrator issued and a real
          decision the gate signed. Nothing here is a mockup of what the format might look like.
        </p>
      </header>

      <div className="space-y-16">
        <section className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-12">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <h2 className="text-[20px] font-semibold tracking-tight">1. The mandate</h2>
            <p className="mt-2 text-[14px] leading-relaxed text-text-muted">
              A record of what a named legal person actually granted. Not a permission flag, and not
              a session token — a statement with limits, an expiry and an author.
            </p>
          </div>
          <div className="min-w-0 space-y-4">
            <div className="rounded-lg border border-line bg-surface px-5 py-4">
              <p className="text-[15.5px] leading-relaxed text-text">
                {root.liablePrincipal.name}, {root.liablePrincipal.role} at{" "}
                {root.liablePrincipal.legalEntity}, authorises {root.subject.name} to{" "}
                {root.scope.actions.join(", ")} up to{" "}
                {formatMoney(root.scope.limits.perAction!)} per invoice for{" "}
                {describeCounterparties(root.scope)}, until{" "}
                {root.expiresAt.slice(0, 10)}.
              </p>
              <p className="mt-2 text-[13px] text-text-faint">
                That sentence is not a caption. It is a reading of the signed object below.
              </p>
            </div>

            <dl className="rounded-lg border border-line bg-surface px-5 py-2">
              <DefinitionRow term="liablePrincipal">
                The person answerable if this goes wrong — {root.liablePrincipal.name}, identified as{" "}
                {root.liablePrincipal.identifier}. An email address is not a legal person; this field
                exists because someone has to be.
              </DefinitionRow>
              <DefinitionRow term="issuer / subject">
                Who granted it and who received it. At the root the issuer is a human. At every hop
                below, the issuer is the agent that held the mandate above.
              </DefinitionRow>
              <DefinitionRow term="scope.actions">
                <Mono>{root.scope.actions.join(", ")}</Mono> — the only verbs this authority covers.
              </DefinitionRow>
              <DefinitionRow term="scope.counterparties">
                {describeCounterparties(root.scope)}. Limits are not only about money; a mandate names
                who may be paid.
              </DefinitionRow>
              <DefinitionRow term="scope.limits">
                {formatMoney(root.scope.limits.perAction!)} per invoice and{" "}
                {formatMoney(root.scope.limits.perPeriod!.amount)} across{" "}
                {root.scope.limits.perPeriod!.days} days.
              </DefinitionRow>
              <DefinitionRow term="notBefore / expiresAt">
                {root.notBefore.slice(0, 10)} to {root.expiresAt.slice(0, 10)}. Authority that never
                lapses is not authority, it is a standing arrangement nobody reviews.
              </DefinitionRow>
              <DefinitionRow term="parent / depth">
                Where this mandate sits in the chain. The root has no parent; each hop names the exact
                mandate above it by digest, so a mandate cannot be moved onto a different parent.
              </DefinitionRow>
              <DefinitionRow term="proof">
                A detached ES256 signature over the canonical form of every field above. Change any
                character and it stops verifying.
              </DefinitionRow>
            </dl>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-12">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <h2 className="text-[20px] font-semibold tracking-tight">2. The one rule</h2>
            <p className="mt-2 text-[14px] leading-relaxed text-text-muted">
              Authority may narrow when it is passed on. It may never widen. Everything else in the
              system follows from holding that line.
            </p>
          </div>
          <div className="min-w-0 space-y-4">
            <div className="rounded-lg border border-line bg-surface px-5 py-4">
              <Label>What narrowing means, field by field</Label>
              <ul className="mt-3 space-y-2 text-[13.5px] leading-relaxed text-text-muted">
                <li>
                  <span className="text-text">Actions</span> — the child&rsquo;s set must be contained
                  in the parent&rsquo;s.
                </li>
                <li>
                  <span className="text-text">Counterparties</span> — the child&rsquo;s list must be
                  contained in the parent&rsquo;s. A restricted list can never become &ldquo;anyone&rdquo;.
                </li>
                <li>
                  <span className="text-text">Money</span> — the per-action ceiling may only go down,
                  and a periodic budget may not permit a higher rate of spend than the one above it.
                </li>
                <li>
                  <span className="text-text">Time</span> — the child&rsquo;s validity window must sit
                  inside the parent&rsquo;s. A delegation cannot outlive its source.
                </li>
                <li>
                  <span className="text-text">Depth</span> — the root decides how many hops are
                  allowed, and no descendant can raise it.
                </li>
              </ul>
            </div>

            <Note tone="caution">
              <strong className="font-medium text-text">The trap this avoids.</strong> If a delegation
              leaves a field out, it inherits the parent&rsquo;s value. It never becomes unlimited.
              &ldquo;Unspecified&rdquo; meaning &ldquo;unrestricted&rdquo; is how permission systems
              quietly widen, and it is written into the tests as a case that must fail.
            </Note>

            <div className="rounded-lg border border-line bg-surface px-5 py-4">
              <Label>And the effective scope is computed, not trusted</Label>
              <p className="mt-2.5 text-[13.5px] leading-relaxed text-text-muted">
                The gate does not evaluate against the last mandate. It intersects every scope in the
                chain and evaluates against that. So even a chain containing a mandate that widens —
                because someone bypassed issuance and signed it directly — is still held to the
                narrowest value anywhere above it, while the widening itself is reported as a failure.
              </p>
              <p className="mt-3 text-[13.5px] text-text">
                In this chain the effective per-invoice ceiling is{" "}
                {formatMoney(scenario.decision.effectiveScope.limits.perAction!)}, and the effective
                action set is <Mono>{scenario.decision.effectiveScope.actions.join(", ")}</Mono>.
              </p>
              <Link
                href="/demo/delegation-escalation"
                className="mt-3 inline-block text-[13.5px] text-seal hover:underline"
              >
                See a chain that tries to widen →
              </Link>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-12">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <h2 className="text-[20px] font-semibold tracking-tight">3. The gate</h2>
            <p className="mt-2 text-[14px] leading-relaxed text-text-muted">
              Before a consequential action runs, every one of these is checked. The gate then signs
              its own answer.
            </p>
          </div>
          <div className="min-w-0 space-y-4">
            <ol className="overflow-hidden rounded-lg border border-line bg-surface">
              {scenario.decision.checks.map((check, index) => (
                <li
                  key={check.id}
                  className="flex gap-4 border-b border-line px-5 py-3 last:border-b-0"
                >
                  <span className="w-6 shrink-0 font-mono text-[12px] text-text-faint">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div>
                    <p className="text-[13.5px] text-text">{check.title}</p>
                    <Mono className="text-text-faint">{check.id}</Mono>
                  </div>
                </li>
              ))}
            </ol>
            <p className="text-[13.5px] leading-relaxed text-text-muted">
              All of them run, every time. The gate does not stop at the first failure, because an
              auditor asking &ldquo;what else was wrong with this?&rdquo; deserves a complete answer
              rather than the first thing that tripped.
            </p>
            <div className="rounded-lg border border-line bg-surface px-5 py-4">
              <Label>Three answers, not two</Label>
              <p className="mt-2.5 text-[13.5px] leading-relaxed text-text-muted">
                <span className="text-pass">ALLOW</span> and{" "}
                <span className="text-fail">BLOCK</span> are the obvious ones.{" "}
                <span className="text-warn">ESCALATE</span> exists because authority and autonomy are
                separate settings: {leaf.liablePrincipal.name} can delegate the power to pay and still
                keep the last word above a threshold she chooses.
              </p>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-12">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <h2 className="text-[20px] font-semibold tracking-tight">4. The evidence</h2>
            <p className="mt-2 text-[14px] leading-relaxed text-text-muted">
              A single artifact carrying everything needed to re-answer the question later, without
              access to the systems that produced it.
            </p>
          </div>
          <div className="min-w-0 space-y-4">
            <dl className="rounded-lg border border-line bg-surface px-5 py-2">
              <DefinitionRow term="The chain">
                Every mandate from the legal person down to the acting agent, each with its signature
                intact.
              </DefinitionRow>
              <DefinitionRow term="The request">
                What was asked for, signed by the agent that asked, so the request cannot be edited
                and re-attributed.
              </DefinitionRow>
              <DefinitionRow term="The decision">
                The verdict, the reason, and every check with its result — signed by the gate.
              </DefinitionRow>
              <DefinitionRow term="The ledger segment">
                Hash-chained entries with a signed head, so removing or reordering a record is
                detectable.
              </DefinitionRow>
              <DefinitionRow term="The revocation snapshot">
                What had been withdrawn as of a stated moment, signed, with that moment on the record
                so its staleness is visible.
              </DefinitionRow>
              <DefinitionRow term="The keys">
                Public keys for convenience — with a warning attached, because keys that travel with
                the evidence prove consistency and nothing more.
              </DefinitionRow>
            </dl>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-12">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <h2 className="text-[20px] font-semibold tracking-tight">5. The hard part</h2>
            <p className="mt-2 text-[14px] leading-relaxed text-text-muted">
              Not the gate. Verification by somebody who has no reason to trust you.
            </p>
          </div>
          <div className="min-w-0 space-y-4">
            <p className="text-[14.5px] leading-relaxed text-text-muted">
              Several companies already ship a gate. Chains of authority across multiple hops are
              shipped too. What is not solved is the moment after the incident, when a second
              organisation — an auditor, an insurer, the counterparty who lost the money — has to
              decide whether your record of events means anything.
            </p>
            <p className="text-[14.5px] leading-relaxed text-text-muted">
              A record held inside the system that produced it cannot answer that. Neither can a
              vendor attesting to its own customers, because it has an interest in the answer. So the
              verifier here does something deliberately unhelpful to us: it recomputes the
              gate&rsquo;s entire evaluation from the evidence, reaches its own verdict, and compares.
              If our recorded answer and its recomputed answer differ, the pack is rejected — and we
              have no way to be in the room when that happens.
            </p>
            <Note>
              Whether an auditor or an insurer will actually rely on an artifact like this is the
              open question the whole idea rests on, and it has not been tested with a single real
              buyer yet.{" "}
              <Link href="/status" className="text-seal hover:underline">
                That is stated plainly on the project status page.
              </Link>
            </Note>
            <Link
              href="/verify"
              className="inline-block rounded-md border border-seal/55 bg-seal/15 px-5 py-3 text-[14px] font-semibold text-seal transition-colors hover:bg-seal/20"
            >
              Run the verifier yourself
            </Link>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[minmax(0,20rem)_1fr] lg:gap-12">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <h2 className="text-[20px] font-semibold tracking-tight">What it deliberately is not</h2>
          </div>
          <div className="grid min-w-0 gap-3 sm:grid-cols-2">
            {NOT_DOING.map((item) => (
              <div key={item.title} className="rounded-lg border border-line bg-surface px-5 py-4">
                <h3 className="text-[14px] font-semibold text-text">{item.title}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-text-muted">{item.detail}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </Section>
  );
}
