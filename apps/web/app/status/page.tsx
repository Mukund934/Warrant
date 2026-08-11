import Link from "next/link";
import { Eyebrow, Label, Mono, Note, Section } from "@/components/primitives";

export const metadata = { title: "Prototype status" };

const REAL = [
  "ES256 signatures on every mandate, request, decision, ledger head, revocation snapshot and pack",
  "RFC 8785 canonical serialisation, implemented and tested against the cases that break naive versions",
  "Scope narrowing as a partial order, enforced at issuance and re-checked at evaluation",
  "The gate's full check pipeline, running every check rather than stopping at the first failure",
  "Agents proving key possession by signing their own requests",
  "A hash-chained ledger with a signed head",
  "Offline verification that recomputes the verdict instead of reading it",
  "86 tests, including chain splicing, role confusion and an end-to-end forged pack",
];

const SIMULATED = [
  "Meridian Technologies Pvt Ltd, Priya Sharma, every agent, every supplier and every payment",
  "The eight scenarios, which are fixed fixtures with fixed timestamps so the demonstration is repeatable",
  "The prior-spend figure used for the periodic budget check",
  "The revocation snapshot, which is generated rather than served from a revocation service",
];

const NOT_BUILT = [
  "Any persistence — nothing is stored between requests",
  "Authentication, tenancy or access control of any kind",
  "Key rotation, key discovery, or a way to obtain another organisation's keys",
  "External anchoring of the ledger to a transparency log",
  "Adapters for MCP, SPIFFE, OAuth token exchange or any real agent runtime",
  "A signed human-approval artifact behind the ESCALATE verdict",
  "Checking the principal's own entitlements as a second axis",
];

const COMPETITORS = [
  {
    name: "Google Cloud",
    ships: "Records the delegating human alongside the agent, durably and exportably.",
    gap: "Only in the user-delegated flow, without the granted scope, in mutable logs, anchored to an email address.",
  },
  {
    name: "Keycard",
    ships: "Multi-hop chain of authority with per-hop narrowing, funded at US$38M.",
    gap: "A single vendor's product rather than a format anyone else can verify, with no liability semantics.",
  },
  {
    name: "Nuggets",
    ships: "A mandate, a gate and a cryptographic proof, including an open-source package.",
    gap: "No federation and no third-party evidence packaging.",
  },
  {
    name: "Okta, Microsoft, AWS",
    ships: "Agent identity, all generally available during 2026.",
    gap: "Identity is not authority. Each has also shipped a flow that acts for a user without creating a consent record.",
  },
];

const CORRECTIONS = [
  {
    claim: "“The relevant international standards work reached formal Proposed Standard status in June 2026.”",
    where: "Concept note §2, screening FAQ, pitch deck",
    finding:
      "Not supported. Checked against the IETF datatracker on 12 August 2026: draft-reece-wimse-cross-org-delegation is at revision 01, dated 30 July 2026, an individual submission with intended status Informational, and it states explicitly that it proposes no mechanism. draft-ietf-oauth-identity-chaining is at revision 17 with intended status Standards Track but is not yet an RFC. Neither is a Proposed Standard.",
    consequence:
      "The accurate version is the stronger one: the requirements are written down and the mechanism slot is still empty. That is a better argument for building now than a standard that had already settled.",
  },
  {
    claim: "“Tamper-proof records.”",
    where: "Concept note, executive summary",
    finding:
      "Hash chaining makes alteration detectable, not impossible. The pitch deck and the internal architecture notes already said tamper-evident; the concept note did not.",
    consequence: "This product says tamper-evident everywhere, and states what the ledger does not prevent.",
  },
  {
    claim: "“No vendor records who authorised an agent's action.”",
    where: "Earlier research, withdrawn 5 August 2026",
    finding:
      "False. Google Cloud does record it, with the full delegation chain preserved. The claim was struck by the research programme itself before this build began.",
    consequence:
      "The four things that remain unclaimed — outside verification, cryptographic non-repudiation, the granted scope, and a legally answerable person — are what this demonstrator implements.",
  },
];

