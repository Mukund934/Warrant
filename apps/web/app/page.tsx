import Link from "next/link";
import { AuthorityFlow } from "@/components/authority-flow";
import { Eyebrow, Label, Section } from "@/components/primitives";

const VOICES = [
  { who: "The finance head", said: "I approved a monthly limit — not this payment." },
  { who: "The software vendor", said: "Our system only carried out an instruction." },
  { who: "The bank", said: "We received a valid API call." },
  { who: "The auditor", said: "Show me proof of authorisation." },
];

const PARTS = [
  {
    name: "Mandates",
    line: "Signed permissions that can only narrow",
    detail:
      "A mandate records what a named legal person actually granted: which actions, which counterparties, which limits, until when. Pass it on and it may shrink, never grow. Every chain ends at a person who can be held answerable.",
  },
  {
    name: "The Gate",
    line: "A check before the action runs",
    detail:
      "Before a consequential action executes, the gate verifies the whole chain and answers allow, block or escalate. It signs its own answer, so the answer survives leaving the building.",
  },
  {
    name: "Evidence",
    line: "A record that holds up away from us",
    detail:
      "Mandates, decision and a hash-chained ledger segment, sealed as one artifact. A verifier recomputes the verdict from the evidence rather than reading it off the file.",
  },
];

export default function HomePage() {
  return (
    <>
      <Section className="pt-16 pb-14 sm:pt-24 sm:pb-20">
        <div className="max-w-3xl">
          <Eyebrow>Verifiable authority for AI agents</Eyebrow>
          <h1 className="text-[34px] font-semibold leading-[1.1] tracking-tight sm:text-[46px]">
            Proof of who authorised an AI action, under what limits, and who is accountable.
          </h1>
          <p className="mt-5 max-w-2xl text-[16px] leading-relaxed text-text-muted">
            AI agents have started to move money. When one of them gets it wrong, the only evidence
            most organisations can produce is a log file they are able to edit themselves. Warrant
            issues authority that can be checked by someone who trusts neither party.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/demo"
              className="rounded-md border border-seal/55 bg-seal/15 px-5 py-3 text-[14.5px] font-semibold text-seal transition-colors hover:bg-seal/20"
            >
              Open the demonstrator
            </Link>
            <Link
              href="/verify"
              className="rounded-md border border-line bg-surface px-5 py-3 text-[14.5px] font-medium text-text transition-colors hover:border-line-strong hover:bg-surface-raised"
            >
              Verify an evidence pack
            </Link>
          </div>
        </div>
      </Section>

      <Section className="pb-16">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,26rem)_1fr] lg:gap-14">
          <div>
            <h2 className="text-[22px] font-semibold leading-snug tracking-tight sm:text-[26px]">
              A ₹40 lakh payment goes wrong. Who approved it?
            </h2>
            <p className="mt-3 text-[14.5px] leading-relaxed text-text-muted">
              An AI assistant pays a supplier invoice. It turns out to be a duplicate, or a fraud.
              Four people are asked the same question and none of them can answer it with anything
              another party would accept.
            </p>
          </div>
          <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
            {VOICES.map((voice) => (
              <li key={voice.who} className="flex flex-col gap-1 px-5 py-3.5 sm:flex-row sm:gap-6">
                <span className="w-40 shrink-0 text-[13px] text-text-faint">{voice.who}</span>
                <span className="text-[14px] text-text">&ldquo;{voice.said}&rdquo;</span>
              </li>
            ))}
            <li className="bg-ink-raised px-5 py-3.5 text-[13.5px] text-text-muted">
              What arrives is a log file the company itself can edit. The people who must answer for
              the payment have the least ability to prove anything.
            </li>
          </ul>
        </div>
      </Section>

      <Section className="pb-16">
        <div className="mb-6 max-w-2xl">
          <Label>The shape of the answer</Label>
          <h2 className="mt-2 text-[22px] font-semibold tracking-tight sm:text-[26px]">
            Authority is issued, checked at the moment it is used, and left behind as evidence
          </h2>
        </div>
        <AuthorityFlow />
      </Section>

      <Section className="pb-16">
        <div className="grid gap-4 lg:grid-cols-3">
          {PARTS.map((part) => (
            <article key={part.name} className="rounded-lg border border-line bg-surface px-5 py-5">
              <h3 className="text-[16px] font-semibold text-text">{part.name}</h3>
              <p className="mt-1 text-[13px] text-seal">{part.line}</p>
              <p className="mt-3 text-[13.5px] leading-relaxed text-text-muted">{part.detail}</p>
            </article>
          ))}
        </div>
      </Section>

      <Section className="pb-20">
        <div className="rounded-lg border border-line bg-ink-raised px-6 py-7 sm:px-8">
          <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:items-center lg:gap-12">
            <div>
              <Label>Where this actually stands</Label>
              <p className="mt-2.5 max-w-2xl text-[15px] leading-relaxed text-text">
                Warrant is at validation stage: no customers, no revenue, no production deployment,
                and no interviews completed yet. What you can use here is a working technical
                demonstrator — real signatures, real verification, invented people and payments.
              </p>
              <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-text-muted">
                Other companies already solve parts of this. Google Cloud records the delegating
                human; Keycard ships multi-hop chains of authority; Nuggets ships a mandate, a gate
                and a proof. What remains unsolved is verification by an outside party and a chain
                that ends in someone legally answerable.
              </p>
            </div>
            <Link
              href="/status"
              className="shrink-0 self-start rounded-md border border-line bg-surface px-5 py-3 text-[14px] font-medium text-text transition-colors hover:border-line-strong lg:self-auto"
            >
              What is real and what is not
            </Link>
          </div>
        </div>
      </Section>
    </>
  );
}