function Column({
  title, tone, items,
}: {
  title: string;
  tone: "real" | "simulated" | "absent";
  items: string[];
}) {
  const styles = {
    real: "border-pass/40 bg-pass/[0.05]",
    simulated: "border-warn/40 bg-warn/[0.05]",
    absent: "border-line bg-surface",
  }[tone];
  const dot = { real: "bg-pass", simulated: "bg-warn", absent: "bg-text-faint" }[tone];

  return (
    <div className={`rounded-lg border px-5 py-4 ${styles}`}>
      <h3 className="text-[14.5px] font-semibold text-text">{title}</h3>
      <ul className="mt-3 space-y-2">
        {items.map((item) => (
          <li key={item} className="flex gap-2.5 text-[13px] leading-relaxed text-text-muted">
            <span aria-hidden className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function StatusPage() {
  return (
    <Section className="py-10 sm:py-14">
      <header className="mb-10 max-w-3xl">
        <Eyebrow>Prototype status</Eyebrow>
        <h1 className="text-[28px] font-semibold leading-tight tracking-tight sm:text-[34px]">
          What is real here, what is invented, and what does not exist
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-text-muted">
          This page exists because the most common failure of a demonstration is that a reviewer
          cannot tell which parts are load-bearing. Everything below is stated so that a sceptical
          reader does not have to work it out by poking at the interface.
        </p>
      </header>

      <div className="space-y-14">
        <section className="grid gap-4 lg:grid-cols-3">
          <Column title="Genuinely working" tone="real" items={REAL} />
          <Column title="Invented for the demonstration" tone="simulated" items={SIMULATED} />
          <Column title="Not built at all" tone="absent" items={NOT_BUILT} />
        </section>

        <section>
          <Note tone="caution">
            <strong className="font-medium text-text">The signing keys are published.</strong> The
            demonstration keypairs, private halves included, are committed to the repository at{" "}
            <Mono>packages/core/src/fixtures/keys.ts</Mono>. Anyone can issue a mandate that this
            deployment will accept. That is deliberate — it lets you reproduce every result — and it
            is exactly why a real deployment keeps signing keys in hardware. Nothing here should be
            treated as a trustworthy trust root.
          </Note>
        </section>

        <section>
          <h2 className="mb-4 text-[19px] font-semibold tracking-tight">Where the venture stands</h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[
              { figure: "Validation", caption: "stage — not build, not revenue" },
              { figure: "0", caption: "customer interviews completed" },
              { figure: "0", caption: "design partners, pilots or paying users" },
              { figure: "0", caption: "external audits, certifications or approvals" },
            ].map((item) => (
              <div key={item.caption} className="rounded-lg border border-line bg-surface px-5 py-4">
                <p className="text-[24px] font-semibold tracking-tight text-text">{item.figure}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-text-muted">{item.caption}</p>
              </div>
            ))}
          </div>
          <p className="mt-4 max-w-3xl text-[14px] leading-relaxed text-text-muted">
            The research behind Warrant is a nine-phase programme with a written venture decision,
            regulatory analysis checked against primary legal texts, and a validation plan containing
            explicit criteria for abandoning the idea. What it does not contain is a single
            conversation with a buyer. That was a deliberate sequence — the reasoning was that
            building first creates attachment and makes a flawed thesis harder to kill — and it means
            the central commercial assumption is still untested.
          </p>
          <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-text-muted">
            The assumption is this: that an auditor or an insurer would{" "}
            <span className="text-text">require</span> an artifact like the one on this site, rather
            than merely accept it. If nobody will require it, there is no forcing function, and the
            written kill criterion for that sits at around month nine.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-[19px] font-semibold tracking-tight">Who else is already here</h2>
          <p className="mb-4 max-w-3xl text-[14px] leading-relaxed text-text-muted">
            The research programme tested the claim that nobody does this, and rejected it. Naming
            what others ship is how the remaining gap stays narrow enough to be defensible.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {COMPETITORS.map((competitor) => (
              <div key={competitor.name} className="rounded-lg border border-line bg-surface px-5 py-4">
                <h3 className="text-[14.5px] font-semibold text-text">{competitor.name}</h3>
                <p className="mt-2 text-[13px] leading-relaxed text-text-muted">
                  <span className="text-text-faint">Ships:</span> {competitor.ships}
                </p>
                <p className="mt-1.5 text-[13px] leading-relaxed text-text-muted">
                  <span className="text-text-faint">Does not solve:</span> {competitor.gap}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-4 max-w-3xl text-[14px] leading-relaxed text-text-muted">
            What is left is the combination of cross-organisational verification, evidence integrity
            and a chain that ends in someone legally answerable. The argument for why an incumbent
            cannot simply add it is structural: evidence that one company relies on about another
            cannot credibly be issued by a party with an interest in the outcome. That argument has
            never been tested on a buyer, which makes it a hypothesis rather than a moat.
          </p>
        </section>

        <section>
          <h2 className="mb-2 text-[19px] font-semibold tracking-tight">
            Claims checked, and three that did not survive
          </h2>
          <p className="mb-4 max-w-3xl text-[14px] leading-relaxed text-text-muted">
            Two of these were withdrawn by the research programme before this was built. The first was
            found while building this page, by checking the submission&rsquo;s own citation.
          </p>
          <div className="space-y-3">
            {CORRECTIONS.map((correction) => (
              <div key={correction.claim} className="rounded-lg border border-line bg-surface px-5 py-4">
                <p className="text-[14px] font-medium leading-relaxed text-text">{correction.claim}</p>
                <Label>{correction.where}</Label>
                <p className="mt-2.5 text-[13.5px] leading-relaxed text-text-muted">
                  <span className="text-fail">Finding.</span> {correction.finding}
                </p>
                <p className="mt-2 text-[13.5px] leading-relaxed text-text-muted">
                  <span className="text-pass">What replaced it.</span> {correction.consequence}
                </p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <div className="rounded-lg border border-line bg-ink-raised px-6 py-6">
            <Label>The short version</Label>
            <p className="mt-2.5 max-w-3xl text-[15px] leading-relaxed text-text">
              The engineering on this site works and can be checked line by line. The business thesis
              behind it has not been validated by anyone outside the research. Those are two separate
              claims and only the first one is demonstrated here.
            </p>
            <div className="mt-5 flex flex-wrap gap-3">
              <Link
                href="/technical"
                className="rounded-md border border-line bg-surface px-4 py-2.5 text-[13.5px] font-medium text-text transition-colors hover:border-line-strong"
              >
                Technical notes
              </Link>
              <Link
                href="/verify"
                className="rounded-md border border-seal/50 bg-seal/10 px-4 py-2.5 text-[13.5px] font-medium text-seal transition-colors hover:bg-seal/15"
              >
                Check the evidence yourself
              </Link>
            </div>
          </div>
        </section>
      </div>
    </Section>
  );
}
